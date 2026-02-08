import React from "react";
import type { Job } from "../api";

type JobListProps = {
  jobs: Job[];
  selectedJobId: string | null;
  onSelectJob: (jobId: string) => void;
};

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

export function JobList({ jobs, selectedJobId, onSelectJob }: JobListProps) {
  if (jobs.length === 0) {
    return (
      <div
        className="flex items-center justify-center"
        style={{
          width: 192,
          borderRight: "1px solid var(--border)",
          background: "var(--bg-surface)",
        }}
      >
        <div className="text-center p-4">
          <svg
            className="w-8 h-8 mx-auto mb-2"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
            style={{ color: "var(--text-muted)" }}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-tiny" style={{ color: "var(--text-muted)" }}>
            No runs yet.
            <br />
            Waiting for schedule...
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="overflow-y-auto"
      style={{
        width: 192,
        borderRight: "1px solid var(--border)",
        background: "var(--bg-surface)",
      }}
    >
      <div className="px-3 py-2" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="text-tiny uppercase tracking-wider font-bold" style={{ color: "var(--text-muted)" }}>
          Job History
        </span>
        <span className="text-tiny ml-1" style={{ color: "var(--text-muted)" }}>
          ({jobs.length})
        </span>
      </div>
      {jobs.map((job, idx) => {
        const colors = statusColors(job.status);
        const displayNum = job.number || jobs.length - idx;
        return (
          <button
            key={job.id}
            onClick={() => onSelectJob(job.id)}
            className={`w-full text-left px-3 py-2 hover:bg-[--bg-hover] transition-colors ${
              selectedJobId === job.id ? "bg-[--bg-hover]" : ""
            }`}
            style={{
              borderBottom: "1px solid var(--border)",
              ...(selectedJobId === job.id ? { borderLeft: "3px solid var(--bg-active)" } : {}),
            }}
          >
            <div className="flex items-center justify-between">
              <span className="text-tiny font-mono" style={{ color: "var(--text-muted)" }}>
                #{displayNum}
              </span>
              <span
                className="text-tiny px-1.5 py-0.5 rounded-sm font-bold"
                style={{ background: colors.bg, color: colors.fg }}
              >
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
      })}
    </div>
  );
}
