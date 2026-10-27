-- ============================================================
-- Part 5. Product sync state (issue #1, Phase 2)
-- Tracks per-product, per-target sync status for CGI -> Naver/ERP.
-- ============================================================

CREATE TABLE IF NOT EXISTS product_sync_state (
  cgi_id TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('erp','naver')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','success','failed','retry_pending','skipped')),
  change_hash TEXT,
  last_success_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  transmitted INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  locked_at TEXT,
  locked_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (cgi_id, target)
);

CREATE INDEX IF NOT EXISTS idx_product_sync_state_status ON product_sync_state(status);
CREATE INDEX IF NOT EXISTS idx_product_sync_state_target ON product_sync_state(target);
CREATE INDEX IF NOT EXISTS idx_product_sync_state_cgi_id ON product_sync_state(cgi_id);

-- ============================================================
-- Part 6. Product change log (issue #1, Phase 2)
-- Records product changes for audit and retry.
-- ============================================================

CREATE TABLE IF NOT EXISTS product_change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cgi_id TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('created','updated','deleted')),
  changed_fields TEXT, -- JSON array of field names
  hash_before TEXT,
  hash_after TEXT NOT NULL,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced_erp INTEGER NOT NULL DEFAULT 0,
  synced_naver INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_product_change_log_cgi_id ON product_change_log(cgi_id);
CREATE INDEX IF NOT EXISTS idx_product_change_log_detected_at ON product_change_log(detected_at);