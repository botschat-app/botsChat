import React, { useReducer, useEffect, useCallback, useRef, useState } from "react";
import { Group, Panel, useDefaultLayout } from "react-resizable-panels";
import {
  appReducer,
  initialState,
  AppStateContext,
  AppDispatchContext,
  type ChatMessage,
  type AppState,
  type ActiveView,
} from "./store";
import { getToken, setToken, setRefreshToken, agentsApi, channelsApi, tasksApi, jobsApi, authApi, messagesApi, modelsApi, meApi, sessionsApi, type ModelInfo } from "./api";
import { ModelSelect } from "./components/ModelSelect";
import { BotsChatWSClient, type WSMessage } from "./ws";
import { IconRail } from "./components/IconRail";
import { Sidebar } from "./components/Sidebar";
import { ChatWindow } from "./components/ChatWindow";
import { ThreadPanel } from "./components/ThreadPanel";
import { JobList } from "./components/JobList";
import { LoginPage } from "./components/LoginPage";
import { OnboardingPage } from "./components/OnboardingPage";
import { ConnectionSettings } from "./components/ConnectionSettings";
import { E2ESettings } from "./components/E2ESettings";
import { DebugLogPanel } from "./components/DebugLogPanel";
import { CronSidebar } from "./components/CronSidebar";
import { CronDetail } from "./components/CronDetail";
import { ResizeHandle } from "./components/ResizeHandle";
import { useIsMobile } from "./hooks/useIsMobile";
import { MobileLayout } from "./components/MobileLayout";
import { dlog } from "./debug-log";
import { E2eService } from "./e2e";
import { gtagPageView } from "./analytics";

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState, (init): AppState => {
    // Restore last active view from localStorage
    try {
      const savedView = localStorage.getItem("botschat_active_view");
      if (savedView === "messages" || savedView === "automations") {
        return { ...init, activeView: savedView as ActiveView };
      }
    } catch { /* ignore */ }
    return init;
  });
  const wsClientRef = useRef<BotsChatWSClient | null>(null);
  const handleWSMessageRef = useRef<(msg: WSMessage) => void>(() => {});
  const creatingGeneralRef = useRef(false);

  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "connection" | "security">("general");

  // Track whether the initial channels fetch has completed (prevents onboarding flash)
  const [channelsLoadedOnce, setChannelsLoadedOnce] = useState(false);

  // Responsive layout hooks (must be called unconditionally)
  const isMobile = useIsMobile();
  const mainLayout = useDefaultLayout({ id: "botschat-main" });
  const contentLayout = useDefaultLayout({ id: "botschat-content" });

  // Onboarding: show setup page for new users who haven't connected OpenClaw yet.
  // Once dismissed (skip or connected), we remember it for this session.
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => {
    return localStorage.getItem("botschat_onboarding_dismissed") === "1";
  });

  const handleDismissOnboarding = useCallback(() => {
    setOnboardingDismissed(true);
    localStorage.setItem("botschat_onboarding_dismissed", "1");
  }, []);

  // Theme state – default to system preference then dark
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const saved = localStorage.getItem("botschat_theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("botschat_theme", theme);
    // Sync PWA theme-color meta tag with current theme
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#1A1D21" : "#FFFFFF");
  }, [theme]);

  // Persist active view (messages / automations)
  useEffect(() => {
    localStorage.setItem("botschat_active_view", state.activeView);
  }, [state.activeView]);

  // Google Analytics: track virtual page views for SPA tabs
  useEffect(() => {
    gtagPageView(state.activeView);
  }, [state.activeView]);

  // Persist selected cron task for automations view
  useEffect(() => {
    if (state.selectedCronTaskId) {
      localStorage.setItem("botschat_last_cron_task", state.selectedCronTaskId);
    }
  }, [state.selectedCronTaskId]);

  // Persist selected session per channel
  useEffect(() => {
    if (state.selectedSessionId) {
      const agent = state.agents.find((a) => a.id === state.selectedAgentId);
      if (agent?.channelId) {
        localStorage.setItem(`botschat_last_session_${agent.channelId}`, state.selectedSessionId);
      }
    }
  }, [state.selectedSessionId, state.selectedAgentId, state.agents]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  // ---- Auto-login on mount ----
  useEffect(() => {
    const token = getToken();
    if (token) {
      dlog.api("Auth", "Auto-login with stored token");
      authApi
        .me()
        .then((user) => {
          dlog.info("Auth", `Logged in as ${user.email} (${user.id})`);
          dispatch({ type: "SET_USER", user });
          // defaultModel comes from plugin via connection.status, not from user.settings
        })
        .catch((err) => {
          dlog.warn("Auth", `Auto-login failed: ${err}`);
          setToken(null);
          setRefreshToken(null);
        });
    }
  }, []);

  // Models are delivered via WS (connection.status) on browser auth.
  // Fallback: fetch from REST if WS didn't deliver models within 2s.
  useEffect(() => {
    if (!state.user) return;
    const timer = setTimeout(() => {
      if (state.models.length === 0) {
        modelsApi.list().then(({ models }) => {
          if (models.length > 0) dispatch({ type: "SET_MODELS", models });
        }).catch(() => {});
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [state.user, state.models.length]);

  // ---- Load agents (default + channel agents) when user is set ----
  useEffect(() => {
    if (state.user) {
      dlog.api("Agents", "Loading agents list");
      agentsApi.list().then(({ agents }) => {
        dlog.info("Agents", `Loaded ${agents.length} agents`, agents.map((a) => ({ id: a.id, name: a.name, channelId: a.channelId })));
        dispatch({ type: "SET_AGENTS", agents });
        if (agents.length > 0 && !state.selectedAgentId) {
          // Restore last selected channel from localStorage if available
          let target = agents[0];
          try {
            const lastId = localStorage.getItem("botschat_last_agent");
            if (lastId) {
              const found = agents.find((a) => a.id === lastId);
              if (found) {
                dlog.info("Agents", `Restoring last channel: ${found.name} (${found.id})`);
                target = found;
              }
            }
          } catch { /* ignore */ }
          dispatch({
            type: "SELECT_AGENT",
            agentId: target.id,
            sessionKey: target.sessionKey,
          });
        }
      });
      dlog.api("Channels", "Loading channels list");
      channelsApi.list().then(({ channels }) => {
        dlog.info("Channels", `Loaded ${channels.length} channels`, channels.map((c) => ({ id: c.id, name: c.name })));
        dispatch({ type: "SET_CHANNELS", channels });
        setChannelsLoadedOnce(true);
      });
    }
  }, [state.user]);

  // ---- Load cron tasks when switching to automations view ----
  useEffect(() => {
    if (state.user && state.activeView === "automations") {
      dlog.api("Cron", "Loading all background tasks + scan data");
      // Load D1 task metadata AND OpenClaw scan data in parallel
      Promise.all([
        tasksApi.listAll("background"),
        tasksApi.scanData(),
      ]).then(([{ tasks }, { tasks: scanTasks }]) => {
        dlog.info("Cron", `Loaded ${tasks.length} cron tasks + ${scanTasks.length} scan entries`);
        dispatch({ type: "SET_CRON_TASKS", cronTasks: tasks });
        // Merge OpenClaw-owned fields (schedule/instructions/model)
        dispatch({
          type: "MERGE_SCAN_DATA",
          scanTasks: scanTasks.map((t) => ({
            cronJobId: t.cronJobId,
            schedule: t.schedule,
            instructions: t.instructions,
            model: t.model || undefined,
            enabled: t.enabled,
          })),
        });
        if (tasks.length > 0 && !state.selectedCronTaskId) {
          // Restore last selected cron task from localStorage if available
          let targetTaskId = tasks[0].id;
          try {
            const lastId = localStorage.getItem("botschat_last_cron_task");
            if (lastId) {
              const found = tasks.find((t) => t.id === lastId);
              if (found) {
                dlog.info("Cron", `Restoring last cron task: ${found.name} (${found.id})`);
                targetTaskId = found.id;
              }
            }
          } catch { /* ignore */ }
          dispatch({ type: "SELECT_CRON_TASK", taskId: targetTaskId });
        }
      });
    }
  }, [state.user, state.activeView]);

  // ---- When agent changes (or switching back to messages view), load sessions ----
  // Derive channelId so the effect re-runs when the default agent gets a channelId
  const selectedAgentChannelId = state.agents.find((a) => a.id === state.selectedAgentId)?.channelId;
  // Include activeView so sessions + sessionKey are restored after automations view
  // (SELECT_CRON_TASK / SELECT_CRON_JOB overwrite the shared selectedSessionKey)
  const isMessagesView = state.activeView === "messages";

  useEffect(() => {
    // Only load sessions when in messages view
    if (!isMessagesView) return;

    if (!state.selectedAgentId) {
      dispatch({ type: "SET_TASKS", tasks: [] });
      dispatch({ type: "SELECT_TASK", taskId: null });
      dispatch({ type: "SET_SESSIONS", sessions: [] });
      return;
    }

    const agent = state.agents.find((a) => a.id === state.selectedAgentId);
    if (agent?.channelId) {
      // Load tasks (for non-default channel agents)
      if (!agent.isDefault) {
        tasksApi.list(agent.channelId).then(({ tasks }) => {
          dispatch({ type: "SET_TASKS", tasks });
          if (tasks.length > 0) {
            const first = tasks[0];
            dispatch({
              type: "SELECT_TASK",
              taskId: first.id,
              // Don't set sessionKey here — sessions will handle it
            });
          }
        });
      } else {
        dispatch({ type: "SET_TASKS", tasks: [] });
        dispatch({ type: "SELECT_TASK", taskId: null });
      }

      // Load sessions for this channel (all agents including default)
      sessionsApi.list(agent.channelId).then(({ sessions }) => {
        dlog.info("Sessions", `Loaded ${sessions.length} sessions for channel ${agent.channelId}`);
        dispatch({ type: "SET_SESSIONS", sessions });
        if (sessions.length > 0) {
          // Restore last selected session from localStorage if available
          let target = sessions[0];
          try {
            const lastId = localStorage.getItem(`botschat_last_session_${agent.channelId}`);
            if (lastId) {
              const found = sessions.find((s) => s.id === lastId);
              if (found) {
                dlog.info("Sessions", `Restoring last session: ${found.name} (${found.id})`);
                target = found;
              }
            }
          } catch { /* ignore */ }
          dispatch({
            type: "SELECT_SESSION",
            sessionId: target.id,
            sessionKey: target.sessionKey,
          });
        }
      }).catch((err) => {
        dlog.error("Sessions", `Failed to load sessions: ${err}`);
      });
    } else if (agent?.isDefault && !creatingGeneralRef.current && onboardingDismissed) {
      // Default agent has no channelId yet — auto-create the "General" channel
      // (which also creates "Session 1") so the user sees a chat immediately.
      // Gated by onboardingDismissed to avoid flashing the onboarding page away.
      dlog.info("Sessions", "Default agent has no channel — auto-creating General channel");
      creatingGeneralRef.current = true;
      dispatch({ type: "SET_TASKS", tasks: [] });
      dispatch({ type: "SELECT_TASK", taskId: null });
      dispatch({ type: "SET_SESSIONS", sessions: [] });

      channelsApi
        .create({ name: "General", openclawAgentId: "main" })
        .then(async (channel) => {
          dlog.info("Sessions", `General channel created: ${channel.id}`);
          // Reload agents and channels so the default agent picks up the new channelId
          const [{ agents: freshAgents }, { channels: freshChannels }] = await Promise.all([
            agentsApi.list(),
            channelsApi.list(),
          ]);
          dispatch({ type: "SET_AGENTS", agents: freshAgents });
          dispatch({ type: "SET_CHANNELS", channels: freshChannels });
          // Channel creation auto-creates "Session 1" — load and select it
          const { sessions: newSessions } = await sessionsApi.list(channel.id);
          dispatch({ type: "SET_SESSIONS", sessions: newSessions });
          if (newSessions.length > 0) {
            dispatch({
              type: "SELECT_SESSION",
              sessionId: newSessions[0].id,
              sessionKey: newSessions[0].sessionKey,
            });
          }
        })
        .catch((err) => {
          dlog.error("Sessions", `Failed to auto-create General channel: ${err}`);
          creatingGeneralRef.current = false;
        });
    } else {
      dispatch({ type: "SET_TASKS", tasks: [] });
      dispatch({ type: "SELECT_TASK", taskId: null });
      dispatch({ type: "SET_SESSIONS", sessions: [] });
    }
  }, [state.selectedAgentId, selectedAgentChannelId, isMessagesView, onboardingDismissed]);

  // ---- Load jobs when a background task is selected ----
  useEffect(() => {
    if (!state.selectedTaskId) return;
    const task = state.tasks.find((t) => t.id === state.selectedTaskId);
    if (!task || task.kind !== "background") {
      dispatch({ type: "SET_JOBS", jobs: [] });
      return;
    }
    const agent = state.agents.find((a) => a.id === state.selectedAgentId);
    if (!agent?.channelId) return;

    jobsApi
      .list(agent.channelId, task.id)
      .then(({ jobs }) => {
        dispatch({ type: "SET_JOBS", jobs });
        // Auto-select the most recent job
        if (jobs.length > 0 && !state.selectedJobId) {
          dispatch({
            type: "SELECT_JOB",
            jobId: jobs[0].id,
            sessionKey: jobs[0].sessionKey,
          });
        }
      })
      .catch((err) => {
        console.error("Failed to load jobs:", err);
      });
  }, [state.selectedTaskId, state.tasks]);

  // ---- Load message history when session changes ----
  useEffect(() => {
    if (!state.user || !state.selectedSessionKey) return;
    let stale = false;
    messagesApi
      .list(state.user.id, state.selectedSessionKey)
      .then(async ({ messages, replyCounts }) => {
        // Guard against stale responses when the user rapidly switches channels:
        // the cleanup function sets `stale = true` before the new effect runs.
        if (stale) return;

        // Decrypt history if possible
        const decryptedMessages = await Promise.all(messages.map(async (m) => {
            if (m.encrypted && E2eService.hasKey()) {
                try {
                    // Use message ID as context ID (nonce source)
                     const plaintext = await E2eService.decrypt(m.text, m.id);
                     return { ...m, text: plaintext, isEncryptedLocked: false };
                } catch (err) {
                    console.warn(`Failed to decrypt message ${m.id}`, err);
                    return { ...m, isEncryptedLocked: true };
                }
            } else if (m.encrypted) {
                return { ...m, isEncryptedLocked: true };
            }
            return m;
        }));

        dispatch({ type: "SET_MESSAGES", messages: decryptedMessages as ChatMessage[], replyCounts });
      })
      .catch((err) => {
        console.error("Failed to load message history:", err);
      });
    return () => { stale = true; };
  }, [state.user, state.selectedSessionKey]);

  // Keep a ref to state for use in WS handler (avoids stale closures)
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // ---- WS message handler ----
  const handleWSMessage = useCallback(
    (msg: WSMessage) => {
      const sessionKey = msg.sessionKey as string | undefined;
      const threadId = (msg.threadId ?? msg.replyToId) as string | undefined;

      // Log every incoming WS message
      dlog.wsIn("WS", `${msg.type}`, msg);

      // Helper: extract base sessionKey (strip ":thread:*" suffix) for comparison
      const getBaseSessionKey = (sk: string | undefined): string | undefined => {
        if (!sk) return undefined;
        return sk.replace(/:thread:.+$/, "");
      };

      // Helper: check if an incoming message's sessionKey matches the currently
      // viewed session.  This prevents cron-task or other background-session
      // messages from being injected into the wrong chat view (and potentially
      // replacing the user's streaming reply via ADD_MESSAGE).
      const isCurrentSession = (sk: string | undefined): boolean => {
        if (!sk) return true; // no sessionKey → allow (e.g. status messages)
        const base = getBaseSessionKey(sk);
        return base === stateRef.current.selectedSessionKey;
      };

      switch (msg.type) {
        case "connection.status":
          dlog.info("Connection", `OpenClaw ${msg.openclawConnected ? "connected" : "disconnected"}${msg.defaultModel ? ` (default: ${msg.defaultModel})` : ""}`);
          dispatch({
            type: "SET_OPENCLAW_CONNECTED",
            connected: msg.openclawConnected as boolean,
            defaultModel: (msg.defaultModel as string) || undefined,
          });
          // Models are delivered alongside connection.status
          if (Array.isArray(msg.models) && msg.models.length > 0) {
            dispatch({ type: "SET_MODELS", models: msg.models as ModelInfo[] });
          }
          break;

        case "openclaw.disconnected":
          dlog.warn("Connection", "OpenClaw disconnected");
          dispatch({ type: "SET_OPENCLAW_CONNECTED", connected: false });
          break;

        case "model.changed":
          if (msg.model && msg.sessionKey) {
            dlog.info("Model", `Session model changed to: ${msg.model} (session: ${msg.sessionKey})`);
            dispatch({ type: "SET_SESSION_MODEL", model: msg.model as string });
            // Persist per-session model to localStorage
            try {
              const stored = JSON.parse(localStorage.getItem("botschat:sessionModels") || "{}");
              stored[msg.sessionKey as string] = msg.model;
              localStorage.setItem("botschat:sessionModels", JSON.stringify(stored));
            } catch { /* ignore */ }
          }
          break;

        case "agent.stream.start":
          // Only start streaming in the currently viewed session — otherwise
          // background cron-task streams would inject a placeholder into the
          // wrong chat, and the subsequent agent.text would replace the user's
          // last message.
          if (sessionKey && isCurrentSession(sessionKey)) {
            // Detect thread streaming: threadId from message or extracted from sessionKey
            const streamThreadId = threadId ?? sessionKey.match(/:thread:(.+)$/)?.[1];
            dispatch({
              type: "STREAM_START",
              runId: msg.runId as string,
              sessionKey,
              threadId: streamThreadId,
            });
          }
          break;

        case "agent.stream.chunk":
          // Already guarded by streamingRunId match in the reducer — if
          // STREAM_START was skipped (different session), chunks are no-ops.
          dispatch({
            type: "STREAM_CHUNK",
            runId: msg.runId as string,
            sessionKey: sessionKey ?? "",
            text: msg.text as string,
          });
          break;

        case "agent.stream.end":
          dispatch({
            type: "STREAM_END",
            runId: msg.runId as string,
          });
          break;

        case "agent.text": {
          // Skip messages for sessions we're not viewing — they'll be loaded
          // from the server when the user navigates to that session.
          if (!isCurrentSession(sessionKey)) break;
          const chatMsg: ChatMessage = {
            id: crypto.randomUUID(),
            sender: "agent",
            text: msg.text as string,
            timestamp: Date.now(),
            threadId,
          };
          if (threadId && sessionKey) {
            dispatch({ type: "ADD_THREAD_MESSAGE", message: chatMsg });
          } else {
            dispatch({ type: "ADD_MESSAGE", message: chatMsg });
          }
          break;
        }

        case "agent.media": {
          if (!isCurrentSession(sessionKey)) break;
          const mediaMsg: ChatMessage = {
            id: crypto.randomUUID(),
            sender: "agent",
            text: (msg.caption as string) ?? "",
            mediaUrl: msg.mediaUrl as string,
            timestamp: Date.now(),
            threadId,
          };
          if (threadId && sessionKey) {
            dispatch({ type: "ADD_THREAD_MESSAGE", message: mediaMsg });
          } else {
            dispatch({ type: "ADD_MESSAGE", message: mediaMsg });
          }
          break;
        }

        case "agent.a2ui": {
          if (!isCurrentSession(sessionKey)) break;
          const a2uiMsg: ChatMessage = {
            id: crypto.randomUUID(),
            sender: "agent",
            text: "",
            a2ui: msg.jsonl as string,
            timestamp: Date.now(),
            threadId,
          };
          if (threadId && sessionKey) {
            dispatch({ type: "ADD_THREAD_MESSAGE", message: a2uiMsg });
          } else {
            dispatch({ type: "ADD_MESSAGE", message: a2uiMsg });
          }
          break;
        }

        case "job.update": {
          // A background task job completed/updated
          const job = {
            id: msg.jobId as string,
            number: 0,
            sessionKey: msg.sessionKey as string,
            status: msg.status as "running" | "ok" | "error" | "skipped",
            startedAt: msg.startedAt as number,
            finishedAt: (msg.finishedAt as number) ?? null,
            durationMs: (msg.durationMs as number) ?? null,
            summary: (msg.summary as string) ?? "",
            time: new Date(((msg.startedAt as number) ?? 0) * 1000).toLocaleString(),
          };

          // Update Messages view jobs
          if (job.status === "running") {
            dispatch({ type: "ADD_JOB", job });
          } else {
            // Check if we already have this job (was "running", now finished)
            const s = stateRef.current;
            const existsInJobs = s.jobs.some((j) => j.id === job.id);
            if (existsInJobs) {
              // Update in place
              dispatch({ type: "SET_JOBS", jobs: s.jobs.map((j) => j.id === job.id ? { ...j, ...job } : j) });
            } else {
              dispatch({ type: "ADD_JOB", job });
            }
          }

          // Update Automations view cronJobs
          if (job.status === "running") {
            dispatch({ type: "ADD_CRON_JOB", job });
          } else {
            dispatch({ type: "UPDATE_CRON_JOB", job });
          }
          break;
        }

        case "job.output": {
          // Streaming output from a running job — update the job's summary in real-time
          const outputJobId = msg.jobId as string;
          const outputText = msg.text as string;
          if (outputJobId && outputText) {
            dispatch({ type: "APPEND_JOB_OUTPUT", jobId: outputJobId, text: outputText });
          }
          break;
        }

        case "task.scan.result": {
          // Task scan completed — backend may have auto-created a default channel
          // for orphan cron jobs. Reload agents, channels, and basic task metadata.
          const scannedTasks = (msg.tasks as Array<{
            cronJobId: string;
            name: string;
            schedule: string;
            agentId: string;
            enabled: boolean;
            instructions?: string;
            model?: string;
          }>) ?? [];
          dlog.info("TaskScan", `Scan result: ${scannedTasks.length} tasks reported`, scannedTasks);

          // Reload agents and channels (backend may have created new ones)
          agentsApi.list().then(({ agents }) => {
            dlog.info("TaskScan", `Reloaded ${agents.length} agents`);
            dispatch({ type: "SET_AGENTS", agents });
          });
          channelsApi.list().then(({ channels }) => {
            dlog.info("TaskScan", `Reloaded ${channels.length} channels`);
            dispatch({ type: "SET_CHANNELS", channels });
          });

          // Reload basic task metadata from D1, then merge OpenClaw-owned
          // fields (schedule, instructions, model) from the scan results.
          tasksApi.listAll("background").then(({ tasks: cronTasks }) => {
            dlog.info("TaskScan", `Reloaded ${cronTasks.length} cron tasks, merging scan data`);
            dispatch({ type: "SET_CRON_TASKS", cronTasks });
            // Merge schedule/instructions/model from scan results
            dispatch({
              type: "MERGE_SCAN_DATA",
              scanTasks: scannedTasks.map((t) => ({
                cronJobId: t.cronJobId,
                schedule: t.schedule,
                instructions: t.instructions ?? "",
                model: t.model,
                enabled: t.enabled,
              })),
            });
          });

          const s = stateRef.current;
          if (s.selectedAgentId) {
            const currentAgent = s.agents.find((a) => a.id === s.selectedAgentId);
            if (currentAgent?.channelId) {
              tasksApi.list(currentAgent.channelId).then(({ tasks }) => {
                dispatch({ type: "SET_TASKS", tasks });
              });
            }
          }
          break;
        }

        case "status":
          // Status pings carry the gateway default model, not the per-session model.
          // model.changed is the authoritative source, so we intentionally ignore status.model.
          break;

        case "models.list":
          if (Array.isArray(msg.models)) {
            dispatch({ type: "SET_MODELS", models: msg.models as ModelInfo[] });
          }
          break;

        case "task.schedule.ack":
          if (msg.ok as boolean) {
            dlog.info("Task", `Schedule applied to OpenClaw: ${msg.cronJobId}`);
          } else {
            dlog.error("Task", `Schedule push to OpenClaw failed: ${msg.error}`, msg);
            // TODO: could revert optimistic update here
          }
          break;

        case "error":
          dlog.error("Server", msg.message as string, msg);
          break;

        default:
          break;
      }
    },
    [],
  );

  useEffect(() => {
    handleWSMessageRef.current = handleWSMessage;
  }, [handleWSMessage]);

  // ---- WebSocket connection ----
  useEffect(() => {
    if (!state.user) return;

    const token = getToken();
    if (!token) return;

    const sessionId = crypto.randomUUID();
    dlog.info("WS", `Connecting WebSocket (session=${sessionId.slice(0, 8)}...)`);
    const client = new BotsChatWSClient({
      userId: state.user.id,
      sessionId,
      token,
      onMessage: (msg) => {
        handleWSMessageRef.current(msg);
      },
      onStatusChange: (connected) => {
        dlog.info("WS", connected ? "WebSocket connected" : "WebSocket disconnected");
        dispatch({ type: "SET_WS_CONNECTED", connected });
      },
    });

    client.connect();
    wsClientRef.current = client;

    return () => {
      client.disconnect();
      wsClientRef.current = null;
    };
  }, [state.user]);

  const sendMessage = useCallback((msg: WSMessage) => {
    dlog.wsOut("WS", `${msg.type}`, msg);
    wsClientRef.current?.send(msg);
  }, []);

  const handleDefaultModelChange = useCallback(async (modelId: string) => {
    dispatch({ type: "SET_DEFAULT_MODEL", model: modelId || null });
    try {
      await meApi.updateSettings({ defaultModel: modelId || undefined });
    } catch (err) {
      console.error("Failed to update default model:", err);
    }
  }, []);

  const handleSelectJob = useCallback(
    (jobId: string) => {
      const job = state.jobs.find((j) => j.id === jobId);
      if (job) {
        dispatch({
          type: "SELECT_JOB",
          jobId: job.id,
          sessionKey: job.sessionKey || undefined,
        });
      }
    },
    [state.jobs],
  );

  // Auto-dismiss onboarding when OpenClaw connects
  useEffect(() => {
    if (state.openclawConnected && !onboardingDismissed) {
      // Delay slightly so user sees the "Connected!" success state
      const timer = setTimeout(() => {
        handleDismissOnboarding();
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [state.openclawConnected, onboardingDismissed, handleDismissOnboarding]);

  // ---- Render ----
  if (!state.user) {
    return (
      <AppStateContext.Provider value={state}>
        <AppDispatchContext.Provider value={dispatch}>
          <LoginPage />
        </AppDispatchContext.Provider>
      </AppStateContext.Provider>
    );
  }

  // Show onboarding for new users: channels have been fetched (first API call completed)
  // and none exist. This prevents flashing onboarding for returning users whose
  // channel list simply hasn't loaded yet.
  const showOnboarding = !onboardingDismissed && channelsLoadedOnce && state.channels.length === 0 && !state.openclawConnected;

  if (showOnboarding) {
    return (
      <AppStateContext.Provider value={state}>
        <AppDispatchContext.Provider value={dispatch}>
          <OnboardingPage onSkip={handleDismissOnboarding} />
        </AppDispatchContext.Provider>
      </AppStateContext.Provider>
    );
  }

  const selectedAgent = state.agents.find((a) => a.id === state.selectedAgentId);
  const selectedTask = state.tasks.find((t) => t.id === state.selectedTaskId);
  const isBackgroundTask = selectedTask?.kind === "background";
  const hasSession = Boolean(state.selectedSessionKey);

  const isAutomationsView = state.activeView === "automations";

  // ---- Mobile layout ----
  if (isMobile) {
    return (
      <AppStateContext.Provider value={state}>
        <AppDispatchContext.Provider value={dispatch}>
          <MobileLayout
            sendMessage={sendMessage}
            theme={theme}
            onToggleTheme={toggleTheme}
            showSettings={showSettings}
            onOpenSettings={() => setShowSettings(true)}
            onCloseSettings={() => setShowSettings(false)}
            handleDefaultModelChange={handleDefaultModelChange}
            handleSelectJob={handleSelectJob}
          />
        </AppDispatchContext.Provider>
      </AppStateContext.Provider>
    );
  }

  // ---- Desktop layout with resizable panels ----
  return (
    <AppStateContext.Provider value={state}>
      <AppDispatchContext.Provider value={dispatch}>
        <div className="flex flex-col h-screen">
          <div className="flex flex-1 min-h-0">
            {/* Icon Rail — fixed 48px, outside Group */}
            <IconRail onToggleTheme={toggleTheme} onOpenSettings={() => setShowSettings(true)} theme={theme} />

            {/* Resizable panels: Sidebar + Content */}
            <Group
              orientation="horizontal"
              defaultLayout={mainLayout.defaultLayout}
              onLayoutChanged={mainLayout.onLayoutChanged}
              id="botschat-main"
              className="flex-1"
            >
              {/* Sidebar panel */}
              <Panel id="sidebar" defaultSize="15%" minSize="5%" maxSize="30%">
                {isAutomationsView ? <CronSidebar /> : <Sidebar />}
              </Panel>

              <ResizeHandle />

              {/* Main content panel */}
              <Panel id="content">
                {isAutomationsView ? (
                  <CronDetail />
                ) : (
                  <div className="flex-1 flex flex-col min-w-0 h-full">
                    {hasSession ? (
                      <Group
                        orientation="horizontal"
                        defaultLayout={contentLayout.defaultLayout}
                        onLayoutChanged={contentLayout.onLayoutChanged}
                        id="botschat-content"
                      >
                        {/* JobList — conditional */}
                        {isBackgroundTask && (
                          <>
                            <Panel id="joblist" defaultSize="15%" minSize="5%" maxSize="30%">
                              <JobList
                                jobs={state.jobs}
                                selectedJobId={state.selectedJobId}
                                onSelectJob={handleSelectJob}
                              />
                            </Panel>
                            <ResizeHandle />
                          </>
                        )}

                        {/* ChatWindow — main area */}
                        <Panel id="chat">
                          <ChatWindow sendMessage={sendMessage} />
                        </Panel>

                        {/* ThreadPanel — conditional */}
                        {state.activeThreadId && (
                          <>
                            <ResizeHandle />
                            <Panel id="thread" defaultSize="28%" minSize="10%" maxSize="50%">
                              <ThreadPanel sendMessage={sendMessage} />
                            </Panel>
                          </>
                        )}
                      </Group>
                    ) : (
                      <div className="flex-1 flex items-center justify-center" style={{ background: "var(--bg-surface)" }}>
                        <div className="text-center">
                          <svg
                            className="w-20 h-20 mx-auto mb-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={1}
                            style={{ color: "var(--text-muted)" }}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                            />
                          </svg>
                          <p className="text-body font-bold" style={{ color: "var(--text-muted)" }}>
                            Select a channel to get started
                          </p>
                          <p className="text-caption mt-1" style={{ color: "var(--text-muted)" }}>
                            Choose a channel from the sidebar
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </Panel>
            </Group>
          </div>

          {/* Global debug log panel — collapsible at bottom */}
          <DebugLogPanel />
        </div>

        {/* Settings modal */}
        {showSettings && (
          <div
            className="fixed inset-0 flex items-center justify-center z-50"
            style={{ background: "rgba(0,0,0,0.5)" }}
            onClick={() => setShowSettings(false)}
          >
            <div
              className="rounded-lg p-6 w-[540px] max-w-[90vw] max-h-[85vh] flex flex-col"
              style={{ background: "var(--bg-surface)", boxShadow: "var(--shadow-lg)" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-h1 font-bold" style={{ color: "var(--text-primary)" }}>
                  Settings
                </h2>
                <button
                  onClick={() => setShowSettings(false)}
                  className="p-1 hover:bg-[--bg-hover] rounded"
                  style={{ color: "var(--text-muted)" }}
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Tab bar */}
              <div className="flex gap-4 mb-4" style={{ borderBottom: "1px solid var(--border)" }}>
                <button
                  className="pb-2 text-caption font-bold transition-colors"
                  style={{
                    color: settingsTab === "general" ? "var(--text-primary)" : "var(--text-muted)",
                    borderBottom: settingsTab === "general" ? "2px solid var(--bg-active)" : "2px solid transparent",
                    marginBottom: "-1px",
                  }}
                  onClick={() => setSettingsTab("general")}
                >
                  General
                </button>
                <button
                  className="pb-2 text-caption font-bold transition-colors"
                  style={{
                    color: settingsTab === "connection" ? "var(--text-primary)" : "var(--text-muted)",
                    borderBottom: settingsTab === "connection" ? "2px solid var(--bg-active)" : "2px solid transparent",
                    marginBottom: "-1px",
                  }}
                  onClick={() => setSettingsTab("connection")}
                >
                  Connection
                </button>
                <button
                  className="pb-2 text-caption font-bold transition-colors"
                  style={{
                    color: settingsTab === "security" ? "var(--text-primary)" : "var(--text-muted)",
                    borderBottom: settingsTab === "security" ? "2px solid var(--bg-active)" : "2px solid transparent",
                    marginBottom: "-1px",
                  }}
                  onClick={() => setSettingsTab("security")}
                >
                  Security
                </button>
              </div>

              {/* Tab content — scrollable */}
              <div className="flex-1 min-h-0 overflow-y-auto">
                {settingsTab === "general" && (
                  <div className="space-y-5">
                    {/* Default Model */}
                    <div>
                      <label
                        className="block text-caption font-bold mb-1.5"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        Default Model
                      </label>
                      <ModelSelect
                        value={state.defaultModel ?? ""}
                        onChange={handleDefaultModelChange}
                        models={state.models}
                        placeholder="Not set (use agent default)"
                      />
                      <p className="text-tiny mt-1.5" style={{ color: "var(--text-muted)" }}>
                        Default model for new conversations. You can override per session using{" "}
                        <code>/model</code> or per automation in its settings.
                      </p>
                    </div>

                    {/* Current Session Model */}
                    <div>
                      <label
                        className="block text-caption font-bold mb-1.5"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        Current Session Model
                      </label>
                      <span
                        className="text-body font-mono"
                        style={{ color: (state.sessionModel || state.defaultModel) ? "var(--text-primary)" : "var(--text-muted)" }}
                      >
                        {state.sessionModel ?? state.defaultModel ?? "Not connected"}
                      </span>
                    </div>
                  </div>
                )}

                {settingsTab === "connection" && (
                  <ConnectionSettings />
                )}

                {settingsTab === "security" && (
                  <E2ESettings />
                )}
              </div>

              <div
                className="mt-4 pt-4 flex justify-end"
                style={{ borderTop: "1px solid var(--border)" }}
              >
                <button
                  onClick={() => setShowSettings(false)}
                  className="px-4 py-1.5 text-caption font-bold text-white rounded-sm"
                  style={{ background: "var(--bg-active)" }}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        )}

      </AppDispatchContext.Provider>
    </AppStateContext.Provider>
  );
}
