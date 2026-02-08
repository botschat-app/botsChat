import React, { useState } from "react";
import { authApi, setToken } from "../api";
import { useAppDispatch } from "../store";
import { dlog } from "../debug-log";

export function LoginPage() {
  const dispatch = useAppDispatch();
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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
      setToken(res.token);
      dispatch({
        type: "SET_USER",
        user: { id: res.id, email: res.email, displayName: res.displayName },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong";
      dlog.error("Auth", `${isRegister ? "Register" : "Login"} failed: ${message}`);
      setError(message);
    } finally {
      setLoading(false);
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
          <div
            className="inline-flex items-center justify-center w-16 h-16 rounded-xl text-white text-2xl font-bold mb-4"
            style={{ background: "#1264A3" }}
          >
            BC
          </div>
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
            {isRegister ? "Create account" : "Sign in"}
          </h2>

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

            {error && (
              <div
                className="text-caption px-3 py-2 rounded-sm"
                style={{ background: "rgba(224,30,90,0.1)", color: "var(--accent-red)" }}
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 font-bold text-body text-white rounded-sm disabled:opacity-50 transition-colors hover:brightness-110"
              style={{ background: "var(--bg-active)" }}
            >
              {loading
                ? "..."
                : isRegister
                  ? "Create account"
                  : "Sign in"}
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
        </div>
      </div>
    </div>
  );
}
