import sqlite3
from pathlib import Path

# MIRROR of packages/core/src/db/index.ts — the DDL and open semantics change
# only in lockstep with that file. Schema is frozen during the R-phase port.

RunoffDb = sqlite3.Connection

DDL = """
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS source_families (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL,
  kind TEXT NOT NULL, granularity TEXT, parse_plan TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, key));
CREATE TABLE IF NOT EXISTS blueprint_families (
  blueprint_id TEXT NOT NULL, family_id TEXT NOT NULL,
  PRIMARY KEY (blueprint_id, family_id));
CREATE TABLE IF NOT EXISTS blueprints (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, client_name TEXT NOT NULL DEFAULT '',
  project_id TEXT NOT NULL DEFAULT '',
  cadence_label TEXT NOT NULL DEFAULT 'Monthly', status TEXT NOT NULL DEFAULT 'draft',
  current_rev INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS blueprint_revisions (
  id TEXT PRIMARY KEY, blueprint_id TEXT NOT NULL, rev INTEGER NOT NULL,
  content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(blueprint_id, rev));
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT '', family_id TEXT, period TEXT,
  name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'file',
  stored_filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'unfiled', proposal TEXT, parse_report TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')), filed_at TEXT);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, blueprint_id TEXT NOT NULL, blueprint_rev INTEGER NOT NULL,
  trigger_kind TEXT NOT NULL DEFAULT 'manual', status TEXT NOT NULL DEFAULT 'queued',
  period TEXT,
  started_at TEXT, finished_at TEXT, stats TEXT, document TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  type TEXT NOT NULL, payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(run_id, seq));
CREATE TABLE IF NOT EXISTS run_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), consumed_at TEXT);
CREATE TABLE IF NOT EXISTS flags (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, code TEXT NOT NULL, section_key TEXT NOT NULL,
  question TEXT NOT NULL, options TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY, blueprint_id TEXT NOT NULL, section_key TEXT NOT NULL,
  author TEXT NOT NULL, body TEXT NOT NULL, proposed_edit TEXT,
  status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS copilot_messages (
  id TEXT PRIMARY KEY, blueprint_id TEXT NOT NULL, role TEXT NOT NULL,
  body TEXT NOT NULL, actions TEXT, status TEXT NOT NULL DEFAULT 'ok',
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'blueprint',
  project_id TEXT NOT NULL DEFAULT '', blueprint_id TEXT,
  body TEXT NOT NULL, source TEXT NOT NULL, origin_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS goldens (
  id TEXT PRIMARY KEY, blueprint_id TEXT NOT NULL, kind TEXT NOT NULL,
  run_id TEXT, section_key TEXT, name TEXT, mime TEXT, stored_filename TEXT,
  note TEXT, period TEXT, document TEXT, unify_error TEXT, bindings TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
"""


def open_db(path: str) -> sqlite3.Connection:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.executescript(DDL)
    n = conn.execute(
        "SELECT COUNT(*) AS n FROM pragma_table_info('sources') WHERE name='family_id'"
    ).fetchone()["n"]
    if n == 0:
        conn.close()
        raise RuntimeError("database predates v1.2b — delete the DB file and run: pnpm seed")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS sources_slot ON sources(family_id, period) WHERE status='filed';"
    )
    return conn
