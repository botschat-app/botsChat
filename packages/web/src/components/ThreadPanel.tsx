import React, { useState, useEffect, useCallback } from "react";
import { useAppState, useAppDispatch, type ChatMessage } from "../store";
import { messagesApi } from "../api";
import type { WSMessage } from "../ws";
import { MessageContent } from "./MessageContent";
import { E2eService } from "../e2e";
import { dlog } from "../debug-log";
import { randomUUID } from "../utils/uuid";
import { formatMessageTime, formatFullDateTime } from "../utils/time";
import { useIMEComposition } from "../hooks/useIMEComposition";

/** Simple string hash for action prompt keys (matches MessageContent / ChatWindow) */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash.toString(36);
}

type ThreadPanelProps = {
  sendMessage: (msg: WSMessage) => void;
};

/** Detail Panel (section 5.5) – slides in from right */
export function ThreadPanel({ sendMessage }: ThreadPanelProps) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [input, setInput] = useState("");
  const { onCompositionStart, onCompositionEnd, isIMEActive } = useIMEComposition();

  // Load thread message history when a thread is opened
  useEffect(() => {
    if (!state.activeThreadId || !state.selectedSessionKey || !state.user) return;
    const threadSessionKey = `${state.selectedSessionKey}:thread:${state.activeThreadId}`;
    dlog.info("Thread", `Loading history for thread ${state.activeThreadId}`);
    messagesApi
      .list(state.user.id, threadSessionKey, state.activeThreadId)
      .then(async ({ messages }) => {
        dlog.info("Thread", `Loaded ${messages.length} thread messages`);
        if (messages.length > 0) {
          const decrypted = await Promise.all(messages.map(async (m) => {
            if (m.encrypted && E2eService.hasKey()) {
              try {
                const plaintext = await E2eService.decrypt(m.text, m.id);
                return { ...m, text: plaintext, isEncryptedLocked: false };
              } catch (err) {
                dlog.warn("Thread", `Failed to decrypt message ${m.id}`, err);
                return { ...m, isEncryptedLocked: true };
              }
            } else if (m.encrypted) {
              return { ...m, isEncryptedLocked: true };
            }
            return m;
          }));
          dispatch({ type: "OPEN_THREAD", threadId: state.activeThreadId!, messages: decrypted });
        }
      })
      .catch((err) => {
        dlog.error("Thread", `Failed to load thread history: ${err}`);
      });
  }, [state.activeThreadId]);

  if (!state.activeThreadId) return null;

  const parentMessage = state.messages.find(
    (m) => m.id === state.activeThreadId,
  );

  const threadSessionKey = state.selectedSessionKey
    ? `${state.selectedSessionKey}:thread:${state.activeThreadId}`
    : null;

  /** Handle A2UI action button clicks in thread — sends as user message */
  const handleA2UIAction = useCallback((action: string) => {
    if (!threadSessionKey) return;
    dlog.info("Thread/A2UI", `Action triggered: ${action}`);
    const msg: ChatMessage = {
      id: randomUUID(),
      sender: "user",
      text: action,
      timestamp: Date.now(),
      threadId: state.activeThreadId ?? undefined,
    };
    dispatch({ type: "ADD_THREAD_MESSAGE", message: msg });
    sendMessage({
      type: "user.message",
      sessionKey: threadSessionKey,
      text: action,
      userId: state.user?.id ?? "",
      messageId: msg.id,
    });
  }, [threadSessionKey, state.activeThreadId, state.user?.id, sendMessage, dispatch]);

  /** Handle ActionCard resolve in thread — marks widget done + sends choice */
  const handleResolveAction = useCallback((messageId: string, value: string, label: string) => {
    if (!threadSessionKey) return;
    dlog.info("Thread/ActionCard", `Resolved: "${label}" (value="${value}")`);
    const promptHash = simpleHash(label + value);
    dispatch({ type: "RESOLVE_ACTION", messageId, promptHash, value, label });
    const msg: ChatMessage = {
      id: randomUUID(),
      sender: "user",
      text: label,
      timestamp: Date.now(),
      threadId: state.activeThreadId ?? undefined,
    };
    dispatch({ type: "ADD_THREAD_MESSAGE", message: msg });
    sendMessage({
      type: "user.message",
      sessionKey: threadSessionKey,
      text: label,
      userId: state.user?.id ?? "",
      messageId: msg.id,
    });
  }, [threadSessionKey, state.activeThreadId, state.user?.id, sendMessage, dispatch]);

  /** Stop the current thread streaming — sends /stop */
  const handleStop = useCallback(() => {
    if (!threadSessionKey || !state.streamingRunId || !state.streamingThreadId) return;
    dlog.info("Thread", "Stop streaming requested");
    const msg: ChatMessage = {
      id: randomUUID(),
      sender: "user",
      text: "/stop",
      timestamp: Date.now(),
      threadId: state.activeThreadId ?? undefined,
    };
    dispatch({ type: "ADD_THREAD_MESSAGE", message: msg });
    sendMessage({
      type: "user.message",
      sessionKey: threadSessionKey,
      text: "/stop",
      userId: state.user?.id ?? "",
      messageId: msg.id,
    });
  }, [threadSessionKey, state.streamingRunId, state.streamingThreadId, state.activeThreadId, state.user?.id, sendMessage, dispatch]);

  const isThreadStreaming = !!state.streamingRunId && !!state.streamingThreadId;

  const handleSend = () => {
    if (!input.trim() || !state.selectedSessionKey) return;

    const trimmed = input.trim();
    dlog.info("Thread", `Send reply: ${trimmed.length > 120 ? trimmed.slice(0, 120) + "…" : trimmed}`, { threadId: state.activeThreadId });

    const msg: ChatMessage = {
      id: randomUUID(),
      sender: "user",
      text: trimmed,
      timestamp: Date.now(),
      threadId: state.activeThreadId ?? undefined,
    };

    dispatch({ type: "ADD_THREAD_MESSAGE", message: msg });

    sendMessage({
      type: "user.message",
      sessionKey: threadSessionKey!,
      text: trimmed,
      userId: state.user?.id ?? "",
      messageId: msg.id,
    });

    setInput("");
  };

  return (
    <div
      className="flex flex-col h-full"
      style={{
        background: "var(--bg-surface)",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 flex-shrink-0"
        style={{ height: 44, borderBottom: "1px solid var(--border)" }}
      >
        <h3 className="text-h1" style={{ color: "var(--text-primary)" }}>Thread</h3>
        <button
          onClick={() => dispatch({ type: "CLOSE_THREAD" })}
          className="p-1 rounded hover:bg-[--bg-hover] transition-colors"
          style={{ color: "var(--text-secondary)" }}
          aria-label="Close thread"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Scrollable area: parent message + replies */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Parent message */}
        {parentMessage && (
          <div className="px-5 py-3" style={{ borderBottom: "1px solid var(--border)" }}>
            <div className="flex gap-2">
              <div
                className="w-9 h-9 rounded flex-shrink-0 flex items-center justify-center text-white text-caption font-bold"
                style={{ background: parentMessage.sender === "user" ? "#9B59B6" : "#2BAC76" }}
              >
                {parentMessage.sender === "user" ? "U" : "A"}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 mb-0.5">
                  <span className="text-h2" style={{ color: "var(--text-primary)" }}>
                    {parentMessage.sender === "user" ? "You" : "OpenClaw Agent"}
                  </span>
                  <span
                    className="text-caption cursor-default"
                    style={{ color: "var(--text-secondary)" }}
                    title={formatFullDateTime(parentMessage.timestamp)}
                  >
                    {formatMessageTime(parentMessage.timestamp)}
                  </span>
                </div>
                <MessageContent
                  text={parentMessage.text}
                  mediaUrl={parentMessage.mediaUrl}
                  messageId={parentMessage.id}
                  encrypted={!!parentMessage.mediaEncrypted && !!parentMessage.mediaUrl && E2eService.hasKey()}
                  a2ui={parentMessage.a2ui}
                  onAction={handleA2UIAction}
                  onResolveAction={(value, label) => handleResolveAction(parentMessage.id, value, label)}
                  resolvedActions={parentMessage.resolvedActions}
                />
              </div>
            </div>
          </div>
        )}

        {/* Reply count divider */}
        <div className="px-5 py-2" style={{ borderBottom: "1px solid var(--border)" }}>
          <span className="text-caption font-bold" style={{ color: "var(--text-link)" }}>
            {state.threadMessages.length} {state.threadMessages.length === 1 ? "reply" : "replies"}
          </span>
        </div>

        {/* Thread replies – flat rows like main content */}
        {state.threadMessages.map((msg, i) => {
          const prevMsg = i > 0 ? state.threadMessages[i - 1] : null;
          const isGrouped = prevMsg?.sender === msg.sender
            && (msg.timestamp - prevMsg.timestamp) < 300000;

          return (
            <div
              key={msg.id}
              className="px-5 hover:bg-[--bg-hover] transition-colors"
              style={{ paddingTop: isGrouped ? 2 : 8, paddingBottom: 2 }}
            >
              <div className="flex gap-2">
                <div className="flex-shrink-0" style={{ width: 36 }}>
                  {!isGrouped && (
                    <div
                      className="w-9 h-9 rounded flex items-center justify-center text-white text-caption font-bold"
                      style={{ background: msg.sender === "user" ? "#9B59B6" : "#2BAC76" }}
                    >
                      {msg.sender === "user" ? "U" : "A"}
                    </div>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  {!isGrouped && (
                    <div className="flex items-baseline gap-2 mb-0.5">
                      <span className="text-h2" style={{ color: "var(--text-primary)" }}>
                        {msg.sender === "user" ? "You" : "OpenClaw Agent"}
                      </span>
                      <span
                        className="text-caption cursor-default"
                        style={{ color: "var(--text-secondary)" }}
                        title={formatFullDateTime(msg.timestamp)}
                      >
                        {formatMessageTime(msg.timestamp)}
                      </span>
                    </div>
                  )}
                  <MessageContent
                    text={msg.text}
                    mediaUrl={msg.mediaUrl}
                    messageId={msg.id}
                    encrypted={!!msg.mediaEncrypted && !!msg.mediaUrl && E2eService.hasKey()}
                    a2ui={msg.a2ui}
                    isStreaming={msg.isStreaming}
                    onAction={handleA2UIAction}
                    onResolveAction={(value, label) => handleResolveAction(msg.id, value, label)}
                    resolvedActions={msg.resolvedActions}
                  />
                  {msg.isStreaming && (
                    <div className="flex items-center gap-2 mt-1">
                      <span
                        className="inline-block w-1.5 h-4 rounded-sm animate-pulse"
                        style={{ background: "var(--text-link)", verticalAlign: "text-bottom" }}
                      />
                      <button
                        onClick={handleStop}
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
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div> {/* end scrollable area */}

      {/* Thread composer */}
      <div className="px-4 pb-3 pt-2">
        <div
          className="rounded-md"
          style={{ border: "1px solid var(--border)", background: "var(--bg-surface)" }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !isIMEActive()) {
                e.preventDefault();
                handleSend();
              }
            }}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
            placeholder="Reply…"
            rows={1}
            className="w-full px-3 py-2 text-body bg-transparent resize-none focus:outline-none placeholder:text-[--text-muted]"
            style={{ color: "var(--text-primary)", minHeight: 36 }}
          />
          <div className="flex justify-end px-3 pb-2">
            {isThreadStreaming ? (
              <button
                onClick={handleStop}
                className="px-3 py-1 rounded-sm text-caption font-bold text-white transition-colors"
                style={{ background: "#e74c3c" }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "#c0392b"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "#e74c3c"; }}
                title="Stop generating"
              >
                <div className="flex items-center gap-1">
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                  Stop
                </div>
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim()}
                className="px-3 py-1 rounded-sm text-caption font-bold text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                style={{ background: "var(--bg-active)" }}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
