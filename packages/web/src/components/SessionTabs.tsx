import React, { useState, useRef, useEffect, useCallback } from "react";
import { useAppState, useAppDispatch } from "../store";
import { sessionsApi, channelsApi, agentsApi } from "../api";
import { dlog } from "../debug-log";

type SessionTabsProps = {
  channelId: string | null;
};

export function SessionTabs({ channelId }: SessionTabsProps) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const editRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const sessions = state.sessions;
  const selectedId = state.selectedSessionId;

  // Focus input when editing
  useEffect(() => {
    if (editingId && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingId]);

  const handleSelect = useCallback(
    (sessionId: string) => {
      if (sessionId === selectedId) return;
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) return;
      dlog.info("Session", `Switched to session: ${session.name} (${session.id})`);
      dispatch({
        type: "SELECT_SESSION",
        sessionId: session.id,
        sessionKey: session.sessionKey,
      });
    },
    [selectedId, sessions, dispatch],
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

      const session = await sessionsApi.create(effectiveChannelId);
      dlog.info("Session", `Created session: ${session.name} (${session.id})`);
      dispatch({ type: "ADD_SESSION", session });
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
        // If deleted the selected session, switch to the first remaining
        if (selectedId === sessionId) {
          const remaining = sessions.filter((s) => s.id !== sessionId);
          if (remaining.length > 0) {
            dispatch({
              type: "SELECT_SESSION",
              sessionId: remaining[0].id,
              sessionKey: remaining[0].sessionKey,
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

                  {/* Close button — only show on hover, not for last session */}
                  {sessions.length > 1 && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(session.id);
                      }}
                      className="ml-0.5 w-4 h-4 flex items-center justify-center rounded-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-[--bg-hover]"
                      style={{ color: "var(--text-muted)" }}
                      title="Close session"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </span>
                  )}
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
    </div>
  );
}
