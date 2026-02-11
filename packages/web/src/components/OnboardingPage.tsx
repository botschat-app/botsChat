import React, { useEffect, useState, useCallback } from "react";
import { pairingApi, setupApi, type PairingToken } from "../api";
import { useAppState } from "../store";
import { dlog } from "../debug-log";
import { E2eService } from "../e2e";

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

  // E2E password step
  const [e2ePassword, setE2ePassword] = useState("");
  const [e2eConfirm, setE2eConfirm] = useState("");
  const [e2eRemember, setE2eRemember] = useState(true);
  const [e2eReady, setE2eReady] = useState(false); // true after password is set
  const [e2eError, setE2eError] = useState("");
  const [e2eLoading, setE2eLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

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

  // Create a pairing token for the setup command.
  // Note: GET /pairing-tokens only returns masked tokenPreview (security),
  // so we always create a fresh token for onboarding display.
  useEffect(() => {
    let cancelled = false;

    async function ensurePairingToken() {
      setLoadingToken(true);
      try {
        const { token } = await pairingApi.create("Default");
        if (!cancelled) setPairingToken(token);
      } catch (err) {
        dlog.error("Onboarding", `Failed to create pairing token: ${err}`);
      } finally {
        if (!cancelled) setLoadingToken(false);
      }
    }

    ensurePairingToken();
    return () => { cancelled = true; };
  }, []);

  // E2E password validation
  const e2ePasswordValid = e2ePassword.length >= 6 && e2ePassword === e2eConfirm;

  const handleE2eSubmit = async () => {
    if (!e2ePasswordValid) return;
    if (!state.user?.id) {
      setE2eError("User not loaded yet. Please wait.");
      return;
    }
    setE2eLoading(true);
    setE2eError("");
    try {
      await E2eService.setPassword(e2ePassword, state.user.id, e2eRemember);
      setE2eReady(true);
    } catch (err) {
      setE2eError("Failed to derive encryption key. Please try again.");
    } finally {
      setE2eLoading(false);
    }
  };

  const setupCommand = pairingToken
    ? `openclaw plugins install @botschat/botschat && \\
openclaw config set channels.botschat.cloudUrl ${cloudUrl} && \\
openclaw config set channels.botschat.pairingToken ${pairingToken} && \\
openclaw config set channels.botschat.e2ePassword "${e2ePassword}" && \\
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

              {/* Step 1: E2E Password (mandatory) */}
              <div className="mb-6">
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className="inline-flex items-center justify-center w-6 h-6 rounded-full text-tiny font-bold text-white"
                    style={{ background: e2eReady ? "var(--accent-green)" : "var(--bg-active)" }}
                  >
                    {e2eReady ? (
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    ) : "1"}
                  </span>
                  <h3 className="text-body font-bold" style={{ color: "var(--text-primary)" }}>
                    Set your E2E encryption password
                  </h3>
                </div>

                {!e2eReady ? (
                  <div className="ml-8">
                    <p className="text-caption mb-3" style={{ color: "var(--text-secondary)" }}>
                      Your messages, prompts, and task results will be <strong>encrypted on this device</strong> before
                      they leave — the server only stores ciphertext it cannot read.
                    </p>

                    {/* Architecture diagram */}
                    <div className="mb-3 rounded-md overflow-hidden" style={{ border: "1px solid var(--border)" }}>
                      <img
                        src="/architecture.png"
                        alt="BotsChat E2E Encryption Architecture"
                        className="w-full"
                        style={{ display: "block" }}
                      />
                    </div>
                    <p className="text-caption mb-4" style={{ color: "var(--text-muted)" }}>
                      Encryption keys are derived locally and never sent to the server.{" "}
                      <a
                        href="https://botschat.app/#features"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline"
                        style={{ color: "var(--text-link)" }}
                      >
                        Learn more
                      </a>
                    </p>

                    {/* Password inputs */}
                    <div className="space-y-2.5">
                      <div className="relative">
                        <input
                          type={showPassword ? "text" : "password"}
                          value={e2ePassword}
                          onChange={(e) => setE2ePassword(e.target.value)}
                          placeholder="E2E encryption password (min 6 chars)"
                          className="w-full px-3 py-2 pr-10 rounded-sm text-caption"
                          style={{
                            background: "var(--code-bg)",
                            border: "1px solid var(--border)",
                            color: "var(--text-primary)",
                            outline: "none",
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1"
                          style={{ color: "var(--text-muted)" }}
                          tabIndex={-1}
                        >
                          {showPassword ? (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                              <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>
                              <line x1="1" y1="1" x2="23" y2="23"/>
                            </svg>
                          ) : (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                              <circle cx="12" cy="12" r="3"/>
                            </svg>
                          )}
                        </button>
                      </div>
                      <div className="relative">
                        <input
                          type={showPassword ? "text" : "password"}
                          value={e2eConfirm}
                          onChange={(e) => setE2eConfirm(e.target.value)}
                          placeholder="Confirm password"
                          className="w-full px-3 py-2 pr-10 rounded-sm text-caption"
                          style={{
                            background: "var(--code-bg)",
                            border: `1px solid ${e2eConfirm && e2ePassword !== e2eConfirm ? "var(--accent-red, #e53e3e)" : "var(--border)"}`,
                            color: "var(--text-primary)",
                            outline: "none",
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1"
                          style={{ color: "var(--text-muted)" }}
                          tabIndex={-1}
                        >
                          {showPassword ? (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                              <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>
                              <line x1="1" y1="1" x2="23" y2="23"/>
                            </svg>
                          ) : (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                              <circle cx="12" cy="12" r="3"/>
                            </svg>
                          )}
                        </button>
                      </div>
                      {e2eConfirm && e2ePassword !== e2eConfirm && (
                        <p className="text-caption" style={{ color: "var(--accent-red, #e53e3e)" }}>
                          Passwords do not match.
                        </p>
                      )}

                      {/* Remember checkbox */}
                      <label className="flex items-center gap-2 text-caption" style={{ color: "var(--text-secondary)" }}>
                        <input
                          type="checkbox"
                          checked={e2eRemember}
                          onChange={(e) => setE2eRemember(e.target.checked)}
                        />
                        Remember on this device
                      </label>

                      {e2eError && (
                        <p className="text-caption" style={{ color: "var(--accent-red, #e53e3e)" }}>{e2eError}</p>
                      )}

                      <button
                        onClick={handleE2eSubmit}
                        disabled={!e2ePasswordValid || e2eLoading}
                        className="w-full py-2 font-bold text-caption text-white rounded-sm transition-colors"
                        style={{
                          background: e2ePasswordValid && !e2eLoading ? "var(--bg-active)" : "var(--bg-hover)",
                          cursor: e2ePasswordValid && !e2eLoading ? "pointer" : "not-allowed",
                          opacity: e2ePasswordValid && !e2eLoading ? 1 : 0.5,
                        }}
                      >
                        {e2eLoading ? "Deriving key..." : "Set E2E Password & Continue"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-caption ml-8" style={{ color: "var(--accent-green)" }}>
                    E2E encryption is active. Your encryption key has been derived.
                  </p>
                )}
              </div>

              {/* Step 2: Install command (only shown after E2E password set) */}
              <div className="mb-6" style={{ opacity: e2eReady ? 1 : 0.4, pointerEvents: e2eReady ? "auto" : "none" }}>
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className="inline-flex items-center justify-center w-6 h-6 rounded-full text-tiny font-bold text-white"
                    style={{ background: "var(--bg-active)" }}
                  >
                    2
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

              {/* Step 3: Verify */}
              <div className="mb-6" style={{ opacity: e2eReady ? 1 : 0.4, pointerEvents: e2eReady ? "auto" : "none" }}>
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className="inline-flex items-center justify-center w-6 h-6 rounded-full text-tiny font-bold text-white"
                    style={{ background: "var(--bg-active)" }}
                  >
                    3
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
