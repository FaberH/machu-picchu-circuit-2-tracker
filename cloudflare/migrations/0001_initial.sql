CREATE TABLE IF NOT EXISTS collection_runs (
  id TEXT PRIMARY KEY,
  scheduled_at TEXT,
  observed_at TEXT NOT NULL,
  collection_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  phase TEXT,
  stop_for_day INTEGER NOT NULL DEFAULT 0,
  ticket_capacity INTEGER,
  ticket_issued INTEGER,
  ticket_available INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_date_time
  ON collection_runs (collection_date, observed_at);

CREATE TABLE IF NOT EXISTS route_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES collection_runs(id) ON DELETE CASCADE,
  observed_at TEXT NOT NULL,
  collection_date TEXT NOT NULL,
  visit_date TEXT NOT NULL,
  route_id INTEGER NOT NULL,
  route TEXT NOT NULL,
  name TEXT NOT NULL,
  circuit TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  sold INTEGER NOT NULL,
  available INTEGER NOT NULL,
  UNIQUE (observed_at, visit_date, route)
);

CREATE INDEX IF NOT EXISTS idx_observations_visit_time
  ON route_observations (visit_date, observed_at);

