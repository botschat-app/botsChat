import React, { useState, useRef, useEffect, useCallback } from "react";
import { useAppState, useAppDispatch } from "../store";
import { sessionsApi, channelsApi, agentsApi } from "../api";
import { dlog } from "../debug-log";

// ---------------------------------------------------------------------------
// Session history — tracks per-channel usage order in localStorage
// ---------------------------------------------------------------------------
const SESSION_HISTORY_KEY = "botschat:sessionHistory";
const SESSION_COUNTER_KEY = "botschat:sessionCounter";

/** Get the ordered list of recently-used session IDs for a channel. */
function getSessionHistory(channelId: string): string[] {
  try {
    const all = JSON.parse(localStorage.getItem(SESSION_HISTORY_KEY) || "{}");
    return Array.isArray(all[channelId]) ? all[channelId] : [];
  } catch {
    return [];
  }
}

/** Record a session as the most-recently-used for its channel. */
function recordSessionUsage(channelId: string, sessionId: string) {
  try {
    const all = JSON.parse(localStorage.getItem(SESSION_HISTORY_KEY) || "{}");
    const list: string[] = Array.isArray(all[channelId]) ? all[channelId] : [];
    // Move to front (most recent)
    const filtered = list.filter((id) => id !== sessionId);
    filtered.unshift(sessionId);
    // Keep at most 50 entries per channel
    all[channelId] = filtered.slice(0, 50);
    localStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(all));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Session counter — per-channel high-water-mark for monotonic session naming
// ---------------------------------------------------------------------------

/** Extract the numeric suffix from a "Session N" name, or return 0. */
function extractSessionNumber(name: string): number {
  const match = name.match(/^Session\s+(\d+)$/);
  return match ? parseInt(match[1], 10) : 0;
}

/** Get the next session number for a channel (monotonically increasing). */
function getNextSessionNumber(channelId: string, existingSessions: { name: string }[]): number {
  // High-water-mark from localStorage
  let hwm = 0;
  try {
    const all = JSON.parse(localStorage.getItem(SESSION_COUNTER_KEY) || "{}");
    hwm = typeof all[channelId] === "number" ? all[channelId] : 0;
  } catch { /* ignore */ }

  // Max number from existing session names
  const maxExisting = existingSessions.reduce(
    (max, s) => Math.max(max, extractSessionNumber(s.name)),
    0,
  );

  const next = Math.max(hwm, maxExisting) + 1;

  // Persist the new high-water-mark
  try {
    const all = JSON.parse(localStorage.getItem(SESSION_COUNTER_KEY) || "{}");
    all[channelId] = next;
    localStorage.setItem(SESSION_COUNTER_KEY, JSON.stringify(all));
  } catch { /* ignore */ }

  return next;
}

/** Remove a session from the history for a channel. */
function removeSessionFromHistory(channelId: string, sessionId: string) {
  try {
    const all = JSON.parse(localStorage.getItem(SESSION_HISTORY_KEY) || "{}");
    const list: string[] = Array.isArray(all[channelId]) ? all[channelId] : [];
    all[channelId] = list.filter((id) => id !== sessionId);
    localStorage.setItem(SESSION_HISTORY_KEY, JSON.stringify(all));
  } catch { /* ignore */ }
}

type SessionTabsProps = {
  channelId: string | null;
};

export function SessionTabs({ channelId }: SessionTabsProps) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);

  const sessions = state.sessions;
  const selectedId = state.selectedSessionId;

  // Focus input when editing
  useEffect(() => {
    if (editingId && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingId]);

  // Close confirmation popover on outside click
  useEffect(() => {
    if (!confirmDeleteId) return;
    const handler = (e: MouseEvent) => {
      if (confirmRef.current && !confirmRef.current.contains(e.target as Node)) {
        setConfirmDeleteId(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [confirmDeleteId]);

  const handleSelect = useCallback(
    (sessionId: string) => {
      if (sessionId === selectedId) return;
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return;
      dlog.info("Session", `Switched to session: ${session.name} (${session.id})`);
      // Record usage for smart navigation on close
      if (channelId) recordSessionUsage(channelId, session.id);
      dispatch({
        type: "SELECT_SESSION",
        sessionId: session.id,
        sessionKey: session.sessionKey,
      });
    },
    [selectedId, sessions, channelId, dispatch],
  );

  const handleCreate = useCallback(async () => {
    try {
      let effectiveChannelId = channelId;

      // Auto-create a "General" channel for the default agent (no channelId yet)
      if (!effectiveChannelId) {
        dlog.info("Session", "No channel for default agent — auto-creating General channel");
        const channel = await channelsApi.create({ name: "General", openclawAgentId: "main" });
        effectiveChannelId = channel.id;
        // Reload agents and channels so the default agent picks up the new channelId
        const [{ agents }, { channels: chs }] = await Promise.all([
          agentsApi.list(),
          channelsApi.list(),
        ]);
        dispatch({ type: "SET_AGENTS", agents });
        dispatch({ type: "SET_CHANNELS", channels: chs });
        // Channel creation auto-creates a "Session 1" — load and select it
        const { sessions: newSessions } = await sessionsApi.list(effectiveChannelId);
        dispatch({ type: "SET_SESSIONS", sessions: newSessions });
        if (newSessions.length > 0) {
          dispatch({
            type: "SELECT_SESSION",
            sessionId: newSessions[0].id,
            sessionKey: newSessions[0].sessionKey,
          });
        }
        return;
      }

      const nextNum = getNextSessionNumber(effectiveChannelId, sessions);
      const session = await sessionsApi.create(effectiveChannelId, `Session ${nextNum}`);
      dlog.info("Session", `Created session: ${session.name} (${session.id})`);
      dispatch({ type: "ADD_SESSION", session });
      recordSessionUsage(effectiveChannelId, session.id);
      dispatch({
        type: "SELECT_SESSION",
        sessionId: session.id,
        sessionKey: session.sessionKey,
      });
      // Scroll to the end to show the new tab
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
        }
      });
    } catch (err) {
      dlog.error("Session", `Failed to create session: ${err}`);
    }
  }, [channelId, dispatch]);

  const handleDelete = useCallback(
    async (sessionId: string) => {
      if (sessions.length <= 1 || !channelId) return; // can't delete last session
      try {
        await sessionsApi.delete(channelId, sessionId);
        dlog.info("Session", `Deleted session: ${sessionId}`);
        dispatch({ type: "REMOVE_SESSION", sessionId });
        removeSessionFromHistory(channelId, sessionId);
        setConfirmDeleteId(null);

        // If deleted the selected session, navigate to the last-used session
        // in the same channel (from history), or fall back to first remaining
        if (selectedId === sessionId) {
          const remaining = sessions.filter((s) => s.id !== sessionId);
          if (remaining.length > 0) {
            const history = getSessionHistory(channelId);
            const target = history
              .map((hId) => remaining.find((s) => s.id === hId))
              .find(Boolean) ?? remaining[0];
            dispatch({
              type: "SELECT_SESSION",
              sessionId: target.id,
              sessionKey: target.sessionKey,
            });
          }
        }
      } catch (err) {
        dlog.error("Session", `Failed to delete session: ${err}`);
      }
    },
    [channelId, sessions, selectedId, dispatch],
  );

  const startRename = useCallback((sessionId: string, currentName: string) => {
    setEditingId(sessionId);
    setEditValue(currentName);
  }, []);

  const commitRename = useCallback(async () => {
    if (!editingId || !editValue.trim() || !channelId) {
      setEditingId(null);
      return;
    }
    try {
      await sessionsApi.rename(channelId, editingId, editValue.trim());
      dlog.info("Session", `Renamed session ${editingId} to: ${editValue.trim()}`);
      dispatch({ type: "RENAME_SESSION", sessionId: editingId, name: editValue.trim() });
    } catch (err) {
      dlog.error("Session", `Failed to rename session: ${err}`);
    }
    setEditingId(null);
  }, [channelId, editingId, editValue, dispatch]);

  return (
    <div
      className="flex items-center gap-0 px-3"
      style={{
        height: 36,
        borderBottom: "1px solid var(--border)",
        background: "var(--bg-surface)",
      }}
    >
      {/* Scrollable tab list + new session button together */}
      <div
        ref={scrollRef}
        className="flex items-center gap-0.5 overflow-x-auto no-scrollbar"
      >
        {sessions.map((session) => {
          const isActive = session.id === selectedId;
          const isEditing = session.id === editingId;

          return (
            <div
              key={session.id}
              className="group relative flex items-center shrink-0"
            >
              {isEditing ? (
                <input
                  ref={editRef}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      commitRename();
                    }
                    if (e.key === "Escape") {
                      setEditingId(null);
                    }
                  }}
                  className="px-2.5 py-1 text-caption rounded-t-md focus:outline-none"
                  style={{
                    background: "var(--bg-hover)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--bg-active)",
                    borderBottom: "none",
                    minWidth: 60,
                    maxWidth: 140,
                  }}
                />
              ) : (
                <button
                  onClick={() => handleSelect(session.id)}
                  onDoubleClick={() => startRename(session.id, session.name)}
                  className="flex items-center gap-1 px-2.5 py-1 text-caption rounded-t-md transition-colors whitespace-nowrap"
                  style={{
                    background: isActive ? "var(--bg-hover)" : "transparent",
                    color: isActive ? "var(--text-primary)" : "var(--text-secondary)",
                    fontWeight: isActive ? 700 : 400,
                    borderBottom: isActive ? "2px solid var(--bg-active)" : "2px solid transparent",
                    marginBottom: -1,
                  }}
                  title={`${session.name} (double-click to rename)`}
                >
                  <span className="max-w-[120px] truncate">{session.name}</span>
                </button>
              )}
            </div>
          );
        })}

        {/* New session button — inline right after tabs */}
        <button
          onClick={handleCreate}
          className="shrink-0 w-7 h-7 flex items-center justify-center rounded-md transition-colors ml-0.5"
          style={{ color: "var(--text-muted)" }}
          title="New session"
          aria-label="New session"
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--bg-hover)";
            e.currentTarget.style.color = "var(--text-primary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "";
            e.currentTarget.style.color = "var(--text-muted)";
          }}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>
      </div>

      {/* Close current session button — separate from tabs, with confirmation */}
      {sessions.length > 1 && selectedId && (
        <div className="relative ml-auto pl-2 flex-shrink-0">
          <button
            onClick={() => setConfirmDeleteId(selectedId)}
            className="w-7 h-7 flex items-center justify-center rounded-md transition-colors"
            style={{ color: "var(--text-muted)" }}
            title="Close current session"
            aria-label="Close current session"
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "var(--bg-hover)";
              e.currentTarget.style.color = "var(--text-primary)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "";
              e.currentTarget.style.color = "var(--text-muted)";
            }}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          {/* Confirmation popover */}
          {confirmDeleteId && (
            <div
              ref={confirmRef}
              className="absolute right-0 top-full mt-1 z-50 rounded-md shadow-lg py-2 px-3 min-w-[180px]"
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--border)",
                boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
              }}
            >
              <p className="text-caption mb-2" style={{ color: "var(--text-primary)" }}>
                Close this session?
              </p>
              <div className="flex items-center gap-2 justify-end">
                <button
                  onClick={() => setConfirmDeleteId(null)}
                  className="px-2.5 py-1 text-caption rounded-md transition-colors"
                  style={{ color: "var(--text-secondary)" }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "";
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDelete(confirmDeleteId)}
                  className="px-2.5 py-1 text-caption font-bold rounded-md text-white transition-colors"
                  style={{ background: "#e74c3c" }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "#c0392b";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "#e74c3c";
                  }}
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
