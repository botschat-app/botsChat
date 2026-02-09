import React, { useState, useCallback } from "react";
import { useAppState, useAppDispatch, type ActiveView } from "../store";
import { setToken } from "../api";
import type { WSMessage } from "../ws";
import { Sidebar } from "./Sidebar";
import { ChatWindow } from "./ChatWindow";
import { ThreadPanel } from "./ThreadPanel";
import { JobList } from "./JobList";
import { CronSidebar } from "./CronSidebar";
import { CronDetail } from "./CronDetail";
import { ModelSelect } from "./ModelSelect";
import { dlog } from "../debug-log";

type MobileScreen =
  | "channel-list"
  | "chat"
  | "thread"
  | "cron-list"
  | "cron-detail";

type MobileLayoutProps = {
  sendMessage: (msg: WSMessage) => void;
  theme: "dark" | "light";
  onToggleTheme: () => void;
  showSettings: boolean;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  handleDefaultModelChange: (modelId: string) => Promise<void>;
  handleSelectJob: (jobId: string) => void;
};

export function MobileLayout({
  sendMessage,
  theme,
  onToggleTheme,
  showSettings,
  onOpenSettings,
  onCloseSettings,
  handleDefaultModelChange,
  handleSelectJob,
}: MobileLayoutProps) {
  const state = useAppState();
  const dispatch = useAppDispatch();

  // Mobile navigation state — stack-based
  const [screen, setScreen] = useState<MobileScreen>(() => {
    if (state.activeView === "automations") return "cron-list";
    if (state.selectedAgentId && state.selectedSessionKey) return "chat";
    return "channel-list";
  });

  const activeTab = state.activeView;

  const setActiveTab = useCallback((view: ActiveView) => {
    dispatch({ type: "SET_ACTIVE_VIEW", view });
    if (view === "messages") {
      if (state.selectedAgentId && state.selectedSessionKey) {
        setScreen("chat");
      } else {
        setScreen("channel-list");
      }
    } else {
      if (state.selectedCronTaskId) {
        setScreen("cron-detail");
      } else {
        setScreen("cron-list");
      }
    }
  }, [dispatch, state.selectedAgentId, state.selectedSessionKey, state.selectedCronTaskId]);

  // Navigate to chat when a channel is selected (via Sidebar's internal dispatch)
  // We listen for selectedAgentId changes to auto-navigate
  const prevAgentIdRef = React.useRef(state.selectedAgentId);
  React.useEffect(() => {
    if (state.selectedAgentId && state.selectedAgentId !== prevAgentIdRef.current && screen === "channel-list") {
      setScreen("chat");
    }
    prevAgentIdRef.current = state.selectedAgentId;
  }, [state.selectedAgentId, screen]);

  // Navigate to cron detail when a cron task is selected
  const prevCronTaskIdRef = React.useRef(state.selectedCronTaskId);
  React.useEffect(() => {
    if (state.selectedCronTaskId && state.selectedCronTaskId !== prevCronTaskIdRef.current && screen === "cron-list") {
      setScreen("cron-detail");
    }
    prevCronTaskIdRef.current = state.selectedCronTaskId;
  }, [state.selectedCronTaskId, screen]);

  // Navigate to thread when thread opens
  React.useEffect(() => {
    if (state.activeThreadId && screen === "chat") {
      setScreen("thread");
    }
  }, [state.activeThreadId, screen]);

  // Navigate back from thread when it closes
  React.useEffect(() => {
    if (!state.activeThreadId && screen === "thread") {
      setScreen("chat");
    }
  }, [state.activeThreadId, screen]);

  const handleLogout = () => {
    dlog.info("Auth", `Mobile logout — user ${state.user?.email}`);
    setToken(null);
    dispatch({ type: "LOGOUT" });
  };

  const goBack = useCallback(() => {
    switch (screen) {
      case "chat":
        setScreen("channel-list");
        break;
      case "thread":
        dispatch({ type: "CLOSE_THREAD" });
        setScreen("chat");
        break;
      case "cron-detail":
        setScreen("cron-list");
        break;
      default:
        break;
    }
  }, [screen, dispatch]);

  // Determine the header title
  const getHeaderTitle = (): string => {
    switch (screen) {
      case "channel-list":
        return "BotsChat";
      case "chat": {
        const agent = state.agents.find((a) => a.id === state.selectedAgentId);
        return `# ${agent?.name ?? "Chat"}`;
      }
      case "thread":
        return "Thread";
      case "cron-list":
        return "Automations";
      case "cron-detail": {
        const task = state.cronTasks.find((t) => t.id === state.selectedCronTaskId);
        return task?.name ?? "Task Detail";
      }
      default:
        return "BotsChat";
    }
  };

  const showBackButton = screen !== "channel-list" && screen !== "cron-list";

  return (
    <div
      className="flex flex-col h-screen"
      style={{ background: "var(--bg-surface)" }}
    >
      {/* ---- Top nav bar (44px + safe area for standalone PWA) ---- */}
      <div
        className="flex items-center justify-between px-4 flex-shrink-0"
        style={{
          height: 44,
          paddingTop: "env(safe-area-inset-top, 0px)",
          background: "var(--bg-primary)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          {showBackButton && (
            <button
              onClick={goBack}
              className="p-1 -ml-1 rounded"
              style={{ color: "var(--text-link)" }}
              aria-label="Back"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
            </button>
          )}
          <span
            className="text-h2 font-bold truncate"
            style={{ color: "var(--text-primary)" }}
          >
            {getHeaderTitle()}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {/* Connection indicator */}
          <div
            className="w-2 h-2 rounded-full mr-1"
            style={{ background: state.openclawConnected ? "var(--accent-green)" : "var(--accent-red)" }}
          />
          {/* Settings */}
          <button
            onClick={onOpenSettings}
            className="p-1.5 rounded"
            style={{ color: "var(--text-muted)" }}
          >
            <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* ---- Screen content ---- */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {screen === "channel-list" && (
          <div className="flex-1 min-h-0 overflow-y-auto" style={{ background: "var(--bg-secondary)" }}>
            <Sidebar />
          </div>
        )}

        {screen === "chat" && (
          <div className="flex-1 min-h-0 flex flex-col">
            <ChatWindow sendMessage={sendMessage} />
          </div>
        )}

        {screen === "thread" && (
          <div className="flex-1 min-h-0 flex flex-col">
            <ThreadPanel sendMessage={sendMessage} />
          </div>
        )}

        {screen === "cron-list" && (
          <div className="flex-1 min-h-0 overflow-y-auto" style={{ background: "var(--bg-secondary)" }}>
            <CronSidebar />
          </div>
        )}

        {screen === "cron-detail" && (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <CronDetail />
          </div>
        )}
      </div>

      {/* ---- Bottom tab bar (56px) ---- */}
      <div
        className="flex items-stretch flex-shrink-0"
        style={{
          height: 56,
          background: "var(--bg-primary)",
          borderTop: "1px solid var(--border)",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
      >
        <TabButton
          label="Messages"
          active={activeTab === "messages"}
          onClick={() => setActiveTab("messages")}
          icon={
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
            </svg>
          }
        />
        <TabButton
          label="Automations"
          active={activeTab === "automations"}
          onClick={() => setActiveTab("automations")}
          icon={
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <TabButton
          label={theme === "dark" ? "Light" : "Dark"}
          active={false}
          onClick={onToggleTheme}
          icon={
            theme === "dark" ? (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
              </svg>
            )
          }
        />
        <TabButton
          label="Logout"
          active={false}
          onClick={handleLogout}
          icon={
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
            </svg>
          }
        />
      </div>

      {/* Settings modal */}
      {showSettings && (
        <div
          className="fixed inset-0 flex items-end justify-center z-50"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={onCloseSettings}
        >
          <div
            className="w-full rounded-t-xl p-5 max-h-[80vh] overflow-y-auto"
            style={{
              background: "var(--bg-surface)",
              paddingBottom: "calc(20px + env(safe-area-inset-bottom, 0px))",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-10 h-1 rounded-full mx-auto mb-4" style={{ background: "var(--text-muted)" }} />
            <h2 className="text-h1 font-bold mb-4" style={{ color: "var(--text-primary)" }}>
              Settings
            </h2>

            <div className="space-y-4">
              <div>
                <label className="block text-caption font-bold mb-1.5" style={{ color: "var(--text-secondary)" }}>
                  Default Model
                </label>
                <ModelSelect
                  value={state.defaultModel ?? ""}
                  onChange={handleDefaultModelChange}
                  models={state.models}
                  placeholder="Not set (use agent default)"
                />
              </div>

              <div>
                <label className="block text-caption font-bold mb-1.5" style={{ color: "var(--text-secondary)" }}>
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

            <button
              onClick={onCloseSettings}
              className="w-full mt-5 py-2.5 text-caption font-bold text-white rounded-md"
              style={{ background: "var(--bg-active)" }}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
  icon,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors"
      style={{
        color: active ? "var(--text-link)" : "var(--text-muted)",
      }}
    >
      {icon}
      <span className="text-[10px] leading-tight">{label}</span>
    </button>
  );
}
