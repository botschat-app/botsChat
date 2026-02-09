import React, { useState } from "react";
import { useAppState, useAppDispatch } from "../store";
import { tasksApi, type Task } from "../api";

const SCHEDULE_PRESETS = [
  { label: "Every 30 min", value: "every 30m" },
  { label: "Every hour", value: "every 1h" },
  { label: "Every 6 hours", value: "every 6h" },
  { label: "Daily at 9am", value: "cron 0 9 * * *" },
  { label: "Daily at 6pm", value: "cron 0 18 * * *" },
  { label: "Twice daily", value: "cron 0 9,18 * * *" },
  { label: "Weekly Monday 9am", value: "cron 0 9 * * 1" },
  { label: "Custom", value: "" },
];

/** Task bar for channel-based agents – sits below the channel header */
export function TaskBar() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [showCreate, setShowCreate] = useState(false);
  const [newTaskName, setNewTaskName] = useState("");
  const [newTaskKind, setNewTaskKind] = useState<"adhoc" | "background">("adhoc");
  const [newSchedule, setNewSchedule] = useState("");
  const [newInstructions, setNewInstructions] = useState("");
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [editSchedule, setEditSchedule] = useState("");
  const [editInstructions, setEditInstructions] = useState("");
  const [editEnabled, setEditEnabled] = useState(true);

  const agent = state.agents.find((a) => a.id === state.selectedAgentId);
  const channel = agent?.channelId
    ? state.channels.find((ch) => ch.id === agent.channelId)
    : null;
  if (!channel) return null;

  const handleCreate = async () => {
    if (!newTaskName.trim()) return;
    try {
      await tasksApi.create(channel.id, {
        name: newTaskName,
        kind: newTaskKind,
        schedule: newTaskKind === "background" ? newSchedule : undefined,
        instructions: newTaskKind === "background" ? newInstructions : undefined,
      });
      const { tasks } = await tasksApi.list(channel.id);
      dispatch({ type: "SET_TASKS", tasks });
      setShowCreate(false);
      setNewTaskName("");
      setNewSchedule("");
      setNewInstructions("");
    } catch (err) {
      console.error("Failed to create task:", err);
    }
  };

  const handleOpenConfig = (t: Task, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingTask(t);
    setEditSchedule(t.schedule ?? "");
    setEditInstructions(t.instructions ?? "");
    setEditEnabled(t.enabled);
  };

  const handleSaveConfig = async () => {
    if (!editingTask) return;
    try {
      await tasksApi.update(channel.id, editingTask.id, {
        schedule: editSchedule,
        instructions: editInstructions,
        enabled: editEnabled,
      });
      const { tasks } = await tasksApi.list(channel.id);
      dispatch({ type: "SET_TASKS", tasks });
      setEditingTask(null);
    } catch (err) {
      console.error("Failed to update task:", err);
    }
  };

  const handleToggleEnabled = async (t: Task, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await tasksApi.update(channel.id, t.id, { enabled: !t.enabled });
      const { tasks } = await tasksApi.list(channel.id);
      dispatch({ type: "SET_TASKS", tasks });
    } catch (err) {
      console.error("Failed to toggle task:", err);
    }
  };

  const handleDeleteTask = async (t: Task, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Delete task "${t.name}"?`)) return;
    try {
      await tasksApi.delete(channel.id, t.id);
      const { tasks } = await tasksApi.list(channel.id);
      dispatch({ type: "SET_TASKS", tasks });
      if (state.selectedTaskId === t.id && tasks.length > 0) {
        dispatch({ type: "SELECT_TASK", taskId: tasks[0].id, sessionKey: tasks[0].sessionKey });
      }
    } catch (err) {
      console.error("Failed to delete task:", err);
    }
  };

  return (
    <>
      <div
        className="flex items-center gap-1 px-4 py-1.5 overflow-x-auto"
        style={{
          background: "var(--bg-surface)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {state.tasks.map((t) => (
          <div key={t.id} className="flex items-center group">
            <button
              onClick={() =>
                dispatch({
                  type: "SELECT_TASK",
                  taskId: t.id,
                  sessionKey: t.sessionKey ?? undefined,
                })
              }
              className={`flex items-center gap-1.5 px-3 py-1 text-caption rounded-lg whitespace-nowrap transition-colors ${
                state.selectedTaskId === t.id
                  ? "font-bold"
                  : "hover:bg-[--bg-hover]"
              }`}
              style={
                state.selectedTaskId === t.id
                  ? {
                      background: "var(--bg-hover)",
                      color: "var(--text-primary)",
                      boxShadow: "inset 0 -2px 0 var(--bg-active)",
                    }
                  : { color: "var(--text-secondary)" }
              }
            >
              {t.kind === "background" ? (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              )}
              {t.name}
              {t.kind === "background" && !t.enabled && (
                <span className="text-tiny" style={{ color: "var(--text-muted)" }}>(paused)</span>
              )}
              {t.kind === "background" && t.schedule && t.enabled && (
                <span className="text-tiny" style={{ color: "var(--text-muted)" }}>
                  {t.schedule}
                </span>
              )}
            </button>
            {/* Config and toggle buttons for background tasks */}
            {t.kind === "background" && state.selectedTaskId === t.id && (
              <div className="flex items-center gap-0.5 ml-0.5">
                <button
                  onClick={(e) => handleOpenConfig(t, e)}
                  title="Configure schedule"
                  className="p-1 rounded hover:bg-[--bg-hover] transition-colors"
                  style={{ color: "var(--text-muted)" }}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </button>
                <button
                  onClick={(e) => handleToggleEnabled(t, e)}
                  title={t.enabled ? "Pause task" : "Resume task"}
                  className="p-1 rounded hover:bg-[--bg-hover] transition-colors"
                  style={{ color: t.enabled ? "var(--accent-green)" : "var(--accent-yellow)" }}
                >
                  {t.enabled ? (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  ) : (
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  )}
                </button>
              </div>
            )}
          </div>
        ))}

        {/* Add task */}
        {showCreate ? (
          <div className="flex items-center gap-1 ml-1">
            <input
              type="text"
              placeholder="Task name"
              value={newTaskName}
              onChange={(e) => setNewTaskName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && handleCreate()}
              className="px-2 py-1 text-caption rounded-sm focus:outline-none w-36 placeholder:text-[--text-muted]"
              style={{
                background: "var(--bg-hover)",
                color: "var(--text-primary)",
                border: "1px solid var(--border)",
              }}
              autoFocus
            />
            <select
              value={newTaskKind}
              onChange={(e) => setNewTaskKind(e.target.value as "adhoc" | "background")}
              className="px-1 py-1 text-tiny rounded-sm"
              style={{
                background: "var(--bg-hover)",
                color: "var(--text-primary)",
                border: "1px solid var(--border)",
              }}
            >
              <option value="adhoc">Ad Hoc</option>
              <option value="background">Background</option>
            </select>
            <button
              onClick={handleCreate}
              className="px-2 py-1 text-tiny font-bold text-white rounded-sm"
              style={{ background: "var(--bg-active)" }}
            >
              Add
            </button>
            <button
              onClick={() => { setShowCreate(false); setNewTaskName(""); setNewSchedule(""); setNewInstructions(""); }}
              className="px-1 py-1 text-tiny"
              style={{ color: "var(--text-muted)" }}
            >
              x
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1 px-3 py-1 text-caption hover:bg-[--bg-hover] rounded-lg whitespace-nowrap transition-colors"
            style={{ color: "var(--text-muted)" }}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Add
          </button>
        )}
      </div>

      {/* Schedule config strip for new background task */}
      {showCreate && newTaskKind === "background" && (
        <div
          className="px-4 py-2 flex flex-wrap items-center gap-2"
          style={{ background: "var(--bg-surface)", borderBottom: "1px solid var(--border)" }}
        >
          <select
            value={SCHEDULE_PRESETS.find((p) => p.value === newSchedule) ? newSchedule : ""}
            onChange={(e) => setNewSchedule(e.target.value)}
            className="px-2 py-1 text-caption rounded-sm"
            style={{ background: "var(--bg-hover)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
          >
            <option value="" disabled>Schedule...</option>
            {SCHEDULE_PRESETS.map((p) => (
              <option key={p.value || "custom"} value={p.value}>{p.label}</option>
            ))}
          </select>
          {(!SCHEDULE_PRESETS.find((p) => p.value === newSchedule) || newSchedule === "") && (
            <input
              type="text"
              placeholder="e.g., every 6h or cron 0 */6 * * *"
              value={newSchedule}
              onChange={(e) => setNewSchedule(e.target.value)}
              className="px-2 py-1 text-caption rounded-sm focus:outline-none flex-1 min-w-[100px] placeholder:text-[--text-muted]"
              style={{ background: "var(--bg-hover)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
            />
          )}
          <input
            type="text"
            placeholder="Agent instructions per run..."
            value={newInstructions}
            onChange={(e) => setNewInstructions(e.target.value)}
            className="px-2 py-1 text-caption rounded-sm focus:outline-none flex-1 min-w-[100px] placeholder:text-[--text-muted]"
            style={{ background: "var(--bg-hover)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
          />
        </div>
      )}

      {/* Task config editor modal */}
      {editingTask && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={() => setEditingTask(null)}
        >
          <div
            className="rounded-lg p-5 w-[480px] max-w-[90vw]"
            style={{ background: "var(--bg-surface)", boxShadow: "var(--shadow-lg)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-h2 font-bold" style={{ color: "var(--text-primary)" }}>
                Configure: {editingTask.name}
              </h2>
              <button
                onClick={() => setEditingTask(null)}
                className="p-1 hover:bg-[--bg-hover] rounded"
                style={{ color: "var(--text-muted)" }}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="space-y-3">
              {/* Schedule */}
              <div>
                <label className="block text-caption font-bold mb-1" style={{ color: "var(--text-secondary)" }}>
                  Schedule
                </label>
                <select
                  value={SCHEDULE_PRESETS.find((p) => p.value === editSchedule) ? editSchedule : ""}
                  onChange={(e) => setEditSchedule(e.target.value)}
                  className="w-full px-3 py-2 text-body rounded-md mb-1"
                  style={{ background: "var(--bg-hover)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
                >
                  <option value="">Custom</option>
                  {SCHEDULE_PRESETS.filter((p) => p.value).map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="e.g., every 6h or cron 0 */6 * * *"
                  value={editSchedule}
                  onChange={(e) => setEditSchedule(e.target.value)}
                  className="w-full px-3 py-2 text-body rounded-md focus:outline-none placeholder:text-[--text-muted]"
                  style={{ background: "var(--bg-hover)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
                />
              </div>

              {/* Instructions */}
              <div>
                <label className="block text-caption font-bold mb-1" style={{ color: "var(--text-secondary)" }}>
                  Agent Instructions (per run)
                </label>
                <textarea
                  placeholder="What should the agent do each time this task runs?"
                  value={editInstructions}
                  onChange={(e) => setEditInstructions(e.target.value)}
                  rows={4}
                  className="w-full px-3 py-2 text-body rounded-md focus:outline-none resize-y placeholder:text-[--text-muted]"
                  style={{ background: "var(--bg-hover)", color: "var(--text-primary)", border: "1px solid var(--border)" }}
                />
              </div>

              {/* Enabled toggle */}
              <div className="flex items-center gap-3">
                <label className="text-caption font-bold" style={{ color: "var(--text-secondary)" }}>
                  Enabled
                </label>
                <button
                  onClick={() => setEditEnabled(!editEnabled)}
                  className="relative w-10 h-5 rounded-full transition-colors"
                  style={{ background: editEnabled ? "var(--accent-green)" : "var(--border)" }}
                >
                  <div
                    className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
                    style={{ left: editEnabled ? 20 : 2 }}
                  />
                </button>
                <span className="text-caption" style={{ color: "var(--text-muted)" }}>
                  {editEnabled ? "Running on schedule" : "Paused"}
                </span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between mt-5 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
              <button
                onClick={(e) => { handleDeleteTask(editingTask, e); setEditingTask(null); }}
                className="px-3 py-1.5 text-caption rounded-md hover:bg-[--bg-hover] transition-colors"
                style={{ color: "var(--accent-red)" }}
              >
                Delete task
              </button>
              <div className="flex gap-2">
                <button
                  onClick={() => setEditingTask(null)}
                  className="px-4 py-1.5 text-caption rounded-md hover:bg-[--bg-hover] transition-colors"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveConfig}
                  className="px-4 py-1.5 text-caption font-bold text-white rounded-md"
                  style={{ background: "var(--bg-active)" }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
