CREATE TABLE IF NOT EXISTS maintenance_locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);
