/** Minimal reactive store using React context + useState. */

import { createContext, useContext } from "react";
import type { Agent as ApiAgent, Channel, Task, TaskWithChannel, Job, ModelInfo, Session } from "./api";

export type ChatMessage = {
  id: string;
  sender: "user" | "agent";
  text: string;
  timestamp: number;
  mediaUrl?: string;
  a2ui?: string; // A2UI JSONL data
  threadId?: string;
  isStreaming?: boolean; // true while streaming is in progress
  /** Tracks which action blocks have been resolved, keyed by prompt hash */
  resolvedActions?: Record<string, { value: string; label: string }>;
};

export type ActiveView = "messages" | "automations";

export type AppState = {
  user: { id: string; email: string; displayName?: string | null } | null;
  activeView: ActiveView;
  agents: ApiAgent[];
  selectedAgentId: string | null;
  selectedSessionKey: string | null;
  channels: Channel[];
  selectedChannelId: string | null;
  sessions: Session[];
  selectedSessionId: string | null;
  tasks: Task[];
  selectedTaskId: string | null;
  jobs: Job[];
  selectedJobId: string | null;
  messages: ChatMessage[];
  threadMessages: ChatMessage[];
  activeThreadId: string | null;
  threadReplyCounts: Record<string, number>;
  openclawConnected: boolean;
  /** Per-session model override (set via /model or dropdown). null = using defaultModel. */
  sessionModel: string | null;
  wsConnected: boolean;
  models: ModelInfo[];
  /** Global default model from OpenClaw config (gateway primary). */
  defaultModel: string | null;
  // Streaming state — tracks in-progress streaming reply
  streamingRunId: string | null;
  streamingSessionKey: string | null;
  streamingThreadId: string | null; // non-null when streaming into a thread
  // Automations view state
  cronTasks: TaskWithChannel[];
  selectedCronTaskId: string | null;
  cronJobs: Job[];
  selectedCronJobId: string | null;
};

export const initialState: AppState = {
  user: null,
  activeView: "messages",
  agents: [],
  selectedAgentId: null,
  selectedSessionKey: null,
  channels: [],
  selectedChannelId: null,
  sessions: [],
  selectedSessionId: null,
  tasks: [],
  selectedTaskId: null,
  jobs: [],
  selectedJobId: null,
  messages: [],
  threadMessages: [],
  activeThreadId: null,
  threadReplyCounts: {},
  openclawConnected: false,
  sessionModel: null,
  wsConnected: false,
  models: [],
  defaultModel: null,
  streamingRunId: null,
  streamingSessionKey: null,
  streamingThreadId: null,
  cronTasks: [],
  selectedCronTaskId: null,
  cronJobs: [],
  selectedCronJobId: null,
};

export type AppAction =
  | { type: "SET_USER"; user: AppState["user"] }
  | { type: "SET_ACTIVE_VIEW"; view: ActiveView }
  | { type: "SET_AGENTS"; agents: ApiAgent[] }
  | { type: "SELECT_AGENT"; agentId: string | null; sessionKey: string | null }
  | { type: "SET_CHANNELS"; channels: Channel[] }
  | { type: "SELECT_CHANNEL"; channelId: string | null }
  | { type: "SET_SESSIONS"; sessions: Session[] }
  | { type: "SELECT_SESSION"; sessionId: string | null; sessionKey?: string | null }
  | { type: "ADD_SESSION"; session: Session }
  | { type: "REMOVE_SESSION"; sessionId: string }
  | { type: "RENAME_SESSION"; sessionId: string; name: string }
  | { type: "SET_TASKS"; tasks: Task[] }
  | { type: "SELECT_TASK"; taskId: string | null; sessionKey?: string | null }
  | { type: "SET_JOBS"; jobs: Job[] }
  | { type: "SELECT_JOB"; jobId: string | null; sessionKey?: string | null }
  | { type: "ADD_JOB"; job: Job }
  | { type: "ADD_MESSAGE"; message: ChatMessage }
  | { type: "SET_MESSAGES"; messages: ChatMessage[]; replyCounts?: Record<string, number> }
  | { type: "OPEN_THREAD"; threadId: string; messages: ChatMessage[] }
  | { type: "CLOSE_THREAD" }
  | { type: "ADD_THREAD_MESSAGE"; message: ChatMessage }
  | { type: "SET_OPENCLAW_CONNECTED"; connected: boolean; defaultModel?: string | null }
  | { type: "SET_SESSION_MODEL"; model: string | null }
  | { type: "SET_WS_CONNECTED"; connected: boolean }
  | { type: "SET_MODELS"; models: ModelInfo[] }
  | { type: "SET_DEFAULT_MODEL"; model: string | null }
  | { type: "SET_CRON_TASKS"; cronTasks: TaskWithChannel[] }
  | { type: "MERGE_SCAN_DATA"; scanTasks: Array<{ cronJobId: string; schedule: string; instructions: string; model?: string; enabled: boolean }> }
  | { type: "UPDATE_CRON_TASK"; taskId: string; updates: Partial<TaskWithChannel> }
  | { type: "SELECT_CRON_TASK"; taskId: string | null }
  | { type: "RESOLVE_ACTION"; messageId: string; promptHash: string; value: string; label: string }
  | { type: "STREAM_START"; runId: string; sessionKey: string; threadId?: string }
  | { type: "STREAM_CHUNK"; runId: string; sessionKey: string; text: string }
  | { type: "STREAM_END"; runId: string }
  | { type: "SET_CRON_JOBS"; cronJobs: Job[] }
  | { type: "SELECT_CRON_JOB"; jobId: string | null; sessionKey?: string | null }
  | { type: "ADD_CRON_JOB"; job: Job }
  | { type: "UPDATE_CRON_JOB"; job: Job }
  | { type: "APPEND_JOB_OUTPUT"; jobId: string; text: string }
  | { type: "LOGOUT" };

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "SET_USER":
      return { ...state, user: action.user };
    case "SET_ACTIVE_VIEW":
      return { ...state, activeView: action.view };
    case "SET_AGENTS":
      return { ...state, agents: action.agents };
    case "SELECT_AGENT":
      return {
        ...state,
        selectedAgentId: action.agentId,
        selectedSessionKey: action.sessionKey,
        sessions: [],
        selectedSessionId: null,
        messages: [],
        jobs: [],
        selectedJobId: null,
        activeThreadId: null,
        threadMessages: [],
      };
    case "SET_CHANNELS":
      return { ...state, channels: action.channels };
    case "SELECT_CHANNEL":
      return { ...state, selectedChannelId: action.channelId, sessions: [], selectedSessionId: null, tasks: [], selectedTaskId: null, jobs: [], selectedJobId: null, messages: [] };
    case "SET_SESSIONS":
      return { ...state, sessions: action.sessions };
    case "SELECT_SESSION": {
      const nextSessionKey = action.sessionKey ?? state.selectedSessionKey;
      const sessionChanged = nextSessionKey !== state.selectedSessionKey;
      return {
        ...state,
        selectedSessionId: action.sessionId,
        selectedSessionKey: nextSessionKey,
        // Only clear messages when the session actually changes;
        // otherwise keep whatever was already loaded to avoid the
        // race where SELECT_SESSION arrives *after* SET_MESSAGES
        // (e.g. session-list API returns after message-list API).
        messages: sessionChanged ? [] : state.messages,
        activeThreadId: sessionChanged ? null : state.activeThreadId,
        threadMessages: sessionChanged ? [] : state.threadMessages,
      };
    }
    case "ADD_SESSION":
      return { ...state, sessions: [...state.sessions, action.session] };
    case "REMOVE_SESSION":
      return {
        ...state,
        sessions: state.sessions.filter((s) => s.id !== action.sessionId),
        // If the removed session was selected, clear selection
        ...(state.selectedSessionId === action.sessionId
          ? { selectedSessionId: null, selectedSessionKey: null, messages: [] }
          : {}),
      };
    case "RENAME_SESSION":
      return {
        ...state,
        sessions: state.sessions.map((s) =>
          s.id === action.sessionId ? { ...s, name: action.name } : s,
        ),
      };
    case "SET_TASKS":
      return { ...state, tasks: action.tasks };
    case "SELECT_TASK": {
      const nextSessionKey = action.sessionKey ?? state.selectedSessionKey;
      const sessionChanged = nextSessionKey !== state.selectedSessionKey;
      return {
        ...state,
        selectedTaskId: action.taskId,
        selectedSessionKey: nextSessionKey,
        // Only clear messages when the session actually changes;
        // otherwise keep whatever was already loaded to avoid the
        // race where SELECT_TASK arrives *after* SET_MESSAGES.
        messages: sessionChanged ? [] : state.messages,
        jobs: [],
        selectedJobId: null,
      };
    }
    case "SET_JOBS":
      return { ...state, jobs: action.jobs };
    case "SELECT_JOB":
      return {
        ...state,
        selectedJobId: action.jobId,
        selectedSessionKey: action.sessionKey ?? state.selectedSessionKey,
        messages: [],
      };
    case "ADD_JOB":
      return { ...state, jobs: [action.job, ...state.jobs] };
    case "ADD_MESSAGE": {
      // If the last message is a streaming placeholder and a new agent
      // message arrives, replace it with the final message.  We also
      // proactively clear streamingRunId here because agent.text may
      // arrive *before* agent.stream.end (deliver() fires first inside
      // dispatchReplyFromConfig, stream.end is sent after it returns).
      const lastMsg = state.messages[state.messages.length - 1];
      if (
        action.message.sender === "agent" &&
        lastMsg?.isStreaming
      ) {
        return {
          ...state,
          streamingRunId: null,
          streamingSessionKey: null,
          messages: [
            ...state.messages.slice(0, -1),
            { ...action.message, isStreaming: false },
          ],
        };
      }
      return { ...state, messages: [...state.messages, action.message] };
    }
    case "SET_MESSAGES":
      return {
        ...state,
        messages: action.messages,
        ...(action.replyCounts
          ? { threadReplyCounts: { ...state.threadReplyCounts, ...action.replyCounts } }
          : {}),
      };
    case "OPEN_THREAD":
      return {
        ...state,
        activeThreadId: action.threadId,
        threadMessages: action.messages,
        threadReplyCounts: {
          ...state.threadReplyCounts,
          ...(action.messages.length > 0
            ? { [action.threadId]: action.messages.length }
            : {}),
        },
      };
    case "CLOSE_THREAD":
      return { ...state, activeThreadId: null, threadMessages: [] };
    case "ADD_THREAD_MESSAGE": {
      const msgThreadId = action.message.threadId ?? state.activeThreadId;
      const isActiveThread = !!(msgThreadId && msgThreadId === state.activeThreadId);

      let newThreadMessages = state.threadMessages;
      let clearStreaming: Partial<AppState> = {};

      if (isActiveThread) {
        // If the last thread message is a streaming placeholder and a new
        // agent message arrives, replace it (same logic as ADD_MESSAGE).
        const lastMsg = state.threadMessages[state.threadMessages.length - 1];
        if (action.message.sender === "agent" && lastMsg?.isStreaming) {
          newThreadMessages = [
            ...state.threadMessages.slice(0, -1),
            { ...action.message, isStreaming: false },
          ];
          clearStreaming = { streamingRunId: null, streamingSessionKey: null, streamingThreadId: null };
        } else {
          newThreadMessages = [...state.threadMessages, action.message];
        }
      }

      const updatedCounts = { ...state.threadReplyCounts };
      if (msgThreadId) {
        if (isActiveThread) {
          updatedCounts[msgThreadId] = newThreadMessages.length;
        } else {
          // Thread not open — just increment
          updatedCounts[msgThreadId] = (updatedCounts[msgThreadId] ?? 0) + 1;
        }
      }

      return {
        ...state,
        ...clearStreaming,
        threadMessages: newThreadMessages,
        threadReplyCounts: updatedCounts,
      };
    }
    case "SET_OPENCLAW_CONNECTED":
      // connection.status carries the gateway defaultModel (OpenClaw primary).
      // Prefer user's saved default (from API/settings); only use gateway default when user has not set one.
      return {
        ...state,
        openclawConnected: action.connected,
        defaultModel: state.defaultModel ?? action.defaultModel ?? null,
      };
    case "SET_SESSION_MODEL":
      return { ...state, sessionModel: action.model };
    case "SET_WS_CONNECTED":
      return { ...state, wsConnected: action.connected };
    case "SET_MODELS":
      return { ...state, models: action.models };
    case "SET_DEFAULT_MODEL":
      return { ...state, defaultModel: action.model };
    case "RESOLVE_ACTION": {
      // Mark an action block on a message as resolved (keyed by prompt hash)
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.messageId
            ? {
                ...m,
                resolvedActions: {
                  ...m.resolvedActions,
                  [action.promptHash]: { value: action.value, label: action.label },
                },
              }
            : m,
        ),
      };
    }
    case "STREAM_START": {
      // Add a streaming placeholder message
      const streamMsg: ChatMessage = {
        id: `stream_${action.runId}`,
        sender: "agent",
        text: "",
        timestamp: Date.now(),
        isStreaming: true,
      };
      const isThreadStream = !!action.threadId;
      return {
        ...state,
        streamingRunId: action.runId,
        streamingSessionKey: action.sessionKey,
        streamingThreadId: action.threadId ?? null,
        ...(isThreadStream
          ? { threadMessages: [...state.threadMessages, streamMsg] }
          : { messages: [...state.messages, streamMsg] }),
      };
    }
    case "STREAM_CHUNK": {
      if (state.streamingRunId !== action.runId) return state;
      // Update the streaming message's text (onPartialReply sends accumulated text)
      const streamId = `stream_${action.runId}`;
      if (state.streamingThreadId) {
        return {
          ...state,
          threadMessages: state.threadMessages.map((m) =>
            m.id === streamId ? { ...m, text: action.text } : m,
          ),
        };
      }
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === streamId ? { ...m, text: action.text } : m,
        ),
      };
    }
    case "STREAM_END": {
      // streamingRunId may already have been cleared by ADD_MESSAGE
      // (agent.text can arrive before stream.end); handle gracefully.
      if (state.streamingRunId && state.streamingRunId !== action.runId) return state;
      return { ...state, streamingRunId: null, streamingSessionKey: null, streamingThreadId: null };
    }
    case "SET_CRON_TASKS":
      return { ...state, cronTasks: action.cronTasks };
    case "MERGE_SCAN_DATA": {
      // Merge schedule/instructions/model from OpenClaw scan results into cronTasks.
      // These fields belong to OpenClaw and are NOT stored in D1.
      const scanMap = new Map(action.scanTasks.map((s) => [s.cronJobId, s]));
      const merged = state.cronTasks.map((task) => {
        const scan = task.openclawCronJobId ? scanMap.get(task.openclawCronJobId) : null;
        if (!scan) return task;
        return {
          ...task,
          schedule: scan.schedule || null,
          instructions: scan.instructions || null,
          model: scan.model || null,
          enabled: scan.enabled,
        };
      });
      // Also merge into the messages-view tasks list
      const mergedTasks = state.tasks.map((task) => {
        const scan = task.openclawCronJobId ? scanMap.get(task.openclawCronJobId) : null;
        if (!scan) return task;
        return {
          ...task,
          schedule: scan.schedule || null,
          instructions: scan.instructions || null,
          model: scan.model || null,
          enabled: scan.enabled,
        };
      });
      return { ...state, cronTasks: merged, tasks: mergedTasks };
    }
    case "UPDATE_CRON_TASK": {
      // Optimistic update for a single cron task (after editing)
      return {
        ...state,
        cronTasks: state.cronTasks.map((t) =>
          t.id === action.taskId ? { ...t, ...action.updates } : t,
        ),
        tasks: state.tasks.map((t) =>
          t.id === action.taskId ? { ...t, ...action.updates } : t,
        ),
      };
    }
    case "SELECT_CRON_TASK":
      // If re-selecting the same task, keep existing jobs to avoid flicker
      if (state.selectedCronTaskId === action.taskId) return state;
      return {
        ...state,
        selectedCronTaskId: action.taskId,
        cronJobs: [],
        selectedCronJobId: null,
        messages: [],
        selectedSessionKey: null,
      };
    case "SET_CRON_JOBS":
      return { ...state, cronJobs: action.cronJobs };
    case "SELECT_CRON_JOB":
      return {
        ...state,
        selectedCronJobId: action.jobId,
        selectedSessionKey: action.sessionKey ?? state.selectedSessionKey,
        messages: [],
      };
    case "ADD_CRON_JOB":
      // Prepend new job to cronJobs (most recent first)
      return { ...state, cronJobs: [action.job, ...state.cronJobs] };
    case "UPDATE_CRON_JOB": {
      // Update an existing job in cronJobs (e.g. running → ok/error)
      const exists = state.cronJobs.some((j) => j.id === action.job.id);
      if (exists) {
        return {
          ...state,
          cronJobs: state.cronJobs.map((j) => {
            if (j.id !== action.job.id) return j;
            // When a job finishes, prefer the streaming summary (accumulated
            // in-memory via job.output) over the server-side summary if the
            // streaming version is longer — it preserves block separators and
            // intermediate output that may not be persisted to D1.
            const summary =
              j.summary && j.summary.length > (action.job.summary?.length || 0)
                ? j.summary
                : action.job.summary;
            return { ...j, ...action.job, summary };
          }),
        };
      }
      // If not found, prepend (handles race where running arrives after list)
      return { ...state, cronJobs: [action.job, ...state.cronJobs] };
    }
    case "APPEND_JOB_OUTPUT": {
      // Update streaming output text for a running job (both views)
      const updateSummary = (list: Job[]) =>
        list.map((j) =>
          j.id === action.jobId ? { ...j, summary: action.text } : j,
        );
      return {
        ...state,
        jobs: updateSummary(state.jobs),
        cronJobs: updateSummary(state.cronJobs),
      };
    }
    case "LOGOUT":
      return { ...initialState };
    default:
      return state;
  }
}

export const AppStateContext = createContext<AppState>(initialState);
export const AppDispatchContext = createContext<React.Dispatch<AppAction>>(() => {});

export function useAppState() {
  return useContext(AppStateContext);
}

export function useAppDispatch() {
  return useContext(AppDispatchContext);
}
