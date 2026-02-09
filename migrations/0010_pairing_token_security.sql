-- Pairing token security enhancements: soft-delete (revoke), audit fields.

-- Soft-delete: revoked tokens are rejected but kept for audit trail
ALTER TABLE pairing_tokens ADD COLUMN revoked_at INTEGER;

-- Last connecting IP (for audit)
ALTER TABLE pairing_tokens ADD COLUMN last_ip TEXT;

-- Connection count (for anomaly detection)
ALTER TABLE pairing_tokens ADD COLUMN connection_count INTEGER NOT NULL DEFAULT 0;
