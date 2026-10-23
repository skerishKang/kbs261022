-- CGI quote requests
CREATE TABLE IF NOT EXISTS quote_requests (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  company TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  location TEXT,
  note TEXT,
  services TEXT, -- JSON array
  items TEXT NOT NULL, -- JSON array
  status TEXT NOT NULL DEFAULT 'received',
  admin_prices TEXT, -- JSON object
  total REAL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_quote_requests_created_at ON quote_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_quote_requests_status ON quote_requests(status);
