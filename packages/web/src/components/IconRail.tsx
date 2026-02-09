import React from "react";
import { useAppState, useAppDispatch, type ActiveView } from "../store";
import { setToken, setRefreshToken } from "../api";
import { dlog } from "../debug-log";

type IconRailProps = {
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  theme: "dark" | "light";
};

export function IconRail({ onToggleTheme, onOpenSettings, theme }: IconRailProps) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [showUserMenu, setShowUserMenu] = React.useState(false);

  const handleLogout = () => {
    dlog.info("Auth", `Logout — user ${state.user?.email}`);
    setToken(null);
    setRefreshToken(null);
    dispatch({ type: "LOGOUT" });
  };

  const setView = (view: ActiveView) => {
    dlog.info("Nav", `Switch view → ${view}`);
    dispatch({ type: "SET_ACTIVE_VIEW", view });
  };

  const userInitial = state.user?.displayName?.[0]?.toUpperCase()
    ?? state.user?.email?.[0]?.toUpperCase()
    ?? "?";

  return (
    <div
      className="flex flex-col items-center py-3 gap-2 h-full"
      style={{ width: 48, background: "var(--bg-primary)", borderRight: "1px solid var(--border)" }}
    >
      {/* Workspace icon */}
      <button
        className="w-8 h-8 rounded-lg flex items-center justify-center overflow-hidden hover:rounded-xl transition-all"
        title="BotsChat"
      >
        <img src="/botschat-logo.png" alt="BotsChat" className="w-8 h-8" />
      </button>

      <div className="w-7 border-t my-1" style={{ borderColor: "var(--sidebar-divider)" }} />

      {/* Home */}
      <RailIcon
        label="Home"
        active={false}
        icon={
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12l8.954-8.955a1.126 1.126 0 011.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25" />
          </svg>
        }
      />

      {/* Messages */}
      <RailIcon
        label="Messages"
        active={state.activeView === "messages"}
        onClick={() => setView("messages")}
        icon={
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 01-.825-.242m9.345-8.334a2.126 2.126 0 00-.476-.095 48.64 48.64 0 00-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0011.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
          </svg>
        }
      />

      {/* Automations */}
      <RailIcon
        label="Automations"
        active={state.activeView === "automations"}
        onClick={() => setView("automations")}
        icon={
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        }
      />

      <div className="flex-1" />

      {/* Settings */}
      <RailIcon
        label="Settings"
        active={false}
        onClick={onOpenSettings}
        icon={
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        }
      />

      {/* Theme toggle */}
      <RailIcon
        label={theme === "dark" ? "Light mode" : "Dark mode"}
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

      {/* User avatar + popover menu */}
      <div className="relative">
        <button
          onClick={() => setShowUserMenu(!showUserMenu)}
          className="w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold text-white mt-1 cursor-pointer"
          style={{ background: "#9B59B6" }}
          title={state.user?.displayName ?? state.user?.email ?? "User"}
        >
          {userInitial}
        </button>

        {showUserMenu && (
          <div className="fixed inset-0 z-50" onClick={() => setShowUserMenu(false)}>
            <div
              className="absolute rounded-lg py-1 min-w-[200px]"
              style={{
                bottom: 12,
                left: 56,
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
                style={{ color: "var(--accent-red)" }}
                onClick={() => { handleLogout(); setShowUserMenu(false); }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--sidebar-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = ""; }}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
                </svg>
                Logout
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function RailIcon({
  label,
  active,
  icon,
  onClick,
}: {
  label: string;
  active: boolean;
  icon: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <div className="relative flex items-center justify-center">
      {/* Active indicator - left bar */}
      {active && (
        <div
          className="absolute left-0 w-[3px] h-5 rounded-r-sm"
          style={{ left: -4, background: "var(--text-sidebar-active)" }}
        />
      )}
      <button
        onClick={onClick}
        className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
          active ? "text-[--text-sidebar-active]" : "text-[--text-sidebar] hover:text-[--text-sidebar-active]"
        }`}
        style={active ? { background: "var(--sidebar-hover)" } : undefined}
        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--sidebar-hover)"; }}
        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = ""; }}
        title={label}
        aria-label={label}
      >
        {icon}
      </button>
    </div>
  );
}
