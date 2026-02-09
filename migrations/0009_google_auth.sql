-- Support Firebase OAuth (Google, GitHub, etc.) users who don't have a password.

-- auth_provider: 'email' (default), 'google', 'github'
ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'email';

-- Firebase UID — unique across all Firebase auth providers
ALTER TABLE users ADD COLUMN firebase_uid TEXT;

-- Index for quick lookup by firebase_uid
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid) WHERE firebase_uid IS NOT NULL;
