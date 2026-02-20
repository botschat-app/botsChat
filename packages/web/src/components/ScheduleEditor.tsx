import React, { useState, useEffect, useCallback } from "react";

// ---------------------------------------------------------------------------
// OpenClaw CronService uses structured schedules:
//   { kind: "every", everyMs: number }    → interval-based
//   { kind: "at",    at: string }         → fixed daily time
//
// The string format stored in D1 and sent to OpenClaw:
//   "every 30m", "every 2h", "every 10s"
//   "at 09:00", "at 14:30"
// ---------------------------------------------------------------------------

type ScheduleKind = "every" | "at" | "cron";
type IntervalUnit = "s" | "m" | "h";

interface ParsedSchedule {
  kind: ScheduleKind;
  // "every" fields
  intervalValue?: number;
  intervalUnit?: IntervalUnit;
  // "at" fields
  atTime?: string; // HH:MM
  // "cron" fields
  cronExpr?: string; // e.g. "0 8 * * *"
}

/** Parse a human-readable schedule string into structured parts */
function parseSchedule(raw: string): ParsedSchedule | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();

  // Match "every Xh", "every Xm", "every Xs"
  const everyMatch = s.match(/^every\s+(\d+(?:\.\d+)?)\s*(s|m|h)$/);
  if (everyMatch) {
    return {
      kind: "every",
      intervalValue: parseFloat(everyMatch[1]),
      intervalUnit: everyMatch[2] as IntervalUnit,
    };
  }

  // Match "at HH:MM"
  const atMatch = s.match(/^at\s+(\d{1,2}:\d{2})$/);
  if (atMatch) {
    return {
      kind: "at",
      atTime: atMatch[1].padStart(5, "0"), // ensure "9:00" → "09:00"
    };
  }

  // Match "cron <5-field expression>"
  const cronMatch = raw.trim().match(/^cron\s+(.+)$/i);
  if (cronMatch) {
    return {
      kind: "cron",
      cronExpr: cronMatch[1].trim(),
    };
  }

  return null;
}

/** Build a schedule string from structured parts */
function buildSchedule(parsed: ParsedSchedule): string {
  if (parsed.kind === "every" && parsed.intervalValue && parsed.intervalUnit) {
    return `every ${parsed.intervalValue}${parsed.intervalUnit}`;
  }
  if (parsed.kind === "at" && parsed.atTime) {
    return `at ${parsed.atTime}`;
  }
  if (parsed.kind === "cron" && parsed.cronExpr) {
    return `cron ${parsed.cronExpr}`;
  }
  return "";
}

/** Convert a 5-field cron expression to a human-readable description */
function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return expr;

  const [min, hour, dom, mon, dow] = parts;

  // "0 9 * * *" → "Daily at 09:00"
  if (dom === "*" && mon === "*" && dow === "*" && !min.includes(",") && !hour.includes(",")) {
    const h = hour.padStart(2, "0");
    const m = min.padStart(2, "0");
    return `Daily at ${h}:${m}`;
  }

  // "0 9,18 * * *" → "Daily at 09:00, 18:00"
  if (dom === "*" && mon === "*" && dow === "*" && hour.includes(",")) {
    const times = hour.split(",").map((h) => `${h.padStart(2, "0")}:${min.padStart(2, "0")}`);
    return `Daily at ${times.join(", ")}`;
  }

  // "0 9 * * 1" → "Mon at 09:00"
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (dom === "*" && mon === "*" && /^\d$/.test(dow)) {
    const dayName = dayNames[parseInt(dow)] ?? dow;
    return `${dayName} at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  }

  return expr;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type ScheduleEditorProps = {
  value: string;
  onChange: (schedule: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving?: boolean;
};

export function ScheduleEditor({
  value,
  onChange,
  onSave,
  onCancel,
  saving,
}: ScheduleEditorProps) {
  const parsed = parseSchedule(value);

  const [kind, setKind] = useState<ScheduleKind>(parsed?.kind ?? "every");
  const [intervalValue, setIntervalValue] = useState<number>(parsed?.intervalValue ?? 1);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>(parsed?.intervalUnit ?? "h");
  const [atTime, setAtTime] = useState<string>(parsed?.atTime ?? "09:00");
  const [cronExpr, setCronExpr] = useState<string>(parsed?.cronExpr ?? "0 9 * * *");

  // Re-sync when external value changes
  useEffect(() => {
    const p = parseSchedule(value);
    if (p) {
      setKind(p.kind);
      if (p.kind === "every") {
        setIntervalValue(p.intervalValue ?? 1);
        setIntervalUnit(p.intervalUnit ?? "h");
      } else if (p.kind === "at") {
        setAtTime(p.atTime ?? "09:00");
      } else if (p.kind === "cron") {
        setCronExpr(p.cronExpr ?? "0 9 * * *");
      }
    }
  }, [value]);

  // Emit the schedule string whenever fields change
  const emitChange = useCallback(
    (k: ScheduleKind, iv: number, iu: IntervalUnit, at: string, cron: string) => {
      const schedule = buildSchedule(
        k === "every"
          ? { kind: "every", intervalValue: iv, intervalUnit: iu }
          : k === "cron"
          ? { kind: "cron", cronExpr: cron }
          : { kind: "at", atTime: at },
      );
      onChange(schedule);
    },
    [onChange],
  );

  const handleKindChange = (k: ScheduleKind) => {
    setKind(k);
    emitChange(k, intervalValue, intervalUnit, atTime, cronExpr);
  };

  const handleIntervalValueChange = (v: number) => {
    const clamped = Math.max(1, Math.min(v, 999));
    setIntervalValue(clamped);
    emitChange(kind, clamped, intervalUnit, atTime, cronExpr);
  };

  const handleIntervalUnitChange = (u: IntervalUnit) => {
    setIntervalUnit(u);
    emitChange(kind, intervalValue, u, atTime, cronExpr);
  };

  const handleAtTimeChange = (t: string) => {
    setAtTime(t);
    emitChange(kind, intervalValue, intervalUnit, t, cronExpr);
  };

  const handleCronExprChange = (expr: string) => {
    setCronExpr(expr);
    emitChange(kind, intervalValue, intervalUnit, atTime, expr);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onCancel();
    if (e.key === "Enter") {
      e.preventDefault();
      onSave();
    }
  };

  return (
    <div className="flex flex-col gap-2" onKeyDown={handleKeyDown}>
      {/* Row 1: Kind selector tabs */}
      <div className="flex items-center gap-1">
        <KindTab
          active={kind === "every"}
          onClick={() => handleKindChange("every")}
          label="Interval"
          icon={
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
            </svg>
          }
        />
        <KindTab
          active={kind === "at"}
          onClick={() => handleKindChange("at")}
          label="Daily at"
          icon={
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <KindTab
          active={kind === "cron"}
          onClick={() => handleKindChange("cron")}
          label="Cron"
          icon={
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
            </svg>
          }
        />
      </div>

      {/* Row 2: Schedule-specific inputs */}
      <div className="flex items-center gap-2">
        {kind === "every" ? (
          <>
            <span className="text-caption flex-shrink-0" style={{ color: "var(--text-muted)" }}>
              Every
            </span>
            <input
              type="number"
              min={1}
              max={999}
              value={intervalValue}
              onChange={(e) => handleIntervalValueChange(parseInt(e.target.value, 10) || 1)}
              className="text-body px-2 py-1 rounded-sm focus:outline-none w-16 text-center"
              style={{
                background: "var(--bg-hover)",
                color: "var(--text-primary)",
                border: "1px solid var(--bg-active)",
              }}
              autoFocus
            />
            <div className="flex items-center gap-0.5">
              <UnitButton
                active={intervalUnit === "m"}
                onClick={() => handleIntervalUnitChange("m")}
                label="min"
              />
              <UnitButton
                active={intervalUnit === "h"}
                onClick={() => handleIntervalUnitChange("h")}
                label="hr"
              />
              <UnitButton
                active={intervalUnit === "s"}
                onClick={() => handleIntervalUnitChange("s")}
                label="sec"
              />
            </div>
          </>
        ) : kind === "cron" ? (
          <>
            <input
              type="text"
              value={cronExpr}
              onChange={(e) => handleCronExprChange(e.target.value)}
              placeholder="0 9 * * *"
              className="text-body font-mono px-2 py-1 rounded-sm focus:outline-none flex-1 min-w-[140px]"
              style={{
                background: "var(--bg-hover)",
                color: "var(--text-primary)",
                border: "1px solid var(--bg-active)",
              }}
              autoFocus
            />
          </>
        ) : (
          <>
            <span className="text-caption flex-shrink-0" style={{ color: "var(--text-muted)" }}>
              Daily at
            </span>
            <input
              type="time"
              value={atTime}
              onChange={(e) => handleAtTimeChange(e.target.value)}
              className="text-body px-2 py-1 rounded-sm focus:outline-none"
              style={{
                background: "var(--bg-hover)",
                color: "var(--text-primary)",
                border: "1px solid var(--bg-active)",
              }}
              autoFocus
            />
          </>
        )}

        {/* Save / Cancel */}
        <div className="flex items-center gap-1 ml-auto flex-shrink-0">
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
      </div>

      {/* Preview */}
      <div className="text-tiny" style={{ color: "var(--text-muted)" }}>
        {kind === "every"
          ? `Runs every ${intervalValue} ${intervalUnit === "h" ? "hour" : intervalUnit === "m" ? "minute" : "second"}${intervalValue !== 1 ? "s" : ""}`
          : kind === "cron"
          ? `Runs: ${describeCron(cronExpr)}`
          : `Runs daily at ${atTime}`}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Display-only component: shows schedule in a readable format
// ---------------------------------------------------------------------------

export function ScheduleDisplay({
  schedule,
  onClick,
}: {
  schedule: string | null;
  onClick: () => void;
}) {
  if (!schedule) {
    return (
      <span
        className="text-body cursor-pointer hover:underline"
        style={{ color: "var(--text-muted)" }}
        onClick={onClick}
        title="Click to set schedule"
      >
        Not set
      </span>
    );
  }

  const parsed = parseSchedule(schedule);

  if (!parsed) {
    // Unrecognised format — show raw string, let user fix
    return (
      <span
        className="text-body cursor-pointer hover:underline"
        style={{ color: "var(--text-primary)" }}
        onClick={onClick}
        title="Click to edit schedule"
      >
        {schedule}
      </span>
    );
  }

  const iconByKind: Record<ScheduleKind, React.ReactNode> = {
    every: (
      <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} style={{ color: "var(--text-muted)" }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
      </svg>
    ),
    at: (
      <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} style={{ color: "var(--text-muted)" }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
    cron: (
      <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} style={{ color: "var(--text-muted)" }}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5" />
      </svg>
    ),
  };

  const labelByKind: Record<ScheduleKind, string> = {
    every: `Every ${parsed.intervalValue}${parsed.intervalUnit === "h" ? "h" : parsed.intervalUnit === "m" ? "m" : "s"}`,
    at: `Daily at ${parsed.atTime}`,
    cron: describeCron(parsed.cronExpr ?? ""),
  };

  return (
    <button
      className="flex items-center gap-1.5 cursor-pointer group"
      onClick={onClick}
      title="Click to edit schedule"
    >
      {iconByKind[parsed.kind]}
      <span
        className="text-body group-hover:underline"
        style={{ color: "var(--text-primary)" }}
      >
        {labelByKind[parsed.kind]}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function KindTab({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-2.5 py-1 text-caption rounded-sm transition-colors"
      style={{
        background: active ? "rgba(29,155,209,0.15)" : "transparent",
        color: active ? "var(--text-link)" : "var(--text-muted)",
        border: active ? "1px solid rgba(29,155,209,0.3)" : "1px solid transparent",
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function UnitButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className="px-2 py-1 text-caption rounded-sm transition-colors"
      style={{
        background: active ? "var(--bg-active)" : "var(--bg-hover)",
        color: active ? "#fff" : "var(--text-secondary)",
        border: active ? "1px solid var(--bg-active)" : "1px solid var(--border)",
      }}
    >
      {label}
    </button>
  );
}
