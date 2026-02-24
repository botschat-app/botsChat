import React, { useState } from "react";
import { useAppState, useAppDispatch } from "../store";
import { tasksApi, channelsApi } from "../api";
import { dlog } from "../debug-log";
import { useIMEComposition } from "../hooks/useIMEComposition";

function relativeTime(ts: number): string {
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function CronSidebar({ onNavigate }: { onNavigate?: () => void } = {}) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const { onCompositionStart, onCompositionEnd, isIMEActive } = useIMEComposition();

  const handleSelect = (taskId: string) => {
    // Ensure activeView is "automations" so cron data loads correctly
    if (state.activeView !== "automations") {
      dispatch({ type: "SET_ACTIVE_VIEW", view: "automations" });
    }
    dispatch({ type: "SELECT_CRON_TASK", taskId });
    onNavigate?.();
  };

  const handleCreateTask = async () => {
    if (!newName.trim()) return;
    // Find a suitable channel — prefer "Default", then first available
    let channelId = state.channels.find((c) => c.name === "Default")?.id
      ?? state.channels[0]?.id;
    if (!channelId) {
      // Auto-create a "Default" channel if none exist
      try {
        const ch = await channelsApi.create({ name: "Default" });
        channelId = ch.id;
        const { channels } = await channelsApi.list();
        dispatch({ type: "SET_CHANNELS", channels });
      } catch (err) {
        dlog.error("Cron", `Failed to create default channel: ${err}`);
        return;
      }
    }
    try {
      const task = await tasksApi.create(channelId, { name: newName.trim(), kind: "background" });
      dlog.info("Cron", `Created automation: ${task.name} (${task.id})`);
      // Reload cron tasks
      const { tasks } = await tasksApi.listAll("background");
      dispatch({ type: "SET_CRON_TASKS", cronTasks: tasks });
      dispatch({ type: "SELECT_CRON_TASK", taskId: task.id });
      setShowCreate(false);
      setNewName("");
      onNavigate?.();
    } catch (err) {
      dlog.error("Cron", `Failed to create automation: ${err}`);
    }
  };

  return (
    <div
      className="flex flex-col"
      style={{ background: "var(--bg-secondary)" }}
    >
      {/* Header with + button */}
      <div className="w-full flex items-center px-4 py-1.5">
        <button
          className="flex items-center gap-1 text-tiny uppercase tracking-wider text-[--text-sidebar] hover:text-[--text-sidebar-active] transition-colors"
        >
          Automations
        </button>
        <span className="ml-1.5 text-tiny text-[--text-muted]">
          {state.cronTasks.length > 0 && `${state.cronTasks.length}`}
        </span>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="ml-auto p-0.5 rounded transition-colors text-[--text-sidebar] hover:text-[--text-sidebar-active] hover:bg-[--sidebar-hover]"
          title="New automation"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>
      </div>

      {/* Inline create automation form */}
      {showCreate && (
        <div className="px-4 py-2 space-y-2">
          <input
            type="text"
            placeholder="Automation name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && !isIMEActive() && handleCreateTask()}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
            className="w-full px-2 py-1.5 text-caption text-[--text-sidebar] rounded-sm focus:outline-none placeholder:text-[--text-muted]"
            style={{ background: "var(--sidebar-hover)", border: "1px solid var(--sidebar-border)" }}
            autoFocus
          />
          <div className="flex gap-2">
            <button
              onClick={handleCreateTask}
              className="flex-1 px-3 py-1.5 text-caption bg-[--bg-active] text-white rounded-sm font-bold hover:brightness-110"
            >
              Create
            </button>
            <button
              onClick={() => { setShowCreate(false); setNewName(""); }}
              className="px-3 py-1.5 text-caption text-[--text-muted] hover:text-[--text-sidebar]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Job list */}
      <div className="flex-1 overflow-y-auto sidebar-scroll">
        {state.cronTasks.length === 0 && !showCreate ? (
          <div className="px-4 py-8 text-center">
            <svg
              className="w-10 h-10 mx-auto mb-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1}
              style={{ color: "var(--text-muted)" }}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-caption text-[--text-muted]">
              No automations yet.
            </p>
            <p className="text-tiny text-[--text-muted] mt-1">
              Cron jobs from OpenClaw will appear here automatically.
            </p>
          </div>
        ) : (
          state.cronTasks.map((task) => {
            const isSelected = state.selectedCronTaskId === task.id;
            const isEnabled = task.enabled;
            // Determine status dot color
            let dotColor = "var(--accent-green)"; // enabled
            if (!isEnabled) dotColor = "var(--text-muted)"; // paused

            return (
              <button
                key={task.id}
                onClick={() => handleSelect(task.id)}
                className="w-full text-left py-2 transition-colors"
                style={{
                  paddingLeft: isSelected ? 13 : 16,
                  paddingRight: 16,
                  background: isSelected ? "var(--bg-hover)" : undefined,
                  borderLeft: isSelected ? "3px solid var(--bg-active)" : "3px solid transparent",
                  color: isSelected ? "var(--text-sidebar-active)" : "var(--text-sidebar)",
                }}
                onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "var(--sidebar-hover)"; }}
                onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = isSelected ? "var(--bg-hover)" : ""; }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ background: dotColor }}
                  />
                  <span className={`text-body truncate ${isSelected ? "font-bold" : ""}`}>
                    {task.name}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5 pl-4">
                  <span className="text-tiny truncate" style={{ color: "var(--text-muted)" }}>
                    {task.schedule ?? "no schedule"}
                  </span>
                  {!isEnabled && (
                    <span className="text-tiny" style={{ color: "var(--text-muted)" }}>
                      paused
                    </span>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
