import React, { useState, useRef, useEffect } from "react";
import { useAppState, useAppDispatch } from "../store";
import { agentsApi, channelsApi } from "../api";
import { dlog } from "../debug-log";

export function Sidebar({ onOpenSettings, onNavigate }: { onOpenSettings?: () => void; onNavigate?: () => void } = {}) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [channelsExpanded, setChannelsExpanded] = useState(true);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    dlog.info("Channel", `Creating channel: "${newName}"${newDesc ? ` (${newDesc})` : ""}`);
    try {
      await channelsApi.create({ name: newName, description: newDesc });
      const { agents } = await agentsApi.list();
      const { channels } = await channelsApi.list();
      dispatch({ type: "SET_AGENTS", agents });
      dispatch({ type: "SET_CHANNELS", channels });
      const created = agents.find((a) => a.name === newName.trim());
      if (created) {
        dlog.info("Channel", `Channel created → agent ${created.id}, auto-selected`);
        dispatch({
          type: "SELECT_AGENT",
          agentId: created.id,
          sessionKey: created.sessionKey,
        });
        try { localStorage.setItem("botschat_last_agent", created.id); } catch { /* ignore */ }
        onNavigate?.();
      }
      setShowCreate(false);
      setNewName("");
      setNewDesc("");
    } catch (err) {
      dlog.error("Channel", `Failed to create channel: ${err}`);
    }
  };

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleSelectAgent = (agentId: string, sessionKey: string) => {
    // Ensure activeView is "messages" — on mobile there's no IconRail, so
    // if the user was last viewing automations, session loading would be
    // blocked by the `isMessagesView` guard in App.tsx.
    if (state.activeView !== "messages") {
      dispatch({ type: "SET_ACTIVE_VIEW", view: "messages" });
    }
    // On mobile, always call onNavigate so tapping the already-selected
    // channel navigates back to the chat view.
    if (state.selectedAgentId === agentId) {
      onNavigate?.();
      return;
    }
    const agent = state.agents.find((a) => a.id === agentId);
    dlog.info("Channel", `Selected channel: ${agent?.name ?? agentId} (session=${sessionKey})`);
    dispatch({ type: "SELECT_AGENT", agentId, sessionKey });
    onNavigate?.();
    // Persist last selected channel so it survives page refresh
    try { localStorage.setItem("botschat_last_agent", agentId); } catch { /* ignore */ }
  };

  const handleDeleteChannel = async (channelId: string) => {
    const channel = state.channels.find((c) => c.id === channelId);
    dlog.info("Channel", `Deleting channel: ${channel?.name ?? channelId}`);
    try {
      await channelsApi.delete(channelId);
      dlog.info("Channel", `Channel deleted: ${channel?.name ?? channelId}`);
      // If the deleted channel's agent is currently selected, clear selection
      const deletedAgent = state.agents.find((a) => a.channelId === channelId);
      if (deletedAgent && state.selectedAgentId === deletedAgent.id) {
        dispatch({ type: "SELECT_AGENT", agentId: null, sessionKey: null });
      }
      // Refresh agents and channels
      const { agents } = await agentsApi.list();
      const { channels } = await channelsApi.list();
      dispatch({ type: "SET_AGENTS", agents });
      dispatch({ type: "SET_CHANNELS", channels });
    } catch (err) {
      dlog.error("Channel", `Failed to delete channel: ${err}`);
    } finally {
      setConfirmDeleteId(null);
    }
  };

  // Split agents: default agent vs channel agents
  // Hide the auto-created "Default" channel (used only for cron import) from Messages view
  const defaultAgents = state.agents.filter((a) => a.isDefault);
  const channelAgents = state.agents.filter((a) => !a.isDefault && a.name !== "Default");

  return (
    <div
      className="flex flex-col"
      style={{ background: "var(--bg-secondary)" }}
    >
      {/* Workspace Switcher */}
      <div className="px-4 py-3 flex items-center gap-2">
        <span className="text-[--text-sidebar-active] font-bold text-h2 truncate flex-1">
          BotsChat
        </span>
        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            className="p-1 rounded transition-colors hover:bg-[--sidebar-hover]"
            style={{ color: "var(--text-sidebar)" }}
            title="Settings"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        )}
        <svg className="w-3 h-3 text-[--text-sidebar]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {/* Connection status */}
      <div className="px-4 pb-2">
        <div className="flex items-center gap-1.5">
          <div
            className="w-2 h-2 rounded-full"
            style={{ background: state.openclawConnected ? "var(--accent-green)" : "var(--accent-red)" }}
          />
          <span className="text-tiny text-[--text-muted]">
            {state.openclawConnected ? "OpenClaw connected" : "OpenClaw offline"}
          </span>
        </div>
      </div>

      {/* Navigation list */}
      <div className="flex-1 overflow-y-auto sidebar-scroll">
        {/* Channels section */}
        <SectionHeader
          label="Channels"
          expanded={channelsExpanded}
          onToggle={() => setChannelsExpanded(!channelsExpanded)}
          onAdd={(e) => {
            e.stopPropagation();
            if (!channelsExpanded) setChannelsExpanded(true);
            setShowCreate(!showCreate);
          }}
        />
        {channelsExpanded && (
          <div>
            {defaultAgents.map((a) => (
              <SidebarItem
                key={a.id}
                label={`# ${a.name}`}
                active={state.selectedAgentId === a.id}
                onClick={() => handleSelectAgent(a.id, a.sessionKey)}
              />
            ))}
            {channelAgents.map((a) => (
              <SidebarItem
                key={a.id}
                label={`# ${a.name}`}
                active={state.selectedAgentId === a.id}
                onClick={() => handleSelectAgent(a.id, a.sessionKey)}
                showDelete
                confirmDelete={confirmDeleteId === a.channelId}
                onDeleteClick={(e) => {
                  e.stopPropagation();
                  setConfirmDeleteId(a.channelId);
                }}
                onDeleteConfirm={(e) => {
                  e.stopPropagation();
                  if (a.channelId) handleDeleteChannel(a.channelId);
                }}
                onDeleteCancel={(e) => {
                  e.stopPropagation();
                  setConfirmDeleteId(null);
                }}
              />
            ))}
            {channelAgents.length === 0 && defaultAgents.length === 0 && (
              <div className="px-8 py-2 text-tiny text-[--text-muted]">
                Loading channels…
              </div>
            )}
            {/* Inline create channel form */}
            {showCreate && (
              <div className="px-4 py-2 space-y-2">
                <input
                  type="text"
                  placeholder="Channel name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && handleCreate()}
                  className="w-full px-2 py-1.5 text-caption text-[--text-sidebar] rounded-sm focus:outline-none placeholder:text-[--text-muted]"
                  style={{ background: "var(--sidebar-hover)", border: "1px solid var(--sidebar-border)" }}
                  autoFocus
                />
                <input
                  type="text"
                  placeholder="Description (optional)"
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && handleCreate()}
                  className="w-full px-2 py-1.5 text-caption text-[--text-sidebar] rounded-sm focus:outline-none placeholder:text-[--text-muted]"
                  style={{ background: "var(--sidebar-hover)", border: "1px solid var(--sidebar-border)" }}
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleCreate}
                    className="flex-1 px-3 py-1.5 text-caption bg-[--bg-active] text-white rounded-sm font-bold hover:brightness-110"
                  >
                    Create
                  </button>
                  <button
                    onClick={() => setShowCreate(false)}
                    className="px-3 py-1.5 text-caption text-[--text-muted] hover:text-[--text-sidebar]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionHeader({
  label,
  expanded,
  onToggle,
  onAdd,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  onAdd?: (e: React.MouseEvent) => void;
}) {
  return (
    <div className="w-full flex items-center px-4 py-1.5">
      <button
        onClick={onToggle}
        className="flex items-center gap-1 text-tiny uppercase tracking-wider text-[--text-sidebar] hover:text-[--text-sidebar-active] transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform ${expanded ? "rotate-0" : "-rotate-90"}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
        {label}
      </button>
      {onAdd && (
        <button
          onClick={onAdd}
          className="ml-auto p-0.5 rounded transition-colors text-[--text-sidebar] hover:text-[--text-sidebar-active] hover:bg-[--sidebar-hover]"
          title={`New ${label.toLowerCase().replace(/s$/, "")}`}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>
      )}
    </div>
  );
}

function SidebarItem({
  label,
  active,
  onClick,
  showDelete,
  confirmDelete,
  onDeleteClick,
  onDeleteConfirm,
  onDeleteCancel,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  showDelete?: boolean;
  confirmDelete?: boolean;
  onDeleteClick?: (e: React.MouseEvent) => void;
  onDeleteConfirm?: (e: React.MouseEvent) => void;
  onDeleteCancel?: (e: React.MouseEvent) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);

  // Close confirmation when clicking outside
  useEffect(() => {
    if (!confirmDelete) return;
    const handler = (e: MouseEvent) => {
      if (confirmRef.current && !confirmRef.current.contains(e.target as Node)) {
        onDeleteCancel?.(e as unknown as React.MouseEvent);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [confirmDelete, onDeleteCancel]);

  if (confirmDelete) {
    return (
      <div
        ref={confirmRef}
        className="px-4 py-1.5 flex items-center gap-1.5"
        style={{ paddingLeft: 32, background: "var(--sidebar-hover)" }}
      >
        <span className="text-caption text-[--text-sidebar] truncate flex-1">Delete?</span>
        <button
          onClick={onDeleteConfirm}
          className="px-1.5 py-0.5 text-tiny rounded-sm font-bold text-white"
          style={{ background: "var(--accent-red, #e53935)" }}
        >
          Yes
        </button>
        <button
          onClick={onDeleteCancel}
          className="px-1.5 py-0.5 text-tiny rounded-sm text-[--text-muted] hover:text-[--text-sidebar]"
        >
          No
        </button>
      </div>
    );
  }

  return (
    <div
      className="relative group"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        onClick={onClick}
        className="w-full text-left py-[5px] text-body truncate transition-colors"
        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--sidebar-hover)"; }}
        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = active ? "var(--bg-hover)" : ""; }}
        style={{
          paddingLeft: active ? 29 : 32,
          paddingRight: showDelete ? 28 : undefined,
          background: active ? "var(--bg-hover)" : undefined,
          borderLeft: active ? "3px solid var(--bg-active)" : "3px solid transparent",
          color: active ? "var(--text-sidebar-active)" : "var(--text-sidebar)",
          fontWeight: active ? 700 : undefined,
        }}
      >
        {label}
      </button>
      {showDelete && hovered && (
        <button
          onClick={onDeleteClick}
          className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-sm text-[--text-muted] hover:text-[--accent-red] hover:bg-[--sidebar-hover] transition-colors"
          title="Delete channel"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      )}
    </div>
  );
}
