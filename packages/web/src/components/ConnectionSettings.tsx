import React, { useState, useEffect, useCallback } from "react";
import { pairingApi, setupApi, type PairingToken } from "../api";
import { useAppState } from "../store";
import { dlog } from "../debug-log";

/** Clipboard copy button with feedback */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="shrink-0 px-2.5 py-1 text-tiny font-medium rounded-sm transition-colors"
      style={{
        background: copied ? "var(--accent-green)" : "var(--bg-hover)",
        color: copied ? "#fff" : "var(--text-secondary)",
      }}
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

/** Code block with copy button */
function CodeBlock({ code }: { code: string }) {
  return (
    <div
      className="flex items-start gap-2 rounded-md px-3 py-2.5"
      style={{ background: "var(--code-bg)", border: "1px solid var(--border)" }}
    >
      <pre
        className="flex-1 text-caption font-mono overflow-x-auto whitespace-pre-wrap break-all"
        style={{ color: "var(--text-primary)" }}
      >
        {code}
      </pre>
      <CopyButton text={code} />
    </div>
  );
}

/** Relative time from a unix timestamp */
function timeAgo(unixTs: number): string {
  const now = Date.now() / 1000;
  const diff = now - unixTs;
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixTs * 1000).toLocaleDateString();
}

export function ConnectionSettings() {
  const state = useAppState();

  const [tokens, setTokens] = useState<PairingToken[]>([]);
  const [loadingTokens, setLoadingTokens] = useState(true);

  const [cloudUrl, setCloudUrl] = useState<string>(
    typeof window !== "undefined" ? window.location.origin : "https://console.botschat.app",
  );
  const [cloudUrlLoopback, setCloudUrlLoopback] = useState(false);
  const [cloudUrlHint, setCloudUrlHint] = useState<string | undefined>();
  const [editingUrl, setEditingUrl] = useState(false);

  const [showCreateToken, setShowCreateToken] = useState(false);
  const [newTokenLabel, setNewTokenLabel] = useState("");
  const [creatingToken, setCreatingToken] = useState(false);
  /** Token value of a freshly created token (only shown once, for the user to copy). */
  const [freshToken, setFreshToken] = useState<{ id: string; token: string } | null>(null);

  // Fetch recommended cloudUrl from backend
  useEffect(() => {
    let cancelled = false;

    setupApi
      .cloudUrl()
      .then((data) => {
        if (cancelled) return;
        setCloudUrl(data.cloudUrl);
        setCloudUrlLoopback(data.isLoopback);
        setCloudUrlHint(data.hint);
      })
      .catch((err) => {
        dlog.warn("ConnectionSettings", `Failed to fetch cloudUrl: ${err}`);
        const host = window.location.hostname;
        const loopback = host === "localhost" || host.startsWith("127.");
        setCloudUrlLoopback(loopback);
        if (loopback) {
          setCloudUrlHint(
            "This URL (localhost) only works on this machine. If your OpenClaw is on a different host, replace with its LAN IP.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch pairing tokens
  useEffect(() => {
    let cancelled = false;
    setLoadingTokens(true);

    pairingApi
      .list()
      .then(({ tokens: list }) => {
        if (!cancelled) setTokens(list);
      })
      .catch((err) => {
        dlog.error("ConnectionSettings", `Failed to list tokens: ${err}`);
      })
      .finally(() => {
        if (!cancelled) setLoadingTokens(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleCreateToken = useCallback(async () => {
    setCreatingToken(true);
    try {
      const result = await pairingApi.create(newTokenLabel.trim() || undefined);
      setFreshToken({ id: result.id, token: result.token });
      // Refresh token list
      const { tokens: refreshed } = await pairingApi.list();
      setTokens(refreshed);
      setNewTokenLabel("");
      setShowCreateToken(false);
    } catch (err) {
      dlog.error("ConnectionSettings", `Failed to create token: ${err}`);
    } finally {
      setCreatingToken(false);
    }
  }, [newTokenLabel]);

  const handleRevokeToken = useCallback(async (tokenId: string) => {
    try {
      await pairingApi.delete(tokenId);
      setTokens((prev) => prev.filter((t) => t.id !== tokenId));
      if (freshToken?.id === tokenId) setFreshToken(null);
    } catch (err) {
      dlog.error("ConnectionSettings", `Failed to revoke token: ${err}`);
    }
  }, [freshToken]);

  // The token to use in the setup command: only the freshly created token (shown once).
  // We never display full token values from the GET list (security: they are masked).
  const commandToken = freshToken?.token ?? null;

  const setupCommand = commandToken
    ? `openclaw plugins install @botschat/botschat && \\
openclaw config set channels.botschat.cloudUrl ${cloudUrl} && \\
openclaw config set channels.botschat.pairingToken ${commandToken} && \\
openclaw config set channels.botschat.enabled true && \\
openclaw gateway restart`
    : null;

  const isConnected = state.openclawConnected;

  return (
    <div className="space-y-5">
      {/* ---- Connection Status ---- */}
      <div>
        <label
          className="block text-caption font-bold mb-1.5"
          style={{ color: "var(--text-secondary)" }}
        >
          OpenClaw Status
        </label>
        <div
          className="flex items-center gap-3 rounded-md px-4 py-3"
          style={{
            background: isConnected ? "rgba(43, 172, 118, 0.1)" : "rgba(232, 162, 48, 0.1)",
            border: `1px solid ${isConnected ? "rgba(43, 172, 118, 0.3)" : "rgba(232, 162, 48, 0.3)"}`,
          }}
        >
          <span
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ background: isConnected ? "var(--accent-green)" : "var(--accent-yellow)" }}
          />
          <span
            className="text-caption font-medium"
            style={{ color: isConnected ? "var(--accent-green)" : "var(--accent-yellow)" }}
          >
            {isConnected ? "Connected to OpenClaw" : "Not connected"}
          </span>
        </div>
      </div>

      {/* ---- Setup Command ---- */}
      <div>
        <label
          className="block text-caption font-bold mb-1.5"
          style={{ color: "var(--text-secondary)" }}
        >
          Setup Command
        </label>
        <p className="text-tiny mb-2" style={{ color: "var(--text-muted)" }}>
          Run this on your OpenClaw machine to install and connect the plugin.
        </p>

        {/* Loopback URL warning */}
        {cloudUrlLoopback && (
          <div
            className="flex items-start gap-2 rounded-md px-3 py-2 mb-2 text-tiny"
            style={{
              background: "rgba(232, 162, 48, 0.1)",
              border: "1px solid rgba(232, 162, 48, 0.25)",
              color: "var(--accent-yellow)",
            }}
          >
            <svg className="w-3.5 h-3.5 mt-0.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z"
                clipRule="evenodd"
              />
            </svg>
            <span>
              {cloudUrlHint || "localhost URL may not be reachable from other machines."}{" "}
              <button
                onClick={() => setEditingUrl(true)}
                className="underline font-medium hover:brightness-110"
                style={{ color: "var(--text-link)" }}
              >
                Change URL
              </button>
            </span>
          </div>
        )}

        {/* Editable cloud URL inline */}
        {editingUrl && (
          <div className="flex items-center gap-2 mb-2">
            <label
              className="text-tiny font-bold shrink-0"
              style={{ color: "var(--text-secondary)" }}
            >
              Cloud URL:
            </label>
            <input
              type="text"
              value={cloudUrl}
              onChange={(e) => {
                setCloudUrl(e.target.value.replace(/\/+$/, ""));
                setCloudUrlLoopback(false);
              }}
              className="flex-1 px-2.5 py-1 rounded-sm text-tiny font-mono"
              style={{
                background: "var(--code-bg)",
                border: "1px solid var(--border)",
                color: "var(--text-primary)",
                outline: "none",
              }}
              placeholder="http://192.168.x.x:8787"
              autoFocus
            />
            <button
              onClick={() => setEditingUrl(false)}
              className="px-2.5 py-1 text-tiny font-medium rounded-sm"
              style={{ background: "var(--bg-active)", color: "#fff" }}
            >
              Done
            </button>
          </div>
        )}

        {loadingTokens ? (
          <div
            className="rounded-md px-3 py-2.5 animate-pulse"
            style={{ background: "var(--code-bg)", height: "64px" }}
          />
        ) : setupCommand ? (
          <CodeBlock code={setupCommand} />
        ) : (
          <div
            className="rounded-md px-4 py-3 text-caption"
            style={{
              background: "var(--code-bg)",
              border: "1px solid var(--border)",
              color: "var(--text-muted)",
            }}
          >
            {tokens.length > 0
              ? "Create a new pairing token below to generate the setup command. (Token values are only shown once at creation time.)"
              : "No pairing tokens available. Create one below to generate the setup command."}
          </div>
        )}

        {/* Cloud URL (non-editable display, with Edit button) */}
        {!editingUrl && (
          <div className="flex items-center gap-2 mt-2">
            <span className="text-tiny" style={{ color: "var(--text-muted)" }}>
              Cloud URL:
            </span>
            <code className="text-tiny font-mono" style={{ color: "var(--text-secondary)" }}>
              {cloudUrl}
            </code>
            <button
              onClick={() => setEditingUrl(true)}
              className="text-tiny hover:underline"
              style={{ color: "var(--text-link)" }}
            >
              Edit
            </button>
          </div>
        )}
      </div>

      {/* ---- Pairing Tokens ---- */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label
            className="text-caption font-bold"
            style={{ color: "var(--text-secondary)" }}
          >
            Pairing Tokens
          </label>
          <button
            onClick={() => setShowCreateToken(!showCreateToken)}
            className="text-tiny font-medium hover:underline"
            style={{ color: "var(--text-link)" }}
          >
            {showCreateToken ? "Cancel" : "+ New Token"}
          </button>
        </div>

        {/* Create token form */}
        {showCreateToken && (
          <div
            className="flex items-center gap-2 rounded-md px-3 py-2.5 mb-2"
            style={{ background: "var(--code-bg)", border: "1px solid var(--border)" }}
          >
            <input
              type="text"
              value={newTokenLabel}
              onChange={(e) => setNewTokenLabel(e.target.value)}
              placeholder="Token label (optional)"
              className="flex-1 px-2 py-1 rounded-sm text-tiny"
              style={{
                background: "var(--bg-surface)",
                border: "1px solid var(--border)",
                color: "var(--text-primary)",
                outline: "none",
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateToken();
              }}
              autoFocus
            />
            <button
              onClick={handleCreateToken}
              disabled={creatingToken}
              className="px-3 py-1 text-tiny font-medium rounded-sm text-white"
              style={{
                background: creatingToken ? "var(--text-muted)" : "var(--bg-active)",
              }}
            >
              {creatingToken ? "Creating..." : "Create"}
            </button>
          </div>
        )}

        {/* Freshly created token (highlight) */}
        {freshToken && (
          <div
            className="rounded-md px-3 py-2.5 mb-2"
            style={{
              background: "rgba(43, 172, 118, 0.08)",
              border: "1px solid rgba(43, 172, 118, 0.3)",
            }}
          >
            <div className="flex items-center justify-between mb-1">
              <span
                className="text-tiny font-bold"
                style={{ color: "var(--accent-green)" }}
              >
                New token created — copy it now (only shown once)
              </span>
              <button
                onClick={() => setFreshToken(null)}
                className="text-tiny"
                style={{ color: "var(--text-muted)" }}
              >
                Dismiss
              </button>
            </div>
            <div className="flex items-center gap-2">
              <code
                className="flex-1 text-tiny font-mono break-all"
                style={{ color: "var(--text-primary)" }}
              >
                {freshToken.token}
              </code>
              <CopyButton text={freshToken.token} />
            </div>
          </div>
        )}

        {/* Token list */}
        {loadingTokens ? (
          <div
            className="rounded-md px-3 py-4 animate-pulse"
            style={{ background: "var(--code-bg)" }}
          />
        ) : tokens.length === 0 ? (
          <p className="text-tiny py-2" style={{ color: "var(--text-muted)" }}>
            No active pairing tokens. Create one to connect your OpenClaw agent.
          </p>
        ) : (
          <div className="space-y-1">
            {tokens.map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-2 rounded-md px-3 py-2"
                style={{ background: "var(--code-bg)", border: "1px solid var(--border)" }}
              >
                <code
                  className="text-tiny font-mono shrink-0"
                  style={{ color: "var(--text-primary)" }}
                >
                  {t.tokenPreview}
                </code>
                {t.label && (
                  <span
                    className="text-tiny px-1.5 py-0.5 rounded"
                    style={{
                      background: "var(--bg-hover)",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {t.label}
                  </span>
                )}
                <span className="flex-1" />
                <span className="text-tiny" style={{ color: "var(--text-muted)" }}>
                  {t.lastConnectedAt ? timeAgo(t.lastConnectedAt) : "Never connected"}
                </span>
                <button
                  onClick={() => handleRevokeToken(t.id)}
                  className="text-tiny font-medium hover:underline shrink-0"
                  style={{ color: "var(--accent-red)" }}
                  title="Revoke this token"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
