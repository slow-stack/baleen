CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  author TEXT,
  author_id TEXT,
  published_at INTEGER,
  time_estimated INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL,
  thumb TEXT,
  duration_sec INTEGER,
  stats_json TEXT,
  tags_json TEXT,
  locale TEXT,
  body_text TEXT,
  body_state TEXT NOT NULL,
  match_json TEXT,
  verdict_tier TEXT,
  verdict_why TEXT,
  verdict_run_id INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  archived_reason TEXT,
  feedback TEXT,
  seen_at INTEGER,
  prefilter_score REAL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_items_key ON items (source_id, external_id);
CREATE INDEX IF NOT EXISTS ix_items_status ON items (status, published_at);
CREATE INDEX IF NOT EXISTS ix_items_url ON items (url);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  url TEXT,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_min INTEGER NOT NULL DEFAULT 720,
  weight REAL NOT NULL DEFAULT 1.0,
  cursor TEXT,
  last_error_class TEXT,
  last_error TEXT,
  last_ok_at INTEGER
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  per_source_json TEXT,
  candidates INTEGER NOT NULL DEFAULT 0,
  judged INTEGER NOT NULL DEFAULT 0,
  model_run_id TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  markdown_path TEXT,
  headline TEXT,
  stats_json TEXT,
  theme_json TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
