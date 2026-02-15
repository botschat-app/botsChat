import React, { useRef, useEffect, useState, useMemo, useCallback } from "react";
import { useAppState, useAppDispatch, type ChatMessage } from "../store";
import type { WSMessage } from "../ws";
import { MessageContent } from "./MessageContent";
import { ModelSelect } from "./ModelSelect";
import { SessionTabs } from "./SessionTabs";
import { useIsMobile } from "../hooks/useIsMobile";
import { dlog } from "../debug-log";
import { randomUUID } from "../utils/uuid";

type ChatWindowProps = {
  sendMessage: (msg: WSMessage) => void;
};

/** Simple string hash for action prompt keys (matches MessageContent) */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

// ---------------------------------------------------------------------------
// Skill definitions & frequency tracking (v2 – recency-aware, daily buckets)
// ---------------------------------------------------------------------------
// Storage: localStorage (per-origin). Data persists across page reloads but
// lives separately per origin (localhost:8787 vs localhost:3000). The v2 format
// stores daily usage buckets so we can weight recent activity higher.
// ---------------------------------------------------------------------------

type Skill = { cmd: string; label: string; icon: string };

/** Default skills — shown even before any usage */
const DEFAULT_SKILLS: Skill[] = [
  { cmd: "/help",      label: "Help",      icon: "?" },
  { cmd: "/status",    label: "Status",    icon: "i" },
  { cmd: "/model",     label: "Model",     icon: "M" },
  { cmd: "/clear",     label: "Clear",     icon: "C" },
  { cmd: "/think",     label: "Think",     icon: "T" },
  { cmd: "/image",     label: "Image",     icon: "I" },
  { cmd: "/search",    label: "Search",    icon: "S" },
  { cmd: "/summarize", label: "Summarize", icon: "Σ" },
  { cmd: "/translate", label: "Translate", icon: "翻" },
  { cmd: "/reset",     label: "Reset",     icon: "R" },
];

// --- v2 storage types ---
type SkillEntry = { total: number; daily: Record<string, number> };
type SkillStore = Record<string, SkillEntry>;

const STORE_KEY = "botschat_skill_freq_v2";
const V1_KEY = "botschat_skill_freq";
const RECENCY_DAYS = 2;   // window for "recent" weighting
const PRUNE_DAYS = 14;    // drop daily buckets older than this

function dateKey(d = new Date()): string {
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/** Prune daily buckets older than PRUNE_DAYS in-place. */
function pruneStore(store: SkillStore) {
  const cutoff = Date.now() - PRUNE_DAYS * 86_400_000;
  for (const entry of Object.values(store)) {
    for (const ds of Object.keys(entry.daily)) {
      if (new Date(ds).getTime() < cutoff) delete entry.daily[ds];
    }
  }
}

/** Load skill frequency store, migrating from v1 if needed. */
function loadSkillStore(): SkillStore {
  try {
    // Try v2 first
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const store: SkillStore = JSON.parse(raw);
      pruneStore(store);
      return store;
    }
    // Auto-migrate from v1 (plain Record<string, number>)
    const v1 = localStorage.getItem(V1_KEY);
    if (v1) {
      const old: Record<string, number> = JSON.parse(v1);
      const today = dateKey();
      const store: SkillStore = {};
      for (const [cmd, count] of Object.entries(old)) {
        store[cmd] = { total: count, daily: { [today]: count } };
      }
      saveSkillStore(store);
      localStorage.removeItem(V1_KEY);
      return store;
    }
    return {};
  } catch { return {}; }
}

function saveSkillStore(store: SkillStore) {
  pruneStore(store);
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

/** Detect and record a /command from the message text. Returns the command if found. */
function recordSkillUsage(text: string): string | null {
  const match = text.match(/^\/(\S+)/);
  if (!match) return null;
  const cmd = `/${match[1]}`;
  const store = loadSkillStore();
  const today = dateKey();
  if (!store[cmd]) store[cmd] = { total: 0, daily: {} };
  store[cmd].total += 1;
  store[cmd].daily[today] = (store[cmd].daily[today] ?? 0) + 1;
  saveSkillStore(store);
  return cmd;
}

/** Count usages within the last RECENCY_DAYS. */
function recentCount(entry: SkillEntry): number {
  const cutoff = Date.now() - RECENCY_DAYS * 86_400_000;
  let sum = 0;
  for (const [ds, cnt] of Object.entries(entry.daily)) {
    if (new Date(ds).getTime() >= cutoff) sum += cnt;
  }
  return sum;
}

/** Composite score: recent usage * 5 + all-time total. */
function skillScore(entry: SkillEntry): number {
  return recentCount(entry) * 5 + entry.total;
}

/**
 * Return default skills + user-typed custom skills, sorted by a composite
 * recency score (skills used more in the last 2 days float to the front).
 */
function getSortedSkills(): { skills: Skill[]; store: SkillStore } {
  const store = loadSkillStore();
  const defaultCmds = new Set(DEFAULT_SKILLS.map((s) => s.cmd));
  // Build entries for user-typed skills that aren't in the default list
  const customSkills: Skill[] = Object.keys(store)
    .filter((cmd) => !defaultCmds.has(cmd) && cmd.startsWith("/"))
    .map((cmd) => ({
      cmd,
      label: cmd.slice(1).charAt(0).toUpperCase() + cmd.slice(2),
      icon: cmd.slice(1).charAt(0).toUpperCase(),
    }));
  const skills = [...DEFAULT_SKILLS, ...customSkills].sort((a, b) => {
    const sa = store[a.cmd] ? skillScore(store[a.cmd]) : 0;
    const sb = store[b.cmd] ? skillScore(store[b.cmd]) : 0;
    return sb - sa;
  });
  return { skills, store };
}

/** Flat-row message display + composer, per design guideline section 5.2/5.6 */
export function ChatWindow({ sendMessage }: ChatWindowProps) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const isMobile = useIsMobile();
  const [input, setInput] = useState("");
  const [skillVersion, setSkillVersion] = useState(0); // bump to re-sort skills
  const [pendingImage, setPendingImage] = useState<{ file: File; preview: string } | null>(null);
  const [imageUploading, setImageUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [quotedMessage, setQuotedMessage] = useState<ChatMessage | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const sessionKey = state.selectedSessionKey;

  const { skills: sortedSkills, store: skillStore } = useMemo(
    () => getSortedSkills(),
    [skillVersion],
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.messages]);

  // Auto-resize textarea
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
      inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 160) + "px";
    }
  }, [input]);

  // Auto-focus the input when a session is active (page load or channel switch).
  // On mobile, skip auto-focus to avoid popping up the keyboard unexpectedly
  // every time the user switches sessions, taps a message, or navigates.
  useEffect(() => {
    if (isMobile) return;
    if (sessionKey && inputRef.current) {
      // Small delay to ensure DOM is ready after render
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [sessionKey, isMobile]);

  // Restore per-session model from localStorage when session changes
  useEffect(() => {
    if (!sessionKey) return;
    try {
      const stored = JSON.parse(localStorage.getItem("botschat:sessionModels") || "{}");
      const saved = stored[sessionKey];
      if (saved && saved !== state.sessionModel) {
        dispatch({ type: "SET_SESSION_MODEL", model: saved });
      } else if (!saved && state.sessionModel) {
        // New session with no override — clear sessionModel so defaultModel shows
        dispatch({ type: "SET_SESSION_MODEL", model: null });
      }
    } catch { /* ignore */ }
  }, [sessionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const currentModel = state.sessionModel ?? state.defaultModel;

  const handleModelChange = useCallback((modelId: string) => {
    if (!modelId || !sessionKey || modelId === currentModel) return;

    dlog.info("Chat", `Model change: ${currentModel ?? "none"} → ${modelId}`);

    // Optimistically update the dropdown immediately
    dispatch({ type: "SET_SESSION_MODEL", model: modelId });

    // Persist per-session model to localStorage
    try {
      const stored = JSON.parse(localStorage.getItem("botschat:sessionModels") || "{}");
      stored[sessionKey] = modelId;
      localStorage.setItem("botschat:sessionModels", JSON.stringify(stored));
    } catch { /* ignore */ }

    recordSkillUsage("/model");
    setSkillVersion((v) => v + 1);

    const msg: ChatMessage = {
      id: randomUUID(),
      sender: "user",
      text: `/model ${modelId}`,
      timestamp: Date.now(),
    };
    dispatch({ type: "ADD_MESSAGE", message: msg });
    sendMessage({
      type: "user.message",
      sessionKey,
      text: `/model ${modelId}`,
      userId: state.user?.id ?? "",
      messageId: msg.id,
    });

    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  }, [sessionKey, currentModel, state.user?.id, sendMessage, dispatch]);

  const handleSkillClick = useCallback((cmd: string) => {
    dlog.info("Skill", `Skill button clicked: ${cmd}`);
    setInput((prev) => {
      // If input already starts with this command, don't duplicate
      if (prev.startsWith(cmd + " ") || prev === cmd) return prev;
      return cmd + " ";
    });
    inputRef.current?.focus();
  }, []);

  // Image upload helpers
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    const preview = URL.createObjectURL(file);
    setPendingImage({ file, preview });
    e.target.value = "";
    inputRef.current?.focus();
  }, []);

  const clearPendingImage = useCallback(() => {
    if (pendingImage) {
      URL.revokeObjectURL(pendingImage.preview);
      setPendingImage(null);
    }
  }, [pendingImage]);

  const uploadImage = useCallback(async (file: File): Promise<string | null> => {
    const formData = new FormData();
    formData.append("file", file);
    const token = localStorage.getItem("botschat_token");
    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Upload failed" }));
        throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as { url: string };
      // Return absolute URL so OpenClaw on mini.local can fetch the image
      const absoluteUrl = data.url.startsWith("/")
        ? `${window.location.origin}${data.url}`
        : data.url;
      return absoluteUrl;
    } catch (err) {
      dlog.error("Upload", `Image upload failed: ${err}`);
      return null;
    }
  }, []);

  // Drag & drop handlers
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("Files")) {
      setDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = dropZoneRef.current?.getBoundingClientRect();
    if (rect) {
      const { clientX, clientY } = e;
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
        setDragOver(false);
      }
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith("image/")) {
      const preview = URL.createObjectURL(file);
      setPendingImage({ file, preview });
      inputRef.current?.focus();
    }
  }, []);

  // Paste handler for images
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) {
          const preview = URL.createObjectURL(file);
          setPendingImage({ file, preview });
        }
        return;
      }
    }
  }, []);

  const handleSend = async () => {
    if ((!input.trim() && !pendingImage) || !sessionKey) return;

    // Prepend quoted message as Markdown blockquote
    const rawTrimmed = input.trim();
    const trimmed = quotedMessage
      ? `> ${quotedMessage.text.split("\n").slice(0, 3).join("\n> ")}\n\n${rawTrimmed}`
      : rawTrimmed;
    setQuotedMessage(null);
    const hasText = trimmed.length > 0;
    const isSkill = hasText && trimmed.startsWith("/");
    dlog.info("Chat", `Send message${isSkill ? " (skill)" : ""}${pendingImage ? " +image" : ""}: ${trimmed.length > 120 ? trimmed.slice(0, 120) + "…" : trimmed}`, { sessionKey, isSkill });

    if (hasText) {
      recordSkillUsage(trimmed);
      setSkillVersion((v) => v + 1);
    }

    // Upload image if present
    let mediaUrl: string | undefined;
    if (pendingImage) {
      setImageUploading(true);
      const url = await uploadImage(pendingImage.file);
      setImageUploading(false);
      if (!url) return; // Upload failed
      mediaUrl = url;
      clearPendingImage();
    }

    const msg: ChatMessage = {
      id: randomUUID(),
      sender: "user",
      text: trimmed,
      timestamp: Date.now(),
      mediaUrl,
    };

    dispatch({ type: "ADD_MESSAGE", message: msg });

    sendMessage({
      type: "user.message",
      sessionKey,
      text: trimmed,
      userId: state.user?.id ?? "",
      messageId: msg.id,
      ...(mediaUrl ? { mediaUrl } : {}),
    });

    setInput("");

    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  };

  const openThread = (messageId: string) => {
    dlog.info("Thread", `Open thread for message: ${messageId}`);
    dispatch({ type: "OPEN_THREAD", threadId: messageId, messages: [] });
  };

  const handleQuote = useCallback((msg: ChatMessage) => {
    setQuotedMessage(msg);
    if (!isMobile) inputRef.current?.focus();
  }, [isMobile]);

  const handleCopy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for older browsers / restricted contexts
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  }, []);

  /** Handle A2UI action button clicks — sends the action text as a user message */
  const handleA2UIAction = useCallback((action: string) => {
    if (!sessionKey) return;
    dlog.info("A2UI", `Action triggered: ${action}`);
    const msg: ChatMessage = {
      id: randomUUID(),
      sender: "user",
      text: action,
      timestamp: Date.now(),
    };
    dispatch({ type: "ADD_MESSAGE", message: msg });
    sendMessage({
      type: "user.message",
      sessionKey,
      text: action,
      userId: state.user?.id ?? "",
      messageId: msg.id,
    });
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  }, [sessionKey, state.user?.id, sendMessage, dispatch]);

  /** Handle ActionCard resolve — marks widget done + sends the choice as user message */
  const handleResolveAction = useCallback((messageId: string, value: string, label: string) => {
    if (!sessionKey) return;
    dlog.info("ActionCard", `Resolved: "${label}" (value="${value}")`);

    // Compute a simple hash from value+label for the prompt key
    const promptHash = simpleHash(label + value);

    // Mark the action as resolved in the store
    dispatch({ type: "RESOLVE_ACTION", messageId, promptHash, value, label });

    // Send the chosen label as a user message (show the readable label, not the
    // technical value, so the chat history reads naturally)
    const msg: ChatMessage = {
      id: randomUUID(),
      sender: "user",
      text: label,
      timestamp: Date.now(),
    };
    dispatch({ type: "ADD_MESSAGE", message: msg });
    sendMessage({
      type: "user.message",
      sessionKey,
      text: label,
      userId: state.user?.id ?? "",
      messageId: msg.id,
    });
    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  }, [sessionKey, state.user?.id, sendMessage, dispatch]);

  /** Stop the current streaming response — sends /stop as a user message */
  const handleStop = useCallback(() => {
    if (!sessionKey || !state.streamingRunId) return;
    dlog.info("Chat", "Stop streaming requested");

    // Determine which session key to send /stop on (thread or main)
    const targetKey = state.streamingThreadId
      ? `${sessionKey}:thread:${state.streamingThreadId}`
      : sessionKey;

    const msg: ChatMessage = {
      id: randomUUID(),
      sender: "user",
      text: "/stop",
      timestamp: Date.now(),
    };

    if (state.streamingThreadId) {
      dispatch({ type: "ADD_THREAD_MESSAGE", message: msg });
    } else {
      dispatch({ type: "ADD_MESSAGE", message: msg });
    }

    sendMessage({
      type: "user.message",
      sessionKey: targetKey,
      text: "/stop",
      userId: state.user?.id ?? "",
      messageId: msg.id,
    });

    recordSkillUsage("/stop");
    setSkillVersion((v) => v + 1);

    requestAnimationFrame(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  }, [sessionKey, state.streamingRunId, state.streamingThreadId, state.user?.id, sendMessage, dispatch]);

  const isStreaming = !!state.streamingRunId && !state.streamingThreadId;

  const selectedAgent = state.agents.find((a) => a.id === state.selectedAgentId);
  const channelName = selectedAgent?.name ?? "channel";
  const channelId = selectedAgent?.channelId ?? null;
  // Always show session tabs — for all channels including default (General)
  const showSessionTabs = !!selectedAgent;

  if (!sessionKey) {
    return (
      <div className="flex-1 h-full flex items-center justify-center" style={{ background: "var(--bg-surface)" }}>
        <div className="text-center">
          <svg className="w-16 h-16 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1} style={{ color: "var(--text-muted)" }}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
          </svg>
          <p className="text-body font-bold" style={{ color: "var(--text-muted)" }}>
            Select a channel to get started
          </p>
          <p className="text-caption mt-1" style={{ color: "var(--text-muted)" }}>
            Choose a channel from the sidebar
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={dropZoneRef}
      className="flex-1 flex flex-col min-w-0 h-full relative"
      style={{ background: "var(--bg-surface)" }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {dragOver && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.4)", pointerEvents: "none" }}
        >
          <div className="flex flex-col items-center gap-3 p-8 rounded-lg" style={{ background: "var(--bg-surface)", border: "2px dashed var(--text-link)" }}>
            <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} style={{ color: "var(--text-link)" }}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v13.5A1.5 1.5 0 003.75 21z" />
            </svg>
            <span className="text-body font-bold" style={{ color: "var(--text-primary)" }}>
              Drop image here
            </span>
          </div>
        </div>
      )}

      {/* Channel header — hidden on mobile (MobileLayout already shows channel name) */}
      {!isMobile && (
        <div
          className="flex items-center justify-between px-3 sm:px-5 gap-2 flex-shrink-0"
          style={{
            height: 44,
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-h1 truncate" style={{ color: "var(--text-primary)" }}>
              # {channelName}
            </span>
            {selectedAgent && !selectedAgent.isDefault && (
              <span className="text-caption hidden sm:inline flex-shrink-0" style={{ color: "var(--text-secondary)" }}>
                — custom channel
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <svg className="w-3.5 h-3.5 hidden sm:block" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} style={{ color: "var(--text-muted)" }}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
            </svg>
            <ModelSelect
              value={currentModel ?? ""}
              onChange={handleModelChange}
              models={state.models}
              disabled={!state.openclawConnected}
              placeholder="No model"
              compact
            />
          </div>
        </div>
      )}

      {/* Session tabs — shown for all agents (including default/General) */}
      {showSessionTabs && <SessionTabs channelId={channelId} />}

      {/* Messages – flat-row layout (overflow-x-hidden prevents horizontal scroll from long URLs/code) */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {state.messages.length === 0 && (
          <div className="py-12 px-5 text-center">
            <p className="text-caption" style={{ color: "var(--text-muted)" }}>
              No messages yet. Start a conversation.
            </p>
          </div>
        )}
        {state.messages.map((msg, i) => {
          const prevMsg = i > 0 ? state.messages[i - 1] : null;
          const isGrouped = prevMsg?.sender === msg.sender
            && (msg.timestamp - prevMsg.timestamp) < 300000; // 5 min

          return (
            <MessageRow
              key={msg.id}
              msg={msg}
              grouped={isGrouped}
              onOpenThread={() => openThread(msg.id)}
              onQuote={() => handleQuote(msg)}
              onCopy={() => handleCopy(msg.text)}
              onAction={handleA2UIAction}
              onResolveAction={(value, label) => handleResolveAction(msg.id, value, label)}
              onStop={handleStop}
            />
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Composer (section 5.6) */}
      <div className="flex-shrink-0 px-3 sm:px-5 pb-3 sm:pb-4 pt-2">
        {/* Skill buttons — sorted by recency-weighted score */}
        <div className="flex items-center gap-1.5 pb-1.5 overflow-x-auto no-scrollbar">
          {sortedSkills.map((skill) => {
            const entry = skillStore[skill.cmd];
            const count = entry?.total ?? 0;
            const recent = entry ? recentCount(entry) : 0;
            const isActive = input.startsWith(skill.cmd + " ") || input === skill.cmd;
            return (
              <button
                key={skill.cmd}
                onClick={() => handleSkillClick(skill.cmd)}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-xs whitespace-nowrap transition-colors shrink-0"
                style={{
                  background: isActive ? "var(--bg-active)" : "var(--bg-hover)",
                  color: isActive ? "#fff" : "var(--text-secondary)",
                  border: "1px solid transparent",
                }}
                title={`${skill.cmd}${count > 0 ? ` (total ${count}x${recent > 0 ? `, recent ${recent}x` : ""})` : ""}`}
              >
                <span className="font-mono text-[10px] opacity-70">{skill.cmd}</span>
                {count > 0 && (
                  <span
                    className="ml-0.5 px-1 rounded-sm text-[10px] font-bold"
                    style={{
                      background: isActive ? "rgba(255,255,255,0.2)" : "var(--bg-surface)",
                      color: isActive ? "#fff" : "var(--text-muted)",
                    }}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Quote reply preview */}
        {quotedMessage && (
          <div
            className="flex items-center gap-2 px-3 py-2 mb-1 rounded-md text-caption"
            style={{
              background: "var(--bg-hover)",
              borderLeft: "3px solid var(--text-link)",
              color: "var(--text-secondary)",
            }}
          >
            <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
            </svg>
            <span className="truncate flex-1">
              {quotedMessage.sender === "user" ? "You" : "Agent"}: {quotedMessage.text.slice(0, 80)}{quotedMessage.text.length > 80 ? "..." : ""}
            </span>
            <button
              onClick={() => setQuotedMessage(null)}
              className="p-0.5 rounded hover:bg-[--bg-surface] shrink-0"
              style={{ color: "var(--text-muted)" }}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        <div
          className="rounded-md"
          style={{
            border: "1px solid var(--border)",
            background: "var(--bg-surface)",
          }}
        >
          {/* Image preview */}
          {pendingImage && (
            <div className="px-3 pt-2 flex items-start gap-2">
              <div className="relative">
                <img
                  src={pendingImage.preview}
                  alt="Preview"
                  className="max-w-[120px] max-h-[80px] rounded-md object-contain"
                  style={{ border: "1px solid var(--border)" }}
                />
                <button
                  onClick={clearPendingImage}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center text-white opacity-80 hover:opacity-100 transition-opacity"
                  style={{ background: "#e74c3c", fontSize: 11 }}
                  title="Remove image"
                >
                  ✕
                </button>
              </div>
              {imageUploading && (
                <span className="text-caption" style={{ color: "var(--text-muted)" }}>
                  Uploading…
                </span>
              )}
            </div>
          )}

          {/* Textarea */}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSend();
              }
            }}
            onPaste={handlePaste}
            placeholder={
              state.openclawConnected
                ? `Message #${channelName}`
                : "OpenClaw is offline…"
            }
            disabled={!state.openclawConnected}
            rows={1}
            className="w-full px-3 py-2.5 text-body bg-transparent resize-none focus:outline-none disabled:opacity-50 placeholder:text-[--text-muted]"
            style={{ color: "var(--text-primary)", minHeight: 40 }}
          />

          {/* Bottom toolbar */}
          <div className="flex items-center justify-between px-3 pb-2">
            <div className="flex items-center gap-1">
              {/* Image upload button */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileSelect}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="p-1.5 rounded hover:bg-[--bg-hover] transition-colors"
                style={{ color: "var(--text-muted)" }}
                title="Upload image"
                aria-label="Upload image"
                disabled={!state.openclawConnected}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v13.5A1.5 1.5 0 003.75 21zm14.25-15.75a.75.75 0 11-1.5 0 .75.75 0 011.5 0z" />
                </svg>
              </button>
            </div>

            {/* Send / Stop button */}
            {isStreaming ? (
              <button
                onClick={handleStop}
                className="px-3 py-1.5 rounded-sm text-caption font-bold text-white transition-colors"
                style={{ background: "#e74c3c" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "#c0392b"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "#e74c3c"; }}
                title="Stop generating"
              >
                <div className="flex items-center gap-1.5">
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                  Stop
                </div>
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={(!input.trim() && !pendingImage) || !state.openclawConnected}
                className="px-3 py-1.5 rounded-sm text-caption font-bold text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                style={{ background: "var(--bg-active)" }}
              >
                <div className="flex items-center gap-1.5">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                  </svg>
                  Send
                </div>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Flat-row message item (section 5.2) */
function MessageRow({
  msg,
  grouped,
  onOpenThread,
  onQuote,
  onCopy,
  onAction,
  onResolveAction,
  onStop,
}: {
  msg: ChatMessage;
  grouped: boolean;
  onOpenThread: () => void;
  onQuote: () => void;
  onCopy: () => void;
  onAction?: (action: string) => void;
  onResolveAction?: (value: string, label: string) => void;
  onStop?: () => void;
}) {
  const state = useAppState();
  const senderLabel = msg.sender === "user" ? "You" : "OpenClaw Agent";
  const avatarColor = msg.sender === "user" ? "#9B59B6" : "#2BAC76";
  const initial = msg.sender === "user" ? "U" : "A";
  const replyCount = state.threadReplyCounts[msg.id] ?? 0;

  // Long-press context menu for mobile
  const [showContextMenu, setShowContextMenu] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchMoved = useRef(false);

  const handleTouchStart = useCallback(() => {
    touchMoved.current = false;
    longPressTimer.current = setTimeout(() => {
      if (!touchMoved.current) setShowContextMenu(true);
    }, 500);
  }, []);

  const handleTouchMove = useCallback(() => {
    touchMoved.current = true;
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  }, []);

  // Copied feedback
  const [copied, setCopied] = useState(false);
  const handleCopyWithFeedback = useCallback(() => {
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    setShowContextMenu(false);
  }, [onCopy]);

  return (
    <div
      className="group relative px-3 sm:px-5 hover:bg-[--bg-hover] transition-colors"
      style={{ paddingTop: grouped ? 2 : 8, paddingBottom: 2 }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onContextMenu={(e) => { e.preventDefault(); setShowContextMenu(true); }}
    >
      <div className="flex gap-2 max-w-message">
        {/* Avatar column */}
        <div className="flex-shrink-0" style={{ width: 36 }}>
          {!grouped && (
            <div
              className="w-9 h-9 rounded flex items-center justify-center text-white text-caption font-bold"
              style={{ background: avatarColor }}
            >
              {initial}
            </div>
          )}
        </div>

        {/* Content column */}
        <div className="flex-1 min-w-0">
          {!grouped && (
            <div className="flex items-baseline gap-2 mb-0.5">
              <span className="text-h2" style={{ color: "var(--text-primary)" }}>
                {senderLabel}
              </span>
              <span className="text-caption" style={{ color: "var(--text-secondary)" }}>
                {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
          )}
          <MessageContent
            text={msg.text}
            mediaUrl={msg.mediaUrl}
            a2ui={msg.a2ui}
            isStreaming={msg.isStreaming}
            onAction={onAction}
            onResolveAction={onResolveAction}
            resolvedActions={msg.resolvedActions}
          />
          {msg.isStreaming && (
            <div className="flex items-center gap-2 mt-1">
              <span
                className="inline-block w-1.5 h-4 rounded-sm animate-pulse"
                style={{ background: "var(--text-link)", verticalAlign: "text-bottom" }}
              />
              {onStop && (
                <button
                  onClick={onStop}
                  className="flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium transition-colors"
                  style={{
                    color: "var(--text-secondary)",
                    background: "var(--bg-hover)",
                    border: "1px solid var(--border)",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "#e74c3c";
                    e.currentTarget.style.color = "#fff";
                    e.currentTarget.style.borderColor = "#e74c3c";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text-secondary)";
                    e.currentTarget.style.borderColor = "var(--border)";
                  }}
                  title="Stop generating"
                >
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                  Stop
                </button>
              )}
            </div>
          )}

          {/* Thread bar – shown when this message has thread replies */}
          {replyCount > 0 && (
            <button
              onClick={onOpenThread}
              className="flex items-center gap-2 mt-1 py-1 px-1 -ml-1 rounded hover:bg-[--bg-hover] transition-colors cursor-pointer group/thread"
            >
              <span
                className="text-caption font-bold"
                style={{ color: "var(--text-link)" }}
              >
                {replyCount} {replyCount === 1 ? "reply" : "replies"}
              </span>
              <span
                className="text-caption opacity-0 group-hover/thread:opacity-100 transition-opacity"
                style={{ color: "var(--text-secondary)" }}
              >
                View thread
              </span>
              <svg
                className="w-4 h-4 opacity-0 group-hover/thread:opacity-100 transition-opacity"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                style={{ color: "var(--text-secondary)" }}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Desktop: Action bar (hover) — Thread + Quote + Copy */}
      <div
        className="absolute top-0 right-5 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 px-1 py-0.5 rounded"
        style={{
          background: "var(--bg-surface)",
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <ActionButton label="Reply in thread" onClick={onOpenThread} icon={
          <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
          </svg>
        } />
        <ActionButton label="Quote reply" onClick={() => { onQuote(); }} icon={
          <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
          </svg>
        } />
        <ActionButton label={copied ? "Copied!" : "Copy text"} onClick={handleCopyWithFeedback} icon={
          copied ? (
            <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
            </svg>
          )
        } />
      </div>

      {/* Mobile: Long-press context menu (bottom sheet) */}
      {showContextMenu && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center"
          style={{ background: "rgba(0,0,0,0.4)" }}
          onClick={() => setShowContextMenu(false)}
        >
          <div
            className="w-full max-w-md rounded-t-xl overflow-hidden"
            style={{
              background: "var(--bg-surface)",
              paddingBottom: "env(safe-area-inset-bottom, 12px)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Preview of the message being acted on */}
            <div className="px-4 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
              <span className="text-caption" style={{ color: "var(--text-muted)" }}>
                {msg.sender === "user" ? "You" : "Agent"}
              </span>
              <p className="text-body mt-0.5 line-clamp-2" style={{ color: "var(--text-primary)" }}>
                {msg.text.slice(0, 120)}{msg.text.length > 120 ? "..." : ""}
              </p>
            </div>

            <ContextMenuItem
              label="Reply in thread"
              icon={<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" /></svg>}
              onClick={() => { setShowContextMenu(false); onOpenThread(); }}
            />
            <ContextMenuItem
              label="Quote reply"
              icon={<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" /></svg>}
              onClick={() => { setShowContextMenu(false); onQuote(); }}
            />
            <ContextMenuItem
              label="Copy text"
              icon={<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" /></svg>}
              onClick={handleCopyWithFeedback}
            />

            <button
              onClick={() => setShowContextMenu(false)}
              className="w-full py-3 text-body font-bold"
              style={{ color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Context menu item for mobile long-press bottom sheet */
function ContextMenuItem({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-3 text-body transition-colors active:bg-[--bg-hover]"
      style={{ color: "var(--text-primary)" }}
    >
      <span style={{ color: "var(--text-secondary)" }}>{icon}</span>
      {label}
    </button>
  );
}

function ActionButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="p-1 rounded hover:bg-[--bg-hover] transition-colors"
      style={{ color: "var(--text-secondary)" }}
      title={label}
      aria-label={label}
    >
      {icon}
    </button>
  );
}
