/** Lightweight API client for the BotsChat Workers API. */

import { dlog } from "./debug-log";

const API_BASE = "/api";

let _token: string | null = localStorage.getItem("botschat_token");
let _refreshToken: string | null = localStorage.getItem("botschat_refresh_token");

export function setToken(token: string | null) {
  _token = token;
  if (token) localStorage.setItem("botschat_token", token);
  else localStorage.removeItem("botschat_token");
}

export function setRefreshToken(token: string | null) {
  _refreshToken = token;
  if (token) localStorage.setItem("botschat_refresh_token", token);
  else localStorage.removeItem("botschat_refresh_token");
}

export function getToken(): string | null {
  return _token;
}

export function getRefreshToken(): string | null {
  return _refreshToken;
}

/** Try to refresh the access token using the refresh token. */
export async function tryRefreshAccessToken(): Promise<boolean> {
  if (!_refreshToken) return false;
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: _refreshToken }),
    });
    if (!res.ok) return false;
    const data = await res.json() as { token: string };
    setToken(data.token);
    dlog.info("API", "Access token refreshed successfully");
    return true;
  } catch {
    return false;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const tag = `${method} ${path}`;
  dlog.api("API", `→ ${tag}`, body);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (_token) headers["Authorization"] = `Bearer ${_token}`;

  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    dlog.error("API", `✗ ${tag} — network error (${ms}ms)`, String(err));
    throw err;
  }

  // Auto-refresh on 401 (expired access token)
  if (res.status === 401 && _refreshToken && !path.includes("/auth/refresh")) {
    const refreshed = await tryRefreshAccessToken();
    if (refreshed) {
      // Retry the original request with the new token
      headers["Authorization"] = `Bearer ${_token}`;
      try {
        res = await fetch(`${API_BASE}${path}`, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          cache: "no-store",
        });
      } catch (err) {
        const ms = Math.round(performance.now() - t0);
        dlog.error("API", `✗ ${tag} — network error on retry (${ms}ms)`, String(err));
        throw err;
      }
    }
  }

  const ms = Math.round(performance.now() - t0);

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const message = (err as { error?: string }).error ?? `HTTP ${res.status}`;
    dlog.error("API", `✗ ${tag} — ${res.status} (${ms}ms): ${message}`);
    throw new Error(message);
  }

  const data = await res.json() as T;
  dlog.api("API", `✓ ${tag} — ${res.status} (${ms}ms)`, data);
  return data;
}

// ---- Auth ----
export type AuthResponse = { id: string; email: string; token: string; refreshToken?: string; displayName?: string };

export type UserSettings = { defaultModel?: string };

export type AuthConfig = {
  emailEnabled: boolean;
  googleEnabled: boolean;
  githubEnabled: boolean;
};

export const authApi = {
  /** Fetch server-side auth configuration (which methods are available). */
  config: () => request<AuthConfig>("GET", "/auth/config"),
  register: (email: string, password: string, displayName?: string) =>
    request<AuthResponse>("POST", "/auth/register", { email, password, displayName }),
  login: (email: string, password: string) =>
    request<AuthResponse>("POST", "/auth/login", { email, password }),
  /** Sign in with any Firebase provider (Google, GitHub, etc.) */
  firebase: (idToken: string) =>
    request<AuthResponse>("POST", "/auth/firebase", { idToken }),
  me: () => request<{ id: string; email: string; displayName: string | null; settings: UserSettings }>("GET", "/me"),
};

// ---- User settings ----
export const meApi = {
  updateSettings: (data: { defaultModel?: string }) =>
    request<{ ok: boolean; settings: UserSettings }>("PATCH", "/me", data),
};

// ---- Models ----
export type ModelInfo = {
  id: string;
  name: string;
  provider: string;
};

export const modelsApi = {
  list: () => request<{ models: ModelInfo[] }>("GET", "/models"),
};

// ---- Agents (OpenClaw-aligned: first level = Agent, then Session) ----
export type Agent = {
  id: string;
  name: string;
  sessionKey: string;
  isDefault: boolean;
  channelId: string | null;
};

export const agentsApi = {
  list: () => request<{ agents: Agent[] }>("GET", "/agents"),
};

// ---- Channels ----
export type Channel = {
  id: string;
  name: string;
  description: string;
  openclawAgentId: string;
  systemPrompt: string;
  createdAt: number;
  updatedAt: number;
};

export const channelsApi = {
  list: () => request<{ channels: Channel[] }>("GET", "/channels"),
  get: (id: string) => request<Channel>("GET", `/channels/${id}`),
  create: (data: { name: string; description?: string; systemPrompt?: string; openclawAgentId?: string }) =>
    request<Channel>("POST", "/channels", data),
  update: (id: string, data: Partial<Pick<Channel, "name" | "description" | "systemPrompt">>) =>
    request<{ ok: boolean }>("PATCH", `/channels/${id}`, data),
  delete: (id: string) => request<{ ok: boolean }>("DELETE", `/channels/${id}`),
};

// ---- Sessions ----
export type Session = {
  id: string;
  name: string;
  sessionKey: string;
  createdAt: number;
  updatedAt: number;
};

export const sessionsApi = {
  list: (channelId: string) =>
    request<{ sessions: Session[] }>("GET", `/channels/${channelId}/sessions`),
  create: (channelId: string, name?: string) =>
    request<Session>("POST", `/channels/${channelId}/sessions`, { name }),
  rename: (channelId: string, sessionId: string, name: string) =>
    request<{ ok: boolean }>("PATCH", `/channels/${channelId}/sessions/${sessionId}`, { name }),
  delete: (channelId: string, sessionId: string) =>
    request<{ ok: boolean }>("DELETE", `/channels/${channelId}/sessions/${sessionId}`),
};

// ---- Tasks ----
export type Task = {
  id: string;
  name: string;
  kind: "background" | "adhoc";
  openclawCronJobId: string | null;
  schedule: string | null;
  instructions: string | null;
  model: string | null;
  sessionKey: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type TaskWithChannel = Task & { channelId: string };

export type TaskScanEntry = {
  cronJobId: string;
  schedule: string;
  instructions: string;
  model: string;
  enabled: boolean;
  encrypted?: boolean;
  iv?: string;
};

export const tasksApi = {
  list: (channelId: string) =>
    request<{ tasks: Task[] }>("GET", `/channels/${channelId}/tasks`),
  listAll: (kind: "background" | "adhoc" = "background") =>
    request<{ tasks: TaskWithChannel[] }>("GET", `/tasks?kind=${kind}`),
  /** Fetch OpenClaw-owned fields (schedule/instructions/model) from plugin via DO (live task.scan.request, no cache). */
  scanData: () =>
    request<{ tasks: TaskScanEntry[] }>("GET", "/task-scan"),
  create: (channelId: string, data: { name: string; kind: "background" | "adhoc"; schedule?: string; instructions?: string }) =>
    request<Task>("POST", `/channels/${channelId}/tasks`, data),
  update: (channelId: string, taskId: string, data: Partial<Pick<Task, "name" | "schedule" | "instructions" | "model" | "enabled">>) =>
    request<{ ok: boolean }>("PATCH", `/channels/${channelId}/tasks/${taskId}`, data),
  delete: (channelId: string, taskId: string) =>
    request<{ ok: boolean }>("DELETE", `/channels/${channelId}/tasks/${taskId}`),
  run: (channelId: string, taskId: string) =>
    request<{ ok: boolean; message: string }>("POST", `/channels/${channelId}/tasks/${taskId}/run`),
};

// ---- Jobs (background task execution history) ----
export type Job = {
  id: string;
  number: number;
  sessionKey: string;
  status: "running" | "ok" | "error" | "skipped";
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  summary: string;
  time: string;
  encrypted?: boolean;
};

export const jobsApi = {
  list: (channelId: string, taskId: string) =>
    request<{ jobs: Job[] }>("GET", `/channels/${channelId}/tasks/${taskId}/jobs`),
  listByTask: (taskId: string) =>
    request<{ jobs: Job[] }>("GET", `/tasks/${taskId}/jobs`),
};

// ---- Messages ----
export type MessageRecord = {
  id: string;
  sender: "user" | "agent";
  text: string;
  timestamp: number;
  mediaUrl?: string;
  a2ui?: string;
  threadId?: string;
  encrypted?: boolean;
};

export const messagesApi = {
  list: (userId: string, sessionKey: string, threadId?: string) =>
    request<{ messages: MessageRecord[]; replyCounts?: Record<string, number> }>(
      "GET",
      `/messages/${userId}?sessionKey=${encodeURIComponent(sessionKey)}${threadId ? `&threadId=${encodeURIComponent(threadId)}` : ""}`,
    ),
};

// ---- Pairing Tokens ----
export type PairingToken = {
  id: string;
  // Full token is no longer returned by the GET endpoint (security).
  // Only `tokenPreview` (masked) is available after creation.
  tokenPreview: string;
  label: string | null;
  lastConnectedAt: number | null;
  createdAt: number;
};

export const pairingApi = {
  list: () => request<{ tokens: PairingToken[] }>("GET", "/pairing-tokens"),
  create: (label?: string) =>
    request<{ id: string; token: string; label: string | null }>("POST", "/pairing-tokens", { label }),
  delete: (id: string) => request<{ ok: boolean }>("DELETE", `/pairing-tokens/${id}`),
};

export const setupApi = {
  /** Get the recommended cloudUrl from the backend (smart resolution). */
  cloudUrl: () =>
    request<{ cloudUrl: string; isLoopback: boolean; hint?: string }>(
      "GET",
      "/setup/cloud-url",
    ),
};
