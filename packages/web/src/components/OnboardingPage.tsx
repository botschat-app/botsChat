import React, { useEffect, useState, useCallback } from "react";
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
      // Fallback for insecure context
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
function CodeBlock({ code, multiline }: { code: string; multiline?: boolean }) {
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

/** Pulsing dot for "waiting" state */
function PulsingDot({ color }: { color: string }) {
  return (
    <span className="relative flex h-3 w-3">
      <span
        className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
        style={{ backgroundColor: color }}
      />
      <span
        className="relative inline-flex rounded-full h-3 w-3"
        style={{ backgroundColor: color }}
      />
    </span>
  );
}

export function OnboardingPage({ onSkip }: { onSkip: () => void }) {
  const state = useAppState();
  const [pairingToken, setPairingToken] = useState<string | null>(null);
  const [loadingToken, setLoadingToken] = useState(true);

  // Cloud URL — resolved by backend (smart priority), editable by user
  const [cloudUrl, setCloudUrl] = useState<string>(
    typeof window !== "undefined" ? window.location.origin : "https://console.botschat.app",
  );
  const [cloudUrlLoopback, setCloudUrlLoopback] = useState(false);
  const [cloudUrlHint, setCloudUrlHint] = useState<string | undefined>();
  const [editingUrl, setEditingUrl] = useState(false);

  // Fetch recommended cloudUrl from backend
  useEffect(() => {
    let cancelled = false;

    async function fetchCloudUrl() {
      try {
        const data = await setupApi.cloudUrl();
        if (cancelled) return;
        setCloudUrl(data.cloudUrl);
        setCloudUrlLoopback(data.isLoopback);
        setCloudUrlHint(data.hint);
      } catch (err) {
        dlog.warn("Onboarding", `Failed to fetch cloudUrl, using origin: ${err}`);
        // Fallback: detect loopback from window.location
        const host = window.location.hostname;
        const loopback = host === "localhost" || host.startsWith("127.");
        setCloudUrlLoopback(loopback);
        if (loopback) {
          setCloudUrlHint(
            "This URL (localhost) only works on this machine. " +
            "If your OpenClaw is on a different host, replace with its LAN IP.",
          );
        }
      }
    }

    fetchCloudUrl();
    return () => { cancelled = true; };
  }, []);

  // Load or create pairing token
  useEffect(() => {
    let cancelled = false;

    async function ensurePairingToken() {
      setLoadingToken(true);
      try {
        // Check existing tokens
        const { tokens } = await pairingApi.list();
        if (cancelled) return;

        if (tokens.length > 0) {
          dlog.info("Onboarding", `Found ${tokens.length} existing pairing tokens`);
          const { token } = await pairingApi.create("Onboarding setup");
          if (!cancelled) setPairingToken(token);
        } else {
          dlog.info("Onboarding", "No pairing tokens found, creating one");
          const { token } = await pairingApi.create("Default");
          if (!cancelled) setPairingToken(token);
        }
      } catch (err) {
        dlog.error("Onboarding", `Failed to get pairing token: ${err}`);
      } finally {
        if (!cancelled) setLoadingToken(false);
      }
    }

    ensurePairingToken();
    return () => { cancelled = true; };
  }, []);

  const setupCommand = pairingToken
    ? `openclaw plugins install @botschat/openclaw-plugin && \\
openclaw config set channels.botschat.cloudUrl ${cloudUrl} && \\
openclaw config set channels.botschat.pairingToken ${pairingToken} && \\
openclaw config set channels.botschat.enabled true && \\
openclaw gateway restart`
    : "Loading...";

  const isConnected = state.openclawConnected;

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{ background: "var(--bg-secondary)" }}
    >
      <div className="w-full max-w-xl">
        {/* Header */}
        <div className="text-center mb-8">
          <div
            className="inline-flex items-center justify-center w-16 h-16 rounded-xl text-white text-2xl font-bold mb-4"
            style={{ background: "#1264A3" }}
          >
            BC
          </div>
          <h1 className="text-3xl font-bold" style={{ color: "var(--text-primary)" }}>
            Welcome to BotsChat!
          </h1>
          <p className="mt-2" style={{ color: "var(--text-secondary)" }}>
            Connect your OpenClaw agent to start chatting.
          </p>
        </div>

        {/* Main card */}
        <div
          className="rounded-md p-8"
          style={{
            background: "var(--bg-surface)",
            boxShadow: "var(--shadow-lg)",
          }}
        >
          {isConnected ? (
            /* Success state */
            <div className="text-center py-6">
              <div
                className="inline-flex items-center justify-center w-16 h-16 rounded-full mb-4"
                style={{ background: "rgba(43, 172, 118, 0.15)" }}
              >
                <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="var(--accent-green)" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="text-h1 font-bold mb-2" style={{ color: "var(--text-primary)" }}>
                OpenClaw Connected!
              </h2>
              <p className="text-body mb-6" style={{ color: "var(--text-secondary)" }}>
                Your agent is ready. Start chatting now.
              </p>
              <button
                onClick={onSkip}
                className="px-6 py-2.5 font-bold text-body text-white rounded-sm transition-colors hover:brightness-110"
                style={{ background: "var(--bg-active)" }}
              >
                Start Chatting
              </button>
            </div>
          ) : (
            /* Setup steps */
            <>
              {/* Connection status */}
              <div
                className="flex items-center gap-3 rounded-md px-4 py-3 mb-6"
                style={{
                  background: "rgba(232, 162, 48, 0.1)",
                  border: "1px solid rgba(232, 162, 48, 0.3)",
                }}
              >
                <PulsingDot color="var(--accent-yellow)" />
                <span className="text-caption font-medium" style={{ color: "var(--accent-yellow)" }}>
                  Waiting for OpenClaw connection...
                </span>
              </div>

              {/* Step 1 */}
              <div className="mb-6">
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className="inline-flex items-center justify-center w-6 h-6 rounded-full text-tiny font-bold text-white"
                    style={{ background: "var(--bg-active)" }}
                  >
                    1
                  </span>
                  <h3 className="text-body font-bold" style={{ color: "var(--text-primary)" }}>
                    Run this command on your OpenClaw machine
                  </h3>
                </div>
                <p className="text-caption mb-3 ml-8" style={{ color: "var(--text-secondary)" }}>
                  This installs the BotsChat plugin, configures the connection, and restarts the gateway.
                </p>
                {/* Loopback URL warning */}
                {cloudUrlLoopback && (
                  <div
                    className="flex items-start gap-2 rounded-md px-3 py-2.5 mb-3 ml-8 text-caption"
                    style={{
                      background: "rgba(232, 162, 48, 0.1)",
                      border: "1px solid rgba(232, 162, 48, 0.25)",
                      color: "var(--accent-yellow)",
                    }}
                  >
                    <svg className="w-4 h-4 mt-0.5 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                    </svg>
                    <span>
                      {cloudUrlHint || "localhost URL may not be reachable from other machines."}
                      {" "}
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
                {/* Editable URL inline */}
                {editingUrl && (
                  <div className="flex items-center gap-2 mb-3 ml-8">
                    <label className="text-caption font-bold shrink-0" style={{ color: "var(--text-secondary)" }}>
                      Cloud URL:
                    </label>
                    <input
                      type="text"
                      value={cloudUrl}
                      onChange={(e) => {
                        setCloudUrl(e.target.value.replace(/\/+$/, ""));
                        setCloudUrlLoopback(false);
                      }}
                      className="flex-1 px-2.5 py-1.5 rounded-sm text-caption font-mono"
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
                <div className="ml-8">
                  {loadingToken ? (
                    <div
                      className="rounded-md px-3 py-2.5 animate-pulse"
                      style={{ background: "var(--code-bg)", height: "80px" }}
                    />
                  ) : (
                    <CodeBlock code={setupCommand} multiline />
                  )}
                </div>
              </div>

              {/* Step 2 */}
              <div className="mb-6">
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className="inline-flex items-center justify-center w-6 h-6 rounded-full text-tiny font-bold text-white"
                    style={{ background: "var(--bg-active)" }}
                  >
                    2
                  </span>
                  <h3 className="text-body font-bold" style={{ color: "var(--text-primary)" }}>
                    Verify connection
                  </h3>
                </div>
                <p className="text-caption ml-8" style={{ color: "var(--text-secondary)" }}>
                  Check the gateway logs — you should see "Authenticated with BotsChat cloud":
                </p>
                <div className="ml-8 mt-2">
                  <CodeBlock code="openclaw gateway logs" />
                </div>
              </div>

              {/* PAT info (collapsible) */}
              <details className="mb-4">
                <summary
                  className="text-caption font-medium cursor-pointer select-none"
                  style={{ color: "var(--text-link)" }}
                >
                  Or configure manually
                </summary>
                <div className="mt-3 space-y-3 ml-1">
                  <div>
                    <label className="block text-caption font-bold mb-1" style={{ color: "var(--text-secondary)" }}>
                      Your Pairing Token
                    </label>
                    {pairingToken ? (
                      <CodeBlock code={pairingToken} />
                    ) : (
                      <span className="text-caption" style={{ color: "var(--text-muted)" }}>Loading...</span>
                    )}
                  </div>
                  <div>
                    <label className="block text-caption font-bold mb-1" style={{ color: "var(--text-secondary)" }}>
                      Cloud URL
                    </label>
                    <CodeBlock code={cloudUrl} />
                  </div>
                </div>
              </details>

              {/* Skip */}
              <div className="text-center pt-2">
                <button
                  onClick={onSkip}
                  className="text-caption hover:underline"
                  style={{ color: "var(--text-muted)" }}
                >
                  Skip for now
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
