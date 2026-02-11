import React, { useEffect, useState } from "react";
import { E2eService } from "../e2e";
import { AppStateContext } from "../store";

export function E2ESettings() {
  const { user } = React.useContext(AppStateContext);
  const [hasKey, setHasKey] = useState(E2eService.hasKey());
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  // Subscribe to E2eService changes
  useEffect(() => {
    return E2eService.subscribe(() => {
      setHasKey(E2eService.hasKey());
    });
  }, []);

  const handleUnlock = async () => {
    if (!password || !user) return;
    setBusy(true);
    setError(null);
    try {
      await E2eService.setPassword(password, user.id, remember);
      setPassword(""); // Clear input on success
    } catch (err) {
      setError("Failed to set password. check logs.");
    } finally {
      setBusy(false);
    }
  };

  const handleLock = () => {
    E2eService.clear();
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-h3 font-bold mb-2" style={{ color: "var(--text-primary)" }}>
          End-to-End Encryption
        </h3>
        <p className="text-body" style={{ color: "var(--text-muted)" }}>
          Your messages and tasks are encrypted before leaving your device.
          Only your device (with this password) can decrypt them.
        </p>
      </div>

      <div className="p-4 rounded-md border" style={{ borderColor: "var(--border)", background: hasKey ? "rgba(0, 255, 0, 0.05)" : "rgba(255, 0, 0, 0.05)" }}>
        <div className="flex items-center justify-between mb-4">
          <span className="font-bold flex items-center gap-2" style={{ color: hasKey ? "var(--success)" : "var(--error)" }}>
             {hasKey ? (
                 <>
                   <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
                   Active (Unlocked)
                 </>
             ) : (
                 <>
                   <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" /></svg>
                   Inactive (Locked)
                 </>
             )}
          </span>
          {hasKey && (
              <button onClick={handleLock} className="text-caption font-bold hover:underline" style={{ color: "var(--accent-red, #e53e3e)" }}>
                  Lock / Clear Key
              </button>
          )}
        </div>

        {!hasKey && (
            <div className="space-y-4">
                <div>
                    <label className="block text-caption font-bold mb-1" style={{ color: "var(--text-secondary)" }}>E2E Password</label>
                    <div className="relative">
                        <input 
                            type={showPassword ? "text" : "password"}
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            className="w-full px-3 py-2 pr-10 rounded border"
                            style={{ background: "var(--bg-input)", borderColor: "var(--border)", color: "var(--text-primary)" }}
                            placeholder="Enter your encryption password"
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
                </div>
                
                <div className="flex items-center gap-2">
                    <input 
                        type="checkbox" 
                        id="remember-e2e"
                        checked={remember}
                        onChange={e => setRemember(e.target.checked)}
                    />
                    <label htmlFor="remember-e2e" className="text-caption" style={{ color: "var(--text-secondary)" }}>
                        Remember on this device
                    </label>
                </div>

                {error && <p className="text-caption text-red-500">{error}</p>}

                <button 
                    onClick={handleUnlock}
                    disabled={!password || busy}
                    className="px-4 py-2 rounded font-bold w-full"
                    style={{ background: "var(--bg-active, #6366f1)", color: "#fff", opacity: (!password || busy) ? 0.5 : 1 }}
                >
                    {busy ? "Deriving Key..." : "Unlock / Set Password"}
                </button>
            </div>
        )}
      </div>

      <div className="text-caption" style={{ color: "var(--text-muted)" }}>
          <p className="font-bold text-red-400 mb-1">Warning:</p>
          <ul className="list-disc ml-5 space-y-1">
              <li>If you lose this password, your encrypted history is lost forever.</li>
              <li>We do not store this password on our servers.</li>
              <li>You must use the same password on all devices to access your history.</li>
          </ul>
      </div>
    </div>
  );
}
