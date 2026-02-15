import React, { useState, useCallback } from "react";
import { useAppState, useAppDispatch } from "../store";
import { setToken, setRefreshToken } from "../api";
import type { WSMessage } from "../ws";
import { Sidebar } from "./Sidebar";
import { ChatWindow } from "./ChatWindow";
import { ThreadPanel } from "./ThreadPanel";
import { CronSidebar } from "./CronSidebar";
import { CronDetail } from "./CronDetail";
import { ModelSelect } from "./ModelSelect";
import { ConnectionSettings } from "./ConnectionSettings";
import { E2ESettings } from "./E2ESettings";
import { dlog } from "../debug-log";

/**
 * Mobile screen stack — unified home replaces separate channel-list / cron-list.
 * No bottom tab bar; Channels + Automations are both visible on the home screen.
 */
type MobileScreen =
  | "home"
  | "chat"
  | "thread"
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

  // Mobile navigation state — stack-based, unified home screen
  const [screen, setScreen] = useState<MobileScreen>(() => {
    if (state.selectedAgentId && state.selectedSessionKey) return "chat";
    return "home";
  });

  const [showUserMenu, setShowUserMenu] = useState(false);

  // Navigation to chat / cron-detail is handled explicitly by the onNavigate
  // callbacks passed to Sidebar and CronSidebar. We intentionally do NOT
  // auto-navigate when selectedAgentId / selectedCronTaskId change, because
  // App.tsx auto-selects an agent on mount — that would navigate to an empty
  // chat screen before sessions have loaded (issue #4a / #4b).

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
    setRefreshToken(null);
    dispatch({ type: "LOGOUT" });
  };

  const userInitial = state.user?.displayName?.[0]?.toUpperCase()
    ?? state.user?.email?.[0]?.toUpperCase()
    ?? "?";

  const goBack = useCallback(() => {
    switch (screen) {
      case "chat":
        setScreen("home");
        break;
      case "thread":
        dispatch({ type: "CLOSE_THREAD" });
        setScreen("chat");
        break;
      case "cron-detail":
        setScreen("home");
        break;
      default:
        break;
    }
  }, [screen, dispatch]);

  // Determine the header title
  const getHeaderTitle = (): string => {
    switch (screen) {
      case "home":
        return "BotsChat";
      case "chat": {
        const agent = state.agents.find((a) => a.id === state.selectedAgentId);
        return `# ${agent?.name ?? "Chat"}`;
      }
      case "thread":
        return "Thread";
      case "cron-detail": {
        const task = state.cronTasks.find((t) => t.id === state.selectedCronTaskId);
        return task?.name ?? "Task Detail";
      }
      default:
        return "BotsChat";
    }
  };

  const showBackButton = screen !== "home";

  return (
    <div
      className="flex flex-col"
      style={{
        height: "calc(100vh - var(--keyboard-height, 0px))",
        background: "var(--bg-surface)",
        transition: "height 0.2s ease-out",
      }}
    >
      {/* ---- Top nav bar (44px + safe area for standalone PWA) ---- */}
      <div
        className="flex items-center justify-between px-4 flex-shrink-0"
        style={{
          minHeight: "calc(44px + env(safe-area-inset-top, 0px))",
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
          {/* User avatar */}
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold text-white"
            style={{ background: "#9B59B6" }}
            title={state.user?.displayName ?? state.user?.email ?? "User"}
          >
            {userInitial}
          </button>
        </div>
      </div>

      {/* ---- User menu dropdown ---- */}
      {showUserMenu && (
        <div className="fixed inset-0 z-50" onClick={() => setShowUserMenu(false)}>
          <div
            className="absolute right-4 rounded-lg py-1 min-w-[200px]"
            style={{
              top: `calc(44px + env(safe-area-inset-top, 0px) + 4px)`,
              background: "var(--bg-surface)",
              border: "1px solid var(--border)",
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-2.5" style={{ borderBottom: "1px solid var(--border)" }}>
              <div className="text-body font-bold" style={{ color: "var(--text-primary)" }}>
                {state.user?.displayName ?? "User"}
              </div>
              <div className="text-caption" style={{ color: "var(--text-muted)" }}>
                {state.user?.email}
              </div>
            </div>
            <button
              className="w-full text-left px-4 py-2.5 text-body flex items-center gap-2.5"
              style={{ color: "var(--text-primary)" }}
              onClick={() => { onToggleTheme(); setShowUserMenu(false); }}
            >
              {theme === "dark" ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
                </svg>
              )}
              {theme === "dark" ? "Light Mode" : "Dark Mode"}
            </button>
            <button
              className="w-full text-left px-4 py-2.5 text-body flex items-center gap-2.5"
              style={{ color: "var(--text-primary)" }}
              onClick={() => { onOpenSettings(); setShowUserMenu(false); }}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Settings
            </button>
            <div style={{ borderTop: "1px solid var(--border)" }} />
            <button
              className="w-full text-left px-4 py-2.5 text-body flex items-center gap-2.5"
              style={{ color: "var(--accent-red)" }}
              onClick={() => { handleLogout(); setShowUserMenu(false); }}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
              </svg>
              Logout
            </button>
          </div>
        </div>
      )}

      {/* ---- Screen content ---- */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* Unified home: Channels + Automations in one scrollable list */}
        {screen === "home" && (
          <div className="flex-1 min-h-0 overflow-y-auto" style={{ background: "var(--bg-secondary)" }}>
            <Sidebar onOpenSettings={onOpenSettings} onNavigate={() => setScreen("chat")} />
            <CronSidebar onNavigate={() => setScreen("cron-detail")} />
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

        {screen === "cron-detail" && (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <CronDetail />
          </div>
        )}
      </div>

      {/* Settings modal */}
      {showSettings && (
        <MobileSettingsModal
          state={state}
          onClose={onCloseSettings}
          handleDefaultModelChange={handleDefaultModelChange}
        />
      )}
    </div>
  );
}

/** Mobile Settings modal — extracted to keep layout clean */
function MobileSettingsModal({
  state,
  onClose,
  handleDefaultModelChange,
}: {
  state: ReturnType<typeof useAppState>;
  onClose: () => void;
  handleDefaultModelChange: (modelId: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<"general" | "connection" | "security">("general");

  return (
    <div
      className="fixed inset-0 flex items-end justify-center z-50"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        className="w-full rounded-t-xl p-5 max-h-[85vh] flex flex-col"
        style={{
          background: "var(--bg-surface)",
          paddingBottom: "calc(20px + env(safe-area-inset-bottom, 0px))",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 rounded-full mx-auto mb-4" style={{ background: "var(--text-muted)" }} />
        <h2 className="text-h1 font-bold mb-3" style={{ color: "var(--text-primary)" }}>
          Settings
        </h2>

        {/* Tab bar */}
        <div className="flex gap-4 mb-4" style={{ borderBottom: "1px solid var(--border)" }}>
          <button
            className="pb-2 text-caption font-bold transition-colors"
            style={{
              color: tab === "general" ? "var(--text-primary)" : "var(--text-muted)",
              borderBottom: tab === "general" ? "2px solid var(--bg-active)" : "2px solid transparent",
              marginBottom: "-1px",
            }}
            onClick={() => setTab("general")}
          >
            General
          </button>
          <button
            className="pb-2 text-caption font-bold transition-colors"
            style={{
              color: tab === "connection" ? "var(--text-primary)" : "var(--text-muted)",
              borderBottom: tab === "connection" ? "2px solid var(--bg-active)" : "2px solid transparent",
              marginBottom: "-1px",
            }}
            onClick={() => setTab("connection")}
          >
            Connection
          </button>
          <button
            className="pb-2 text-caption font-bold transition-colors"
            style={{
              color: tab === "security" ? "var(--text-primary)" : "var(--text-muted)",
              borderBottom: tab === "security" ? "2px solid var(--bg-active)" : "2px solid transparent",
              marginBottom: "-1px",
            }}
            onClick={() => setTab("security")}
          >
            Security
          </button>
        </div>

        {/* Tab content — scrollable */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {tab === "general" && (
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
          )}

          {tab === "connection" && (
            <ConnectionSettings />
          )}

          {tab === "security" && (
            <E2ESettings />
          )}
        </div>

        <button
          onClick={onClose}
          className="w-full mt-4 py-2.5 text-caption font-bold text-white rounded-md shrink-0"
          style={{ background: "var(--bg-active)" }}
        >
          Done
        </button>
      </div>
    </div>
  );
}
