import React, { useEffect, useRef, useState, useCallback, useSyncExternalStore } from "react";
import { getLogEntries, subscribeLog, clearLog, type LogEntry, type LogLevel } from "../debug-log";

const LEVEL_COLORS: Record<LogLevel, string> = {
  info: "var(--text-muted)",
  warn: "var(--accent-yellow)",
  error: "var(--accent-red)",
  "ws-in": "#6BCB77",
  "ws-out": "#4D96FF",
  api: "#C77DFF",
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  info: "INF",
  warn: "WRN",
  error: "ERR",
  "ws-in": "WS\u2193",
  "ws-out": "WS\u2191",
  api: "API",
};

function formatTs(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) +
    "." + String(d.getMilliseconds()).padStart(3, "0");
}

const STORAGE_KEY = "botschat_debug_panel_height";
const DEFAULT_HEIGHT = 220;
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 600;

export function DebugLogPanel() {
  const entries = useSyncExternalStore(subscribeLog, getLogEntries);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<LogLevel | "all">("all");
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  // Persisted panel height
  const [height, setHeight] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const n = parseInt(saved, 10);
        if (n >= MIN_HEIGHT && n <= MAX_HEIGHT) return n;
      }
    } catch { /* ignore */ }
    return DEFAULT_HEIGHT;
  });

  // Drag-to-resize state
  const draggingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(DEFAULT_HEIGHT);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    startYRef.current = e.clientY;
    startHeightRef.current = height;

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      // Dragging up → increases height (clientY decreases)
      const delta = startYRef.current - ev.clientY;
      const newH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeightRef.current + delta));
      setHeight(newH);
    };

    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      // Persist
      setHeight((h) => {
        try { localStorage.setItem(STORAGE_KEY, String(h)); } catch { /* ignore */ }
        return h;
      });
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [height]);

  // Touch support for mobile
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    e.stopPropagation();
    const touch = e.touches[0];
    draggingRef.current = true;
    startYRef.current = touch.clientY;
    startHeightRef.current = height;

    const onMove = (ev: TouchEvent) => {
      if (!draggingRef.current) return;
      const t = ev.touches[0];
      const delta = startYRef.current - t.clientY;
      const newH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeightRef.current + delta));
      setHeight(newH);
    };

    const onEnd = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      setHeight((h) => {
        try { localStorage.setItem(STORAGE_KEY, String(h)); } catch { /* ignore */ }
        return h;
      });
    };

    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
  }, [height]);

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (open && autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length, open]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    autoScrollRef.current = scrollHeight - scrollTop - clientHeight < 40;
  };

  const toggleExpand = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filtered = filter === "all" ? entries : entries.filter((e) => e.level === filter);
  const entryCount = entries.length;

  return (
    <div
      style={{
        flexShrink: 0,
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      {/* Drag handle — visible only when panel is open */}
      {open && (
        <div
          onMouseDown={handleResizeStart}
          onTouchStart={handleTouchStart}
          className="resize-handle group"
          style={{
            height: 6,
            cursor: "row-resize",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--bg-secondary)",
            borderTop: "1px solid var(--border)",
            flexShrink: 0,
          }}
        >
          <div
            className="resize-handle-line"
            style={{
              width: "100%",
              height: 1,
              background: "var(--border)",
              transition: "height 150ms, background 150ms",
            }}
          />
        </div>
      )}

      {/* Toggle bar */}
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "3px 12px",
          background: "var(--bg-secondary)",
          borderTop: open ? undefined : "1px solid var(--border)",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <svg
          width={10} height={10}
          viewBox="0 0 10 10"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.15s", flexShrink: 0 }}
        >
          <path d="M1 7L5 3l4 4" stroke="var(--text-muted)" strokeWidth={1.5} fill="none" />
        </svg>
        <span style={{ color: "var(--text-muted)", fontWeight: 600, fontSize: 11 }}>
          Debug Log
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: 10 }}>
          ({entryCount})
        </span>
        {/* Quick filter pills when open */}
        {open && (
          <div style={{ display: "flex", gap: 2, marginLeft: 8 }} onClick={(e) => e.stopPropagation()}>
            {(["all", "ws-in", "ws-out", "api", "info", "warn", "error"] as const).map((lvl) => (
              <button
                key={lvl}
                onClick={() => setFilter(lvl)}
                style={{
                  padding: "1px 6px",
                  borderRadius: 3,
                  border: "none",
                  fontSize: 10,
                  fontFamily: "var(--font-mono)",
                  cursor: "pointer",
                  background: filter === lvl ? "var(--bg-active)" : "var(--bg-hover)",
                  color: filter === lvl ? "#fff" : (lvl === "all" ? "var(--text-muted)" : LEVEL_COLORS[lvl as LogLevel]),
                }}
              >
                {lvl === "all" ? "ALL" : LEVEL_LABELS[lvl as LogLevel]}
              </button>
            ))}
          </div>
        )}
        {open && (
          <button
            onClick={(e) => { e.stopPropagation(); clearLog(); }}
            style={{
              marginLeft: "auto",
              padding: "1px 8px",
              borderRadius: 3,
              border: "none",
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
              background: "var(--bg-hover)",
              color: "var(--text-muted)",
            }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Log content */}
      {open && (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          style={{
            height,
            overflowY: "auto",
            overflowX: "hidden",
            background: "var(--bg-primary)",
            borderTop: "1px solid var(--border)",
          }}
        >
          {filtered.length === 0 && (
            <div style={{ padding: "16px 12px", color: "var(--text-muted)", textAlign: "center" }}>
              No log entries yet.
            </div>
          )}
          {filtered.map((entry) => (
            <LogRow
              key={entry.id}
              entry={entry}
              expanded={expandedIds.has(entry.id)}
              onToggleExpand={() => toggleExpand(entry.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LogRow({
  entry,
  expanded,
  onToggleExpand,
}: {
  entry: LogEntry;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const levelColor = LEVEL_COLORS[entry.level];
  const levelLabel = LEVEL_LABELS[entry.level];

  return (
    <div
      style={{
        padding: "1px 12px",
        borderBottom: "1px solid var(--border)",
        wordBreak: "break-all",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "")}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        {/* Timestamp */}
        <span style={{ color: "var(--text-muted)", flexShrink: 0, width: 85 }}>
          {formatTs(entry.ts)}
        </span>
        {/* Level badge */}
        <span
          style={{
            color: levelColor,
            fontWeight: 700,
            flexShrink: 0,
            width: 28,
            textAlign: "center",
          }}
        >
          {levelLabel}
        </span>
        {/* Tag */}
        <span style={{ color: "var(--text-secondary)", flexShrink: 0, minWidth: 50 }}>
          [{entry.tag}]
        </span>
        {/* Message */}
        <span style={{ color: "var(--text-primary)", flex: 1 }}>
          {entry.message}
        </span>
        {/* Expand toggle for detail */}
        {entry.detail && (
          <button
            onClick={onToggleExpand}
            style={{
              border: "none",
              background: "none",
              cursor: "pointer",
              color: "var(--text-muted)",
              fontSize: 10,
              padding: "0 4px",
              flexShrink: 0,
            }}
          >
            {expanded ? "\u25BC" : "\u25B6"}
          </button>
        )}
      </div>
      {/* Expanded detail */}
      {expanded && entry.detail && (
        <pre
          style={{
            margin: "2px 0 4px 121px",
            padding: "4px 8px",
            background: "var(--code-bg)",
            borderRadius: 3,
            color: "var(--text-secondary)",
            fontSize: 11,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            maxHeight: 200,
            overflowY: "auto",
          }}
        >
          {entry.detail}
        </pre>
      )}
    </div>
  );
}
