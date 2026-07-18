import Database from "better-sqlite3";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface RunoffDb { sqlite: Database.Database; orm: BetterSQLite3Database }

const DDL = `
CREATE TABLE IF NOT EXISTS blueprints (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, client_name TEXT NOT NULL DEFAULT '',
  cadence_label TEXT NOT NULL DEFAULT 'Monthly', status TEXT NOT NULL DEFAULT 'draft',
  current_rev INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS blueprint_revisions (
  id TEXT PRIMARY KEY, blueprint_id TEXT NOT NULL, rev INTEGER NOT NULL,
  content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(blueprint_id, rev));
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'file',
  stored_filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')), refreshed_at TEXT);
CREATE TABLE IF NOT EXISTS blueprint_sources (
  blueprint_id TEXT NOT NULL, source_id TEXT NOT NULL,
  PRIMARY KEY (blueprint_id, source_id));
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, blueprint_id TEXT NOT NULL, blueprint_rev INTEGER NOT NULL,
  trigger_kind TEXT NOT NULL DEFAULT 'manual', status TEXT NOT NULL DEFAULT 'queued',
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
`;

export function openDb(path: string): RunoffDb {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.exec(DDL);
  return { sqlite, orm: drizzle(sqlite) };
}
