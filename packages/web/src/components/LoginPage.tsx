import React, { useState, useEffect } from "react";
import { authApi, setToken, setRefreshToken } from "../api";
import type { AuthConfig } from "../api";
import { useAppDispatch } from "../store";
import { dlog } from "../debug-log";
import { isFirebaseConfigured, signInWithGoogle, signInWithGitHub } from "../firebase";

/** Google "G" logo SVG */
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" style={{ flexShrink: 0 }}>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
  );
}

/** GitHub logo SVG */
function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
    </svg>
  );
}

export function LoginPage() {
  const dispatch = useAppDispatch();
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<"google" | "github" | null>(null);
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null);

  const firebaseEnabled = isFirebaseConfigured();
  const anyLoading = loading || !!oauthLoading;

  // Fetch server-side auth config to determine which methods are available
  useEffect(() => {
    authApi.config().then(setAuthConfig).catch(() => {
      // Fallback: assume email enabled (local dev) if config endpoint fails
      setAuthConfig({ emailEnabled: true, googleEnabled: firebaseEnabled, githubEnabled: firebaseEnabled });
    });
  }, [firebaseEnabled]);

  const emailEnabled = authConfig?.emailEnabled ?? true;
  const configLoaded = authConfig !== null;
  const hasAnyLoginMethod = configLoaded && (firebaseEnabled || emailEnabled);

  const handleAuthSuccess = (res: { id: string; email: string; displayName?: string; token: string; refreshToken?: string }) => {
    setToken(res.token);
    if (res.refreshToken) setRefreshToken(res.refreshToken);
    dispatch({
      type: "SET_USER",
      user: { id: res.id, email: res.email, displayName: res.displayName },
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      let res;
      if (isRegister) {
        dlog.info("Auth", `Registering new account: ${email}`);
        res = await authApi.register(email, password, displayName || undefined);
      } else {
        dlog.info("Auth", `Logging in: ${email}`);
        res = await authApi.login(email, password);
      }
      dlog.info("Auth", `${isRegister ? "Register" : "Login"} success — user ${res.id} (${res.email})`);
      handleAuthSuccess(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong";
      dlog.error("Auth", `${isRegister ? "Register" : "Login"} failed: ${message}`);
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleOAuthSignIn = async (provider: "google" | "github") => {
    setError("");
    setOauthLoading(provider);

    try {
      dlog.info("Auth", `Starting ${provider} sign-in`);
      const signInFn = provider === "google" ? signInWithGoogle : signInWithGitHub;
      const { idToken } = await signInFn();
      dlog.info("Auth", `Got Firebase ID token from ${provider}, verifying with backend`);
      const res = await authApi.firebase(idToken);
      dlog.info("Auth", `${provider} sign-in success — user ${res.id} (${res.email})`);
      handleAuthSuccess(res);
    } catch (err) {
      // Don't show error for user-cancelled popup
      if (err instanceof Error && (
        err.message.includes("popup-closed-by-user") ||
        err.message.includes("cancelled")
      )) {
        dlog.info("Auth", `${provider} sign-in cancelled by user`);
      } else {
        const message = err instanceof Error ? err.message : `${provider} sign-in failed`;
        dlog.error("Auth", `${provider} sign-in failed: ${message}`);
        setError(message);
      }
    } finally {
      setOauthLoading(null);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ background: "var(--bg-secondary)" }}
    >
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <img
            src="/botschat-logo.png"
            alt="BotsChat"
            className="inline-block w-16 h-16 mb-4"
          />
          <h1 className="text-3xl font-bold" style={{ color: "var(--text-primary)" }}>
            BotsChat
          </h1>
          <p className="mt-2" style={{ color: "var(--text-secondary)" }}>
            Multi-channel AI chat powered by OpenClaw
          </p>
        </div>

        {/* Form card */}
        <div
          className="rounded-md p-8"
          style={{
            background: "var(--bg-surface)",
            boxShadow: "var(--shadow-lg)",
          }}
        >
          <h2 className="text-h1 mb-6" style={{ color: "var(--text-primary)" }}>
            {emailEnabled
              ? (isRegister ? "Create account" : "Sign in")
              : "Sign in"}
          </h2>

          {/* Loading: avoid showing empty card on first paint before config is loaded */}
          {!configLoaded && (
            <div className="py-8 text-center" style={{ color: "var(--text-muted)" }}>
              <span className="text-body">Loading sign-in options…</span>
            </div>
          )}

          {/* No methods available (e.g. misconfiguration) */}
          {configLoaded && !hasAnyLoginMethod && (
            <div className="py-4 text-caption" style={{ color: "var(--text-secondary)" }}>
              Sign-in is not configured. Please contact support.
            </div>
          )}

          {/* OAuth buttons */}
          {configLoaded && firebaseEnabled && (
            <>
              <div className="space-y-3">
                {/* Google */}
                <button
                  type="button"
                  onClick={() => handleOAuthSignIn("google")}
                  disabled={anyLoading}
                  className="w-full flex items-center justify-center gap-3 py-2.5 px-4 font-medium text-body rounded-sm disabled:opacity-50 transition-colors hover:brightness-95"
                  style={{
                    background: "var(--bg-surface)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {oauthLoading === "google" ? (
                    <span>Signing in...</span>
                  ) : (
                    <>
                      <GoogleIcon />
                      <span>Continue with Google</span>
                    </>
                  )}
                </button>

                {/* GitHub */}
                <button
                  type="button"
                  onClick={() => handleOAuthSignIn("github")}
                  disabled={anyLoading}
                  className="w-full flex items-center justify-center gap-3 py-2.5 px-4 font-medium text-body rounded-sm disabled:opacity-50 transition-colors hover:brightness-95"
                  style={{
                    background: "var(--bg-surface)",
                    color: "var(--text-primary)",
                    border: "1px solid var(--border)",
                  }}
                >
                  {oauthLoading === "github" ? (
                    <span>Signing in...</span>
                  ) : (
                    <>
                      <GitHubIcon />
                      <span>Continue with GitHub</span>
                    </>
                  )}
                </button>
              </div>

              {/* Divider — only show if email login is also available */}
              {configLoaded && emailEnabled && (
                <div className="flex items-center gap-3 my-5">
                  <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
                  <span className="text-caption" style={{ color: "var(--text-muted)" }}>
                    or
                  </span>
                  <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
                </div>
              )}
            </>
          )}

          {/* Error display (always visible, e.g. OAuth errors) */}
          {error && (
            <div
              className="text-caption px-3 py-2 rounded-sm mt-4"
              style={{ background: "rgba(224,30,90,0.1)", color: "var(--accent-red)" }}
            >
              {error}
            </div>
          )}

          {/* Email/password form — only in local/dev mode */}
          {configLoaded && emailEnabled && (
            <>
              <form onSubmit={handleSubmit} className="space-y-4">
                {isRegister && (
                  <div>
                    <label className="block text-caption font-bold mb-1" style={{ color: "var(--text-secondary)" }}>
                      Display Name
                    </label>
                    <input
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      className="w-full px-3 py-2.5 text-body rounded-sm focus:outline-none placeholder:text-[--text-muted]"
                      style={{
                        background: "var(--bg-surface)",
                        color: "var(--text-primary)",
                        border: "1px solid var(--border)",
                      }}
                      placeholder="Your name"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-caption font-bold mb-1" style={{ color: "var(--text-secondary)" }}>
                    Email
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="w-full px-3 py-2.5 text-body rounded-sm focus:outline-none placeholder:text-[--text-muted]"
                    style={{
                      background: "var(--bg-surface)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border)",
                    }}
                    placeholder="you@example.com"
                  />
                </div>

                <div>
                  <label className="block text-caption font-bold mb-1" style={{ color: "var(--text-secondary)" }}>
                    Password
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="w-full px-3 py-2.5 text-body rounded-sm focus:outline-none placeholder:text-[--text-muted]"
                    style={{
                      background: "var(--bg-surface)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--border)",
                    }}
                    placeholder="Enter password"
                  />
                </div>

                <button
                  type="submit"
                  disabled={anyLoading}
                  className="w-full py-2.5 font-bold text-body text-white rounded-sm disabled:opacity-50 transition-colors hover:brightness-110"
                  style={{ background: "var(--bg-active)" }}
                >
                  {loading
                    ? "..."
                    : isRegister
                      ? "Create account"
                      : "Sign in with email"}
                </button>
              </form>

              <div className="mt-6 text-center">
                <button
                  onClick={() => {
                    setIsRegister(!isRegister);
                    setError("");
                  }}
                  className="text-caption hover:underline"
                  style={{ color: "var(--text-link)" }}
                >
                  {isRegister
                    ? "Already have an account? Sign in"
                    : "Don't have an account? Register"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
