CREATE TABLE IF NOT EXISTS ops_notify_outbox (
  id INTEGER PRIMARY KEY,
  event TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  done_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ops_notify_outbox_pending ON ops_notify_outbox(done_at, created_at);

CREATE TABLE IF NOT EXISTS ops_notify_delivery (
  id INTEGER PRIMARY KEY,
  outbox_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  delivered_at TEXT NOT NULL,
  UNIQUE(outbox_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_ops_notify_delivery_outbox ON ops_notify_delivery(outbox_id);
