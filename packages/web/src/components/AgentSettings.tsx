import React, { useState, useEffect, useCallback } from "react";
import { agentsV2Api, type AgentV2 } from "../api";
import { useAppState, useAppDispatch } from "../store";

const AGENT_TYPES = [
  { value: "openclaw", label: "OpenClaw", color: "#2BAC76" },
  { value: "cursor_cli", label: "Cursor CLI", color: "#3B82F6" },
  { value: "cursor_cloud", label: "Cursor Cloud", color: "#6366F1" },
  { value: "claude_code", label: "Claude Code", color: "#F59E0B" },
  { value: "mock", label: "Mock", color: "#9CA3AF" },
] as const;

const ROLES = [
  { value: "general", label: "General" },
  { value: "product_manager", label: "Product Manager" },
  { value: "developer", label: "Developer" },
  { value: "qa", label: "QA / Tester" },
  { value: "devops", label: "DevOps" },
] as const;

function AgentTypeIcon({ type, size = 20 }: { type: string; size?: number }) {
  const agentType = AGENT_TYPES.find((t) => t.value === type);
  const color = agentType?.color ?? "#9CA3AF";
  return (
    <div
      className="shrink-0 rounded-full flex items-center justify-center font-bold"
      style={{ width: size, height: size, background: color, color: "#fff", fontSize: size * 0.45 }}
    >
      {(agentType?.label ?? "?")[0]}
    </div>
  );
}

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span
      className="inline-block rounded-full"
      style={{
        width: 8,
        height: 8,
        background: connected ? "#2BAC76" : "var(--text-tertiary)",
      }}
    />
  );
}

export function AgentSettings({ onClose }: { onClose: () => void }) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const [agents, setAgents] = useState<AgentV2[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingAgent, setEditingAgent] = useState<AgentV2 | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const loadAgents = useCallback(async () => {
    setLoading(true);
    try {
      const data = await agentsV2Api.list();
      setAgents(data.agents);
      dispatch({ type: "SET_V2_AGENTS", agents: data.agents });
    } catch (err) {
      console.error("Failed to load agents:", err);
    } finally {
      setLoading(false);
    }
  }, [dispatch]);

  useEffect(() => { loadAgents(); }, [loadAgents]);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete agent "${name}"? This cannot be undone.`)) return;
    try {
      await agentsV2Api.delete(id);
      await loadAgents();
    } catch (err) {
      alert(`Failed to delete: ${err}`);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.5)" }}>
      <div
        className="w-full max-w-2xl max-h-[80vh] overflow-y-auto rounded-xl shadow-lg"
        style={{ background: "var(--bg-primary)", border: "1px solid var(--border)" }}
      >
        <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
          <h2 className="text-body font-semibold" style={{ color: "var(--text-primary)" }}>Agent Management</h2>
          <button onClick={onClose} className="text-caption" style={{ color: "var(--text-secondary)" }}>Close</button>
        </div>

        <div className="px-6 py-4">
          {loading ? (
            <p className="text-caption" style={{ color: "var(--text-secondary)" }}>Loading agents...</p>
          ) : (
            <>
              <div className="space-y-2">
                {agents.map((agent) => (
                  <div
                    key={agent.id}
                    className="flex items-center gap-3 px-4 py-3 rounded-lg"
                    style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)" }}
                  >
                    <AgentTypeIcon type={agent.type} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-caption font-medium" style={{ color: "var(--text-primary)" }}>
                          {agent.name}
                        </span>
                        <StatusDot connected={agent.status === "connected"} />
                        <span
                          className="text-tiny px-1.5 py-0.5 rounded"
                          style={{ background: "var(--bg-hover)", color: "var(--text-secondary)" }}
                        >
                          {ROLES.find((r) => r.value === agent.role)?.label ?? agent.role}
                        </span>
                      </div>
                      <div className="text-tiny" style={{ color: "var(--text-tertiary)" }}>
                        {AGENT_TYPES.find((t) => t.value === agent.type)?.label ?? agent.type}
                        {agent.skills.length > 0 && ` · ${agent.skills.map((s) => s.name).join(", ")}`}
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => setEditingAgent(agent)}
                        className="px-2.5 py-1 text-tiny rounded-sm"
                        style={{ background: "var(--bg-hover)", color: "var(--text-secondary)" }}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(agent.id, agent.name)}
                        className="px-2.5 py-1 text-tiny rounded-sm"
                        style={{ background: "var(--bg-hover)", color: "var(--accent-red)" }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <button
                onClick={() => setShowCreate(true)}
                className="mt-4 w-full py-2.5 text-caption font-medium rounded-lg transition-colors"
                style={{ background: "var(--accent-blue)", color: "#fff" }}
              >
                + Add Agent
              </button>
            </>
          )}
        </div>

        {(showCreate || editingAgent) && (
          <AgentForm
            agent={editingAgent}
            onSave={async () => {
              setShowCreate(false);
              setEditingAgent(null);
              await loadAgents();
            }}
            onCancel={() => { setShowCreate(false); setEditingAgent(null); }}
          />
        )}
      </div>
    </div>
  );
}

function AgentForm({
  agent,
  onSave,
  onCancel,
}: {
  agent: AgentV2 | null;
  onSave: () => void;
  onCancel: () => void;
}) {
  const isEdit = !!agent;
  const [name, setName] = useState(agent?.name ?? "");
  const [type, setType] = useState(agent?.type ?? "openclaw");
  const [role, setRole] = useState(agent?.role ?? "general");
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? "");
  const [skillsText, setSkillsText] = useState(
    agent?.skills.map((s) => `${s.name}: ${s.description}`).join("\n") ?? "",
  );
  const [pairingToken, setPairingToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");

    const skills = skillsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const colonIdx = line.indexOf(":");
        return colonIdx > 0
          ? { name: line.slice(0, colonIdx).trim(), description: line.slice(colonIdx + 1).trim() }
          : { name: line, description: "" };
      });

    try {
      if (isEdit) {
        await agentsV2Api.update(agent!.id, { name, role, systemPrompt, skills });
      } else {
        await agentsV2Api.create({
          name,
          type,
          role,
          systemPrompt,
          skills,
          pairingToken: pairingToken || undefined,
        });
      }
      onSave();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="px-6 py-4" style={{ borderTop: "1px solid var(--border)" }}>
      <h3 className="text-caption font-semibold mb-3" style={{ color: "var(--text-primary)" }}>
        {isEdit ? `Edit ${agent!.name}` : "Add New Agent"}
      </h3>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="flex gap-3">
          <label className="flex-1">
            <span className="text-tiny block mb-1" style={{ color: "var(--text-secondary)" }}>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 text-caption rounded-md"
              style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
              required
            />
          </label>
          {!isEdit && (
            <label className="w-40">
              <span className="text-tiny block mb-1" style={{ color: "var(--text-secondary)" }}>Type</span>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as AgentV2["type"])}
                className="w-full px-3 py-2 text-caption rounded-md"
                style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
              >
                {AGENT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </label>
          )}
          <label className="w-40">
            <span className="text-tiny block mb-1" style={{ color: "var(--text-secondary)" }}>Role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full px-3 py-2 text-caption rounded-md"
              style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
            >
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </label>
        </div>

        <label>
          <span className="text-tiny block mb-1" style={{ color: "var(--text-secondary)" }}>System Prompt</span>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 text-caption rounded-md resize-y"
            style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
            placeholder="You are a product manager who excels at..."
          />
        </label>

        <label>
          <span className="text-tiny block mb-1" style={{ color: "var(--text-secondary)" }}>Skills (one per line, format: name: description)</span>
          <textarea
            value={skillsText}
            onChange={(e) => setSkillsText(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 text-caption rounded-md resize-y font-mono"
            style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
            placeholder={"Code Review: Review code for quality and security\nRefactoring: Improve code structure"}
          />
        </label>

        {!isEdit && type === "openclaw" && (
          <label>
            <span className="text-tiny block mb-1" style={{ color: "var(--text-secondary)" }}>Pairing Token (optional)</span>
            <input
              value={pairingToken}
              onChange={(e) => setPairingToken(e.target.value)}
              className="w-full px-3 py-2 text-caption rounded-md font-mono"
              style={{ background: "var(--bg-secondary)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
              placeholder="bc_pat_..."
            />
          </label>
        )}

        {error && (
          <p className="text-tiny" style={{ color: "var(--accent-red)" }}>{error}</p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onCancel} className="px-4 py-2 text-caption rounded-md"
            style={{ background: "var(--bg-hover)", color: "var(--text-secondary)" }}>
            Cancel
          </button>
          <button type="submit" disabled={saving} className="px-4 py-2 text-caption font-medium rounded-md"
            style={{ background: "var(--accent-blue)", color: "#fff", opacity: saving ? 0.6 : 1 }}>
            {saving ? "Saving..." : isEdit ? "Update" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
