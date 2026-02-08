import React from "react";
import { useAppState, useAppDispatch } from "../store";

function relativeTime(ts: number): string {
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function CronSidebar() {
  const state = useAppState();
  const dispatch = useAppDispatch();

  const handleSelect = (taskId: string) => {
    dispatch({ type: "SELECT_CRON_TASK", taskId });
  };

  return (
    <div
      className="flex flex-col h-full"
      style={{ width: 220, minWidth: 160, background: "var(--bg-secondary)", borderRight: "1px solid var(--border)" }}
    >
      {/* Header */}
      <div className="px-4 py-3 flex items-center gap-2">
        <span className="text-[--text-sidebar-active] font-bold text-h2 truncate flex-1">
          Automations
        </span>
      </div>

      {/* Connection status */}
      <div className="px-4 pb-2">
        <div className="flex items-center gap-1.5">
          <div
            className="w-2 h-2 rounded-full"
            style={{ background: state.openclawConnected ? "var(--accent-green)" : "var(--accent-red)" }}
          />
          <span className="text-tiny text-[--text-muted]">
            {state.openclawConnected ? "OpenClaw connected" : "OpenClaw offline"}
          </span>
        </div>
      </div>

      {/* Task count */}
      <div className="px-4 pb-2">
        <span className="text-tiny text-[--text-muted]">
          {state.cronTasks.length} cron job{state.cronTasks.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Job list */}
      <div className="flex-1 overflow-y-auto sidebar-scroll">
        {state.cronTasks.length === 0 ? (
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
