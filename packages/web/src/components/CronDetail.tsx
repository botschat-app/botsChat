import React, { useEffect, useCallback, useState, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Group, Panel, useDefaultLayout } from "react-resizable-panels";
import { useAppState, useAppDispatch } from "../store";
import { jobsApi, tasksApi } from "../api";
import { ModelSelect } from "./ModelSelect";
import { ScheduleEditor, ScheduleDisplay } from "./ScheduleEditor";
import { ResizeHandle } from "./ResizeHandle";
import { useIsMobile } from "../hooks/useIsMobile";
import { dlog } from "../debug-log";

function relativeTime(ts: number): string {
  const now = Date.now() / 1000;
  const diff = now - ts;
  if (diff < 0) return "in " + formatDuration(-diff);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

function statusLabel(status: string): string {
  switch (status) {
    case "ok": return "OK";
    case "error": return "ERR";
    case "skipped": return "SKIP";
    case "running": return "RUN";
    default: return status.toUpperCase();
  }
}

function statusColors(status: string): { bg: string; fg: string } {
  switch (status) {
    case "ok": return { bg: "rgba(43,172,118,0.15)", fg: "var(--accent-green)" };
    case "error": return { bg: "rgba(224,30,90,0.15)", fg: "var(--accent-red)" };
    case "running": return { bg: "rgba(29,155,209,0.15)", fg: "var(--text-link)" };
    default: return { bg: "rgba(232,162,48,0.15)", fg: "var(--accent-yellow)" };
  }
}

export function CronDetail() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const isMobile = useIsMobile();

  const task = state.cronTasks.find((t) => t.id === state.selectedCronTaskId);

  // Editing state
  const [editingField, setEditingField] = useState<"name" | "schedule" | "instructions" | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [running, setRunning] = useState(false);
  const [infoExpanded, setInfoExpanded] = useState(true);
  const editRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  // Reset edit state when task changes
  useEffect(() => {
    setEditingField(null);
    setShowDeleteConfirm(false);
  }, [state.selectedCronTaskId]);

  // Focus input when editing starts
  useEffect(() => {
    if (editingField && editRef.current) {
      editRef.current.focus();
    }
  }, [editingField]);

  // Load jobs when a cron task is selected
  const loadJobs = useCallback(() => {
    if (!task) return;
    dlog.info("Cron", `Loading jobs for task: ${task.name} (${task.id})`);
    jobsApi.listByTask(task.id).then(({ jobs }) => {
      dlog.info("Cron", `Loaded ${jobs.length} jobs for task ${task.name}`);
      // Preserve in-memory summaries (streaming data isn't persisted to D1).
      // Use the ref so we always get the latest data.
      const latestCronJobs = cronJobsRef.current;
      const cachedSummaries = new Map<string, string>();
      for (const j of latestCronJobs) {
        if (j.summary) {
          cachedSummaries.set(j.id, j.summary);
        }
      }
      const merged = jobs.map((j) => {
        const cached = cachedSummaries.get(j.id);
        if (cached && cached.length > (j.summary?.length || 0)) {
          return { ...j, summary: cached };
        }
        return j;
      });
      dispatch({ type: "SET_CRON_JOBS", cronJobs: merged });
      if (jobs.length > 0 && !state.selectedCronJobId) {
        dispatch({
          type: "SELECT_CRON_JOB",
          jobId: jobs[0].id,
          sessionKey: jobs[0].sessionKey,
        });
      }
    }).catch((err) => {
      dlog.error("Cron", `Failed to load jobs: ${err}`);
    });
  }, [task?.id]);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  // Keep a ref with the latest cronJobs to avoid stale closures in the
  // auto-refresh interval (which would overwrite fresh streaming summaries
  // with older data captured at effect-setup time).
  const cronJobsRef = useRef(state.cronJobs);
  useEffect(() => { cronJobsRef.current = state.cronJobs; }, [state.cronJobs]);

  // Auto-refresh while any job is in "running" state.
  // Preserve streaming summaries for running jobs (API returns empty summary
  // because job.output chunks are not persisted to D1).
  useEffect(() => {
    const hasRunning = state.cronJobs.some((j) => j.status === "running");
    if (!hasRunning || !task) return;
    const taskId = task.id;
    const timer = setInterval(() => {
      dlog.info("Cron", `Auto-refreshing jobs (running job detected)`);
      jobsApi.listByTask(taskId).then(({ jobs }) => {
        // Use the ref (always up-to-date) to get the latest streaming summaries
        const latestCronJobs = cronJobsRef.current;
        const runningSummaries = new Map<string, string>();
        for (const j of latestCronJobs) {
          if (j.summary) {
            runningSummaries.set(j.id, j.summary);
          }
        }
        // Merge: keep in-memory summary if it's longer than the API summary
        // (streaming data isn't persisted to D1)
        const merged = jobs.map((j) => {
          const cached = runningSummaries.get(j.id);
          if (cached && cached.length > (j.summary?.length || 0)) {
            return { ...j, summary: cached };
          }
          return j;
        });
        dispatch({ type: "SET_CRON_JOBS", cronJobs: merged });
      }).catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [state.cronJobs, task?.id]);


  const handleToggleEnabled = useCallback(async () => {
    if (!task) return;
    const newEnabled = !task.enabled;
    dlog.info("Cron", `Toggle task "${task.name}": ${task.enabled ? "enabled → disabled" : "disabled → enabled"}`);
    // Optimistic update
    dispatch({ type: "UPDATE_CRON_TASK", taskId: task.id, updates: { enabled: newEnabled } });
    try {
      // Send ALL OpenClaw-owned fields (schedule, instructions, enabled) together
      // since they are not stored in D1 — the API just passes them through to OpenClaw.
      await tasksApi.update(task.channelId, task.id, {
        schedule: task.schedule ?? "",
        instructions: task.instructions ?? "",
        enabled: newEnabled,
        model: task.model ?? "",
      });
    } catch (err) {
      dlog.error("Cron", `Failed to toggle task: ${err}`);
      // Revert optimistic update
      dispatch({ type: "UPDATE_CRON_TASK", taskId: task.id, updates: { enabled: task.enabled } });
    }
  }, [task]);

  const handleSelectJob = useCallback((jobId: string) => {
    const job = state.cronJobs.find((j) => j.id === jobId);
    if (job) {
      dlog.info("Cron", `Selected job #${job.number || jobId} (status=${job.status})`);
      dispatch({
        type: "SELECT_CRON_JOB",
        jobId: job.id,
        sessionKey: job.sessionKey || undefined,
      });
    }
  }, [state.cronJobs]);

  const startEdit = (field: "name" | "schedule" | "instructions") => {
    if (!task) return;
    const current = field === "name" ? task.name
      : field === "schedule" ? (task.schedule ?? "")
      : (task.instructions ?? "");
    setEditValue(current);
    setEditingField(field);
  };

  const handleModelSelectChange = useCallback(async (modelId: string) => {
    if (!task) return;
    dlog.info("Cron", `Change model for "${task.name}": → ${modelId || "default"}`);
    const oldModel = task.model;
    // Optimistic update
    dispatch({ type: "UPDATE_CRON_TASK", taskId: task.id, updates: { model: modelId || null } });
    try {
      // Send ALL OpenClaw-owned fields together
      await tasksApi.update(task.channelId, task.id, {
        schedule: task.schedule ?? "",
        instructions: task.instructions ?? "",
        enabled: task.enabled,
        model: modelId,
      });
    } catch (err) {
      dlog.error("Cron", `Failed to update task model: ${err}`);
      // Revert optimistic update
      dispatch({ type: "UPDATE_CRON_TASK", taskId: task.id, updates: { model: oldModel } });
    }
  }, [task]);

  const handleRunNow = useCallback(async () => {
    if (!task || running) return;
    dlog.info("Cron", `Triggering immediate run for "${task.name}"`);
    setRunning(true);
    try {
      await tasksApi.run(task.channelId, task.id);
      dlog.info("Cron", `Task "${task.name}" triggered successfully`);
      // The plugin will send job.update via WS with status "running"
      // which will be handled by ADD_CRON_JOB in the store.
      // Also do a one-time refresh after a short delay as fallback.
      setTimeout(() => {
        loadJobs();
      }, 1500);
    } catch (err) {
      dlog.error("Cron", `Failed to trigger task: ${err}`);
    } finally {
      setRunning(false);
    }
  }, [task, running, loadJobs]);

  const cancelEdit = () => {
    setEditingField(null);
    setEditValue("");
  };

  const saveEdit = async () => {
    if (!task || !editingField) return;
    dlog.info("Cron", `Save edit "${editingField}" for "${task.name}": ${editValue.length > 80 ? editValue.slice(0, 80) + "…" : editValue}`);
    setSaving(true);
    try {
      if (editingField === "name") {
        // Name is stored in D1 — update directly
        dispatch({ type: "UPDATE_CRON_TASK", taskId: task.id, updates: { name: editValue } });
        await tasksApi.update(task.channelId, task.id, { name: editValue });
      } else {
        // Schedule and instructions belong to OpenClaw — send ALL OpenClaw fields together.
        const updates: Partial<typeof task> = {
          [editingField]: editValue,
        };
        dispatch({ type: "UPDATE_CRON_TASK", taskId: task.id, updates });
        await tasksApi.update(task.channelId, task.id, {
          schedule: editingField === "schedule" ? editValue : (task.schedule ?? ""),
          instructions: editingField === "instructions" ? editValue : (task.instructions ?? ""),
          enabled: task.enabled,
          model: task.model ?? "",
        });
      }
      setEditingField(null);
    } catch (err) {
      dlog.error("Cron", `Failed to update task field "${editingField}": ${err}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!task) return;
    dlog.info("Cron", `Deleting task: "${task.name}" (${task.id})`);
    setDeleting(true);
    try {
      await tasksApi.delete(task.channelId, task.id);
      dlog.info("Cron", `Task deleted: "${task.name}"`);
      // Reload task list after deletion (D1 record is removed)
      const { tasks } = await tasksApi.listAll("background");
      dispatch({ type: "SET_CRON_TASKS", cronTasks: tasks });
      dispatch({ type: "SELECT_CRON_TASK", taskId: tasks.length > 0 ? tasks[0].id : null });
      setShowDeleteConfirm(false);
    } catch (err) {
      dlog.error("Cron", `Failed to delete task: ${err}`);
    } finally {
      setDeleting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") cancelEdit();
    if (e.key === "Enter" && !e.shiftKey && editingField !== "instructions") {
      e.preventDefault();
      saveEdit();
    }
  };

  if (!task) {
    return (
      <div className="flex-1 h-full flex items-center justify-center" style={{ background: "var(--bg-surface)" }}>
        <div className="text-center">
          <svg
            className="w-16 h-16 mx-auto mb-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1}
            style={{ color: "var(--text-muted)" }}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-body font-bold" style={{ color: "var(--text-muted)" }}>
            Select an automation
          </p>
          <p className="text-caption mt-1" style={{ color: "var(--text-muted)" }}>
            Choose a cron job from the sidebar to view details
          </p>
        </div>
      </div>
    );
  }

  // Find the channel for this task
  const channel = state.channels.find((c) => c.id === task.channelId);

  return (
    <div className="flex-1 h-full flex flex-col min-w-0" style={{ background: "var(--bg-surface)" }}>
      {/* ---- Header ---- */}
      <div
        className="flex flex-wrap items-center justify-between gap-2 px-4 sm:px-5 py-2 sm:py-3 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
          <svg
            className="w-5 h-5 flex-shrink-0 hidden sm:block"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
            style={{ color: "var(--text-secondary)" }}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>

          {editingField === "name" ? (
            <div className="flex items-center gap-2 min-w-0">
              <input
                ref={editRef as React.RefObject<HTMLInputElement>}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={handleKeyDown}
                className="text-h2 font-bold px-2 py-0.5 rounded-sm focus:outline-none min-w-0 w-full"
                style={{
                  background: "var(--bg-hover)",
                  color: "var(--text-primary)",
                  border: "1px solid var(--bg-active)",
                  maxWidth: 280,
                }}
              />
              <SaveCancelButtons saving={saving} onSave={saveEdit} onCancel={cancelEdit} />
            </div>
          ) : (
            <h2
              className="text-h2 font-bold truncate cursor-pointer hover:underline"
              style={{ color: "var(--text-primary)" }}
              onClick={() => startEdit("name")}
              title="Click to edit name"
            >
              {task.name}
            </h2>
          )}

          {!task.enabled && (
            <span
              className="text-tiny px-2 py-0.5 rounded-sm font-bold flex-shrink-0"
              style={{ background: "rgba(232,162,48,0.15)", color: "var(--accent-yellow)" }}
            >
              PAUSED
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
          {/* Run Now button */}
          <button
            onClick={handleRunNow}
            disabled={running}
            className="flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 text-caption rounded-sm transition-colors disabled:opacity-50"
            style={{
              background: "rgba(29,155,209,0.15)",
              color: "var(--text-link)",
            }}
            title="Run task now (one-time)"
          >
            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
            <span className="hidden sm:inline">{running ? "Running..." : "Run Now"}</span>
          </button>

          {/* Delete button */}
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="p-1 sm:p-1.5 rounded-sm transition-colors hover:bg-[--bg-hover]"
            style={{ color: "var(--text-muted)" }}
            title="Delete task"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
            </svg>
          </button>

          {/* Enable/Disable toggle */}
          <button
            onClick={handleToggleEnabled}
            className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1 sm:py-1.5 text-caption rounded-sm transition-colors"
            style={{
              background: task.enabled ? "rgba(43,172,118,0.15)" : "rgba(107,111,118,0.15)",
              color: task.enabled ? "var(--accent-green)" : "var(--text-muted)",
            }}
          >
            <div
              className="w-7 h-4 rounded-full relative transition-colors flex-shrink-0"
              style={{ background: task.enabled ? "var(--accent-green)" : "var(--text-muted)" }}
            >
              <div
                className="w-3 h-3 rounded-full bg-white absolute top-0.5 transition-all"
                style={{ left: task.enabled ? 14 : 2 }}
              />
            </div>
            <span className="hidden sm:inline">{task.enabled ? "Enabled" : "Disabled"}</span>
          </button>
        </div>
      </div>

      {/* ---- Delete confirmation ---- */}
      {showDeleteConfirm && (
        <div
          className="px-4 sm:px-5 py-2 sm:py-3 flex flex-wrap items-center justify-between gap-2"
          style={{ background: "rgba(224,30,90,0.08)", borderBottom: "1px solid var(--border)" }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} style={{ color: "var(--accent-red)" }}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
            <span className="text-caption" style={{ color: "var(--accent-red)" }}>
              Delete "{task.name}"?
            </span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-3 py-1.5 text-caption font-bold text-white rounded-sm disabled:opacity-50"
              style={{ background: "var(--accent-red)" }}
            >
              {deleting ? "Deleting..." : "Delete"}
            </button>
            <button
              onClick={() => setShowDeleteConfirm(false)}
              className="px-3 py-1.5 text-caption rounded-sm"
              style={{ color: "var(--text-muted)" }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ---- Info section + Content area: vertically resizable on desktop, stacked on mobile ---- */}
      <CronInfoAndContent
        task={task}
        channel={channel}
        state={state}
        isMobile={isMobile}
        infoExpanded={infoExpanded}
        setInfoExpanded={setInfoExpanded}
        editingField={editingField}
        editValue={editValue}
        setEditValue={setEditValue}
        editRef={editRef}
        handleKeyDown={handleKeyDown}
        saving={saving}
        saveEdit={saveEdit}
        cancelEdit={cancelEdit}
        startEdit={startEdit}
        handleModelSelectChange={handleModelSelectChange}
        handleSelectJob={handleSelectJob}
      />
    </div>
  );
}

// ---- Info section + Content area (vertical resizable split) ----

function CronInfoAndContent({
  task,
  channel,
  state,
  isMobile,
  infoExpanded,
  setInfoExpanded,
  editingField,
  editValue,
  setEditValue,
  editRef,
  handleKeyDown,
  saving,
  saveEdit,
  cancelEdit,
  startEdit,
  handleModelSelectChange,
  handleSelectJob,
}: {
  task: any;
  channel: any;
  state: any;
  isMobile: boolean;
  infoExpanded: boolean;
  setInfoExpanded: (v: boolean) => void;
  editingField: "name" | "schedule" | "instructions" | null;
  editValue: string;
  setEditValue: (v: string) => void;
  editRef: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  saving: boolean;
  saveEdit: () => void;
  cancelEdit: () => void;
  startEdit: (field: "name" | "schedule" | "instructions") => void;
  handleModelSelectChange: (modelId: string) => Promise<void>;
  handleSelectJob: (jobId: string) => void;
}) {
  const cronDetailVertLayout = useDefaultLayout({ id: "botschat-cron-detail-v" });

  // Mobile drag-to-resize state
  const [mobileInfoPct, setMobileInfoPct] = useState(40);
  const mobileContainerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ startY: 0, startPct: 40 });

  const onDragHandleTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    dragRef.current.startY = e.touches[0].clientY;
    dragRef.current.startPct = mobileInfoPct;
    const onMove = (ev: TouchEvent) => {
      ev.preventDefault();
      if (!mobileContainerRef.current) return;
      const h = mobileContainerRef.current.getBoundingClientRect().height;
      const delta = ((ev.touches[0].clientY - dragRef.current.startY) / h) * 100;
      setMobileInfoPct(Math.max(10, Math.min(70, dragRef.current.startPct + delta)));
    };
    const onEnd = () => {
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
    };
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
  }, [mobileInfoPct]);

  const onDragHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current.startY = e.clientY;
    dragRef.current.startPct = mobileInfoPct;
    const onMove = (ev: MouseEvent) => {
      if (!mobileContainerRef.current) return;
      const h = mobileContainerRef.current.getBoundingClientRect().height;
      const delta = ((ev.clientY - dragRef.current.startY) / h) * 100;
      setMobileInfoPct(Math.max(10, Math.min(70, dragRef.current.startPct + delta)));
    };
    const onEnd = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onEnd);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onEnd);
  }, [mobileInfoPct]);

  // Shared info section content
  const infoSection = (
    <div className="h-full flex flex-col">
      <button
        className="w-full flex items-center gap-2 px-4 sm:px-5 py-2 text-tiny uppercase tracking-wider hover:bg-[--bg-hover] transition-colors flex-shrink-0"
        style={{ color: "var(--text-muted)" }}
        onClick={() => setInfoExpanded(!infoExpanded)}
      >
        <svg
          className={`w-3 h-3 transition-transform ${infoExpanded ? "rotate-0" : "-rotate-90"}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
        Task Details
      </button>

      {infoExpanded && (
        <div className="flex-1 overflow-y-auto px-4 sm:px-5 pb-4 space-y-4">
          {/* Row 1: Schedule (wider) + Model + Channel + Status */}
          {editingField === "schedule" ? (
            <div>
              <InfoField label="Schedule">
                <ScheduleEditor
                  value={editValue}
                  onChange={setEditValue}
                  onSave={saveEdit}
                  onCancel={cancelEdit}
                  saving={saving}
                />
              </InfoField>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
              <InfoField label="Schedule">
                <ScheduleDisplay
                  schedule={task.schedule}
                  onClick={() => startEdit("schedule")}
                />
              </InfoField>

              <InfoField label="Model">
                <ModelSelect
                  value={task.model ?? ""}
                  onChange={handleModelSelectChange}
                  models={state.models}
                  placeholder="Default"
                />
              </InfoField>

              <InfoField label="Channel">
                <span className="text-body" style={{ color: "var(--text-primary)" }}>
                  {channel?.name ?? "Default"}
                </span>
              </InfoField>

              <InfoField label="Status">
                <div className="flex items-center gap-2">
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ background: task.enabled ? "var(--accent-green)" : "var(--accent-yellow)" }}
                  />
                  <span className="text-body" style={{ color: "var(--text-primary)" }}>
                    {task.enabled ? "Active" : "Paused"}
                  </span>
                </div>
              </InfoField>
            </div>
          )}

          {/* Row 2: Cron Job ID + Created + Updated */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
            <InfoField label="Cron Job ID">
              <span className="text-caption font-mono" style={{ color: "var(--text-secondary)" }}>
                {task.providerJobId ?? "N/A"}
              </span>
            </InfoField>

            <InfoField label="Created">
              <span className="text-caption" style={{ color: "var(--text-secondary)" }}>
                {task.createdAt ? formatTimestamp(task.createdAt) : "N/A"}
              </span>
            </InfoField>

            <InfoField label="Updated">
              <span className="text-caption" style={{ color: "var(--text-secondary)" }}>
                {task.updatedAt ? formatTimestamp(task.updatedAt) : "N/A"}
              </span>
            </InfoField>
          </div>

          {/* Row 3: Prompt / Instructions (full width) */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-tiny uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                Prompt / Instructions
              </span>
              {editingField !== "instructions" && (
                <button
                  onClick={() => startEdit("instructions")}
                  className="text-tiny px-2 py-0.5 rounded-sm transition-colors hover:bg-[--bg-hover]"
                  style={{ color: "var(--text-link)" }}
                >
                  Edit
                </button>
              )}
            </div>

            {editingField === "instructions" ? (
              <div>
                <textarea
                  ref={editRef as React.RefObject<HTMLTextAreaElement>}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") cancelEdit();
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      saveEdit();
                    }
                  }}
                  placeholder="Enter the prompt or instructions for this cron task..."
                  rows={6}
                  className="w-full text-caption p-3 rounded-md resize-y focus:outline-none"
                  style={{
                    background: "var(--bg-hover)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--bg-active)",
                    minHeight: 80,
                    maxHeight: 300,
                  }}
                />
                <div className="flex items-center justify-between mt-2">
                  <span className="text-tiny" style={{ color: "var(--text-muted)" }}>
                    Cmd/Ctrl+Enter to save, Esc to cancel
                  </span>
                  <SaveCancelButtons saving={saving} onSave={saveEdit} onCancel={cancelEdit} />
                </div>
              </div>
            ) : (
              <div
                className="text-caption p-3 rounded-md whitespace-pre-wrap cursor-pointer hover:border-[--text-muted] transition-colors"
                style={{
                  background: "var(--bg-hover)",
                  color: task.instructions ? "var(--text-primary)" : "var(--text-muted)",
                  border: "1px solid transparent",
                  minHeight: 48,
                }}
                onClick={() => startEdit("instructions")}
                title="Click to edit"
              >
                {task.instructions || "No instructions set. Click to add a prompt for this cron task."}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );

  // Mobile: vertical stack with draggable divider between info and content
  if (isMobile) {
    return (
      <div ref={mobileContainerRef} className="flex-1 min-h-0 flex flex-col">
        {/* Info section — draggable height when expanded, auto when collapsed */}
        <div
          className="flex-shrink-0 overflow-y-auto"
          style={{
            ...(infoExpanded ? { height: `${mobileInfoPct}%` } : {}),
            borderBottom: "1px solid var(--border)",
          }}
        >
          {infoSection}
        </div>
        {/* Drag handle — only shown when info section is expanded */}
        {infoExpanded && (
          <div
            className="flex-shrink-0 flex items-center justify-center touch-none select-none"
            style={{
              height: 20,
              cursor: "row-resize",
              background: "var(--bg-surface)",
              borderBottom: "1px solid var(--border)",
            }}
            onTouchStart={onDragHandleTouchStart}
            onMouseDown={onDragHandleMouseDown}
          >
            <div
              className="rounded-full"
              style={{
                width: 36,
                height: 4,
                background: "var(--text-muted)",
                opacity: 0.4,
              }}
            />
          </div>
        )}
        {/* History + output — takes remaining space */}
        <CronContentPanels cronJobs={state.cronJobs} selectedCronJobId={state.selectedCronJobId} handleSelectJob={handleSelectJob} mobile />
      </div>
    );
  }

  // Desktop: vertical resizable split between info and content
  return (
    <Group
      orientation="vertical"
      defaultLayout={cronDetailVertLayout.defaultLayout}
      onLayoutChanged={cronDetailVertLayout.onLayoutChanged}
      id="botschat-cron-detail-v"
      className="flex-1 min-h-0"
    >
      {/* Info section panel */}
      <Panel id="cron-info" defaultSize="40%" minSize="5%" maxSize="70%">
        <div className="h-full" style={{ borderBottom: "1px solid var(--border)" }}>
          {infoSection}
        </div>
      </Panel>

      <ResizeHandle direction="vertical" />

      {/* Content area panel (job history + output) */}
      <Panel id="cron-content-area">
        <CronContentPanels cronJobs={state.cronJobs} selectedCronJobId={state.selectedCronJobId} handleSelectJob={handleSelectJob} mobile={false} />
      </Panel>
    </Group>
  );
}

// ---- Cron content panels (split component for hook usage) ----

function CronContentPanels({
  cronJobs,
  selectedCronJobId,
  handleSelectJob,
  mobile,
}: {
  cronJobs: Array<{ id: string; number: number; status: string; startedAt: number; finishedAt: number | null; durationMs: number | null; summary: string; time: string; sessionKey?: string }>;
  selectedCronJobId: string | null;
  handleSelectJob: (jobId: string) => void;
  mobile: boolean;
}) {
  const cronLayout = useDefaultLayout({ id: "botschat-cron-content" });
  const [mobileShowOutput, setMobileShowOutput] = useState(false);

  // On mobile, tapping a job → show output; navigate back to list via header
  const handleMobileSelectJob = (jobId: string) => {
    handleSelectJob(jobId);
    setMobileShowOutput(true);
  };

  // --- Shared job list content ---
  const jobListContent = (
    <div className="overflow-y-auto h-full">
      <div className="px-3 py-2" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="text-tiny uppercase tracking-wider font-bold" style={{ color: "var(--text-muted)" }}>
          Execution History
        </span>
        <span className="text-tiny ml-1" style={{ color: "var(--text-muted)" }}>
          ({cronJobs.length})
        </span>
      </div>
      {cronJobs.length === 0 ? (
        <div className="px-4 py-6 text-center">
          <p className="text-tiny" style={{ color: "var(--text-muted)" }}>
            No runs yet.
          </p>
          <p className="text-tiny mt-1" style={{ color: "var(--text-muted)" }}>
            Waiting for schedule...
          </p>
        </div>
      ) : (
        cronJobs.map((job, idx) => {
          const colors = statusColors(job.status);
          const displayNum = job.number || cronJobs.length - idx;
          const isSelected = selectedCronJobId === job.id;
          return (
            <button
              key={job.id}
              onClick={() => mobile ? handleMobileSelectJob(job.id) : handleSelectJob(job.id)}
              className={`w-full text-left px-3 py-2 hover:bg-[--bg-hover] transition-colors ${
                isSelected ? "bg-[--bg-hover]" : ""
              }`}
              style={{
                borderBottom: "1px solid var(--border)",
                ...(isSelected ? { borderLeft: "3px solid var(--bg-active)" } : {}),
              }}
            >
              <div className="flex items-center justify-between">
                <span className="text-tiny font-mono" style={{ color: "var(--text-muted)" }}>
                  #{displayNum}
                </span>
                <span
                  className="text-tiny px-1.5 py-0.5 rounded-sm font-bold flex items-center gap-1"
                  style={{ background: colors.bg, color: colors.fg }}
                >
                  {job.status === "running" && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--text-link)" }} />
                  )}
                  {statusLabel(job.status)}
                </span>
              </div>
              <div className="text-tiny mt-0.5" style={{ color: "var(--text-muted)" }}>
                {job.time}
                {job.durationMs != null && (
                  <span className="ml-1">({(job.durationMs / 1000).toFixed(1)}s)</span>
                )}
              </div>
              {job.summary && (
                <div className="text-caption mt-1 truncate" style={{ color: "var(--text-secondary)" }}>
                  {job.summary}
                </div>
              )}
            </button>
          );
        })
      )}
    </div>
  );

  // --- Mobile: stack-based navigation (list ↔ output) ---
  if (mobile) {
    if (mobileShowOutput && selectedCronJobId) {
      return (
        <div className="flex-1 flex flex-col min-h-0">
          {/* Back to list */}
          <button
            onClick={() => setMobileShowOutput(false)}
            className="flex items-center gap-1 px-4 py-2 text-caption flex-shrink-0"
            style={{ borderBottom: "1px solid var(--border)", color: "var(--text-link)" }}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            Back to History
          </button>
          <div className="flex-1 min-h-0">
            <JobOutputPanel jobs={cronJobs} selectedJobId={selectedCronJobId} />
          </div>
        </div>
      );
    }
    return <div className="flex-1 min-h-0">{jobListContent}</div>;
  }

  // --- Desktop: resizable horizontal panels ---
  return (
    <Group
      orientation="horizontal"
      defaultLayout={cronLayout.defaultLayout}
      onLayoutChanged={cronLayout.onLayoutChanged}
      id="botschat-cron-content"
      className="flex-1 min-h-0"
    >
      {/* Job list panel */}
      <Panel id="cron-jobs" defaultSize="20%" minSize="8%" maxSize="40%">
        {jobListContent}
      </Panel>

      <ResizeHandle />

      {/* Job output detail */}
      <Panel id="cron-output">
        <JobOutputPanel jobs={cronJobs} selectedJobId={selectedCronJobId} />
      </Panel>
    </Group>
  );
}

// ---- Job output panel ----

// Shared prose styles for markdown rendering
const PROSE_CLASSES = `prose prose-sm max-w-none
  prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5
  prose-pre:my-2 prose-pre:rounded-md prose-pre:text-caption
  prose-code:before:content-none prose-code:after:content-none
  prose-code:px-1 prose-code:py-0.5 prose-code:rounded-sm prose-code:text-caption
  prose-table:my-2 prose-th:px-3 prose-th:py-1.5 prose-td:px-3 prose-td:py-1.5
  prose-h1:text-lg prose-h2:text-base prose-h3:text-sm
  prose-li:my-0.5
  prose-blockquote:border-l-2 prose-blockquote:pl-4 prose-blockquote:my-2
  prose-hr:my-4`;

const PROSE_STYLE: React.CSSProperties = {
  color: "var(--text-primary)",
  "--tw-prose-headings": "var(--text-primary)",
  "--tw-prose-bold": "var(--text-primary)",
  "--tw-prose-links": "var(--text-link)",
  "--tw-prose-code": "var(--text-primary)",
  "--tw-prose-pre-code": "var(--text-primary)",
  "--tw-prose-pre-bg": "var(--code-bg)",
  "--tw-prose-th-borders": "var(--border)",
  "--tw-prose-td-borders": "var(--border)",
  "--tw-prose-quotes": "var(--text-secondary)",
  "--tw-prose-quote-borders": "var(--border)",
  "--tw-prose-bullets": "var(--text-muted)",
  "--tw-prose-counters": "var(--text-muted)",
  "--tw-prose-hr": "var(--border)",
} as React.CSSProperties;

/** Split streaming output by the --- separator into message blocks */
function parseMessageBlocks(summary: string): string[] {
  return summary.split(/\n\n---\n\n/).filter((b) => b.trim());
}

function JobOutputPanel({
  jobs,
  selectedJobId,
}: {
  jobs: Array<{ id: string; number: number; status: string; startedAt: number; finishedAt: number | null; durationMs: number | null; summary: string; time: string }>;
  selectedJobId: string | null;
}) {
  const job = selectedJobId ? jobs.find((j) => j.id === selectedJobId) : null;
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when streaming output updates
  useEffect(() => {
    if (scrollRef.current && job?.status === "running") {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [job?.summary, job?.status]);

  if (!job) {
    return (
      <div className="flex-1 h-full flex items-center justify-center" style={{ background: "var(--bg-surface)" }}>
        <p className="text-caption" style={{ color: "var(--text-muted)" }}>
          {jobs.length > 0 ? "Select a run to view output" : "No execution history yet"}
        </p>
      </div>
    );
  }

  const colors = statusColors(job.status);
  const isRunning = job.status === "running";
  const blocks = job.summary ? parseMessageBlocks(job.summary) : [];

  return (
    <div className="flex-1 h-full flex flex-col min-w-0" style={{ background: "var(--bg-surface)" }}>
      {/* Job header bar */}
      <div
        className="flex items-center gap-3 px-5 py-2.5 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        <span
          className="text-tiny px-2 py-0.5 rounded-sm font-bold"
          style={{ background: colors.bg, color: colors.fg }}
        >
          {statusLabel(job.status)}
        </span>
        {isRunning && (
          <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ background: "var(--text-link)" }} />
        )}
        <span className="text-caption" style={{ color: "var(--text-secondary)" }}>
          {job.time}
        </span>
        {job.durationMs != null && (
          <span className="text-caption" style={{ color: "var(--text-muted)" }}>
            {job.durationMs >= 60000
              ? `${(job.durationMs / 60000).toFixed(1)}m`
              : `${(job.durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
      </div>

      {/* Output content */}
      <div className="flex-1 overflow-y-auto px-5 py-4" ref={scrollRef}>
        {blocks.length > 0 ? (
          /* Stacked message cards */
          <div className="flex flex-col gap-3">
            {blocks.map((block, idx) => {
              const isLast = idx === blocks.length - 1;
              const isStreaming = isRunning && isLast;
              return (
                <div
                  key={idx}
                  className="rounded-md px-4 py-3"
                  style={{
                    background: "var(--bg-primary)",
                    border: isStreaming
                      ? "1px solid var(--text-link)"
                      : "1px solid var(--border)",
                  }}
                >
                  {/* Card header: message number + streaming indicator */}
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className="text-tiny font-bold px-1.5 py-0.5 rounded-sm"
                      style={{
                        background: isStreaming ? "var(--text-link)" : "var(--bg-surface)",
                        color: isStreaming ? "#fff" : "var(--text-muted)",
                      }}
                    >
                      {blocks.length > 1 ? `#${idx + 1}` : "Output"}
                    </span>
                    {isStreaming && (
                      <div className="flex items-center gap-1">
                        <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--text-link)" }} />
                        <span className="text-tiny" style={{ color: "var(--text-link)" }}>streaming...</span>
                      </div>
                    )}
                    {!isStreaming && !isRunning && blocks.length > 1 && (
                      <span className="text-tiny" style={{ color: "var(--text-muted)" }}>completed</span>
                    )}
                  </div>
                  {/* Card body: rendered markdown */}
                  <div className={PROSE_CLASSES} style={PROSE_STYLE}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{block}</ReactMarkdown>
                  </div>
                </div>
              );
            })}
            {/* Typing indicator after last card while running */}
            {isRunning && (
              <div className="flex items-center gap-1.5 pl-2">
                <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--text-link)" }} />
                <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--text-link)", animationDelay: "0.2s" }} />
                <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--text-link)", animationDelay: "0.4s" }} />
              </div>
            )}
          </div>
        ) : isRunning ? (
          /* Running but no output yet — just typing dots, header already shows RUN status */
          <div className="flex items-center gap-1.5 py-2 pl-1">
            <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--text-link)" }} />
            <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--text-link)", animationDelay: "0.2s" }} />
            <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--text-link)", animationDelay: "0.4s" }} />
          </div>
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-caption" style={{ color: "var(--text-muted)" }}>
              No output recorded for this run.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Reusable sub-components ----

function InfoField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-tiny uppercase tracking-wider mb-1" style={{ color: "var(--text-muted)" }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function EditableValue({ value, empty, onClick }: { value: string; empty?: boolean; onClick: () => void }) {
  return (
    <span
      className="text-body cursor-pointer hover:underline"
      style={{ color: empty ? "var(--text-muted)" : "var(--text-primary)" }}
      onClick={onClick}
      title="Click to edit"
    >
      {value}
    </span>
  );
}

function SaveCancelButtons({
  saving,
  onSave,
  onCancel,
}: {
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-1 flex-shrink-0">
      <button
        onClick={onSave}
        disabled={saving}
        className="px-2 py-1 text-tiny font-bold text-white rounded-sm disabled:opacity-50"
        style={{ background: "var(--bg-active)" }}
      >
        {saving ? "..." : "Save"}
      </button>
      <button
        onClick={onCancel}
        className="px-2 py-1 text-tiny rounded-sm"
        style={{ color: "var(--text-muted)" }}
      >
        Cancel
      </button>
    </div>
  );
}
