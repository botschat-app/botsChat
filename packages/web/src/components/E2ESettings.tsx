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
              <button onClick={handleLock} className="text-caption font-bold text-red-500 hover:underline">
                  Lock / Clear Key
              </button>
          )}
        </div>

        {!hasKey && (
            <div className="space-y-4">
                <div>
                    <label className="block text-caption font-bold mb-1" style={{ color: "var(--text-secondary)" }}>E2E Password</label>
                    <input 
                        type="password" 
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        className="w-full px-3 py-2 rounded border"
                        style={{ background: "var(--bg-input)", borderColor: "var(--border)", color: "var(--text-primary)" }}
                        placeholder="Enter your encryption password"
                    />
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
                    className="px-4 py-2 rounded font-bold text-white w-full"
                    style={{ background: "var(--primary)", opacity: (!password || busy) ? 0.5 : 1 }}
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
