/**
 * Global debug log — captures WS messages, API calls, state changes, errors.
 * Subscribers are notified on every new entry so React can re-render.
 */

export type LogLevel = "info" | "warn" | "error" | "ws-in" | "ws-out" | "api";

export type LogEntry = {
  id: number;
  ts: number;
  level: LogLevel;
  tag: string;
  message: string;
  detail?: string; // collapsed JSON / extra info
};

const MAX_ENTRIES = 500;
let _nextId = 1;
const _entries: LogEntry[] = [];
const _listeners = new Set<() => void>();

export function addLog(level: LogLevel, tag: string, message: string, detail?: unknown): void {
  const entry: LogEntry = {
    id: _nextId++,
    ts: Date.now(),
    level,
    tag,
    message,
    detail: detail !== undefined ? (typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)) : undefined,
  };
  _entries.push(entry);
  if (_entries.length > MAX_ENTRIES) _entries.splice(0, _entries.length - MAX_ENTRIES);
  for (const fn of _listeners) fn();
}

export function getLogEntries(): readonly LogEntry[] {
  return _entries;
}

export function clearLog(): void {
  _entries.length = 0;
  for (const fn of _listeners) fn();
}

export function subscribeLog(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// Convenience helpers
export const dlog = {
  info: (tag: string, msg: string, detail?: unknown) => addLog("info", tag, msg, detail),
  warn: (tag: string, msg: string, detail?: unknown) => addLog("warn", tag, msg, detail),
  error: (tag: string, msg: string, detail?: unknown) => addLog("error", tag, msg, detail),
  wsIn: (tag: string, msg: string, detail?: unknown) => addLog("ws-in", tag, msg, detail),
  wsOut: (tag: string, msg: string, detail?: unknown) => addLog("ws-out", tag, msg, detail),
  api: (tag: string, msg: string, detail?: unknown) => addLog("api", tag, msg, detail),
};
