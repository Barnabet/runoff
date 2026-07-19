import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

// Per-project analytical warehouse: a separate SQLite file holding the ingested
// rows of tabular sources. The app DB stays the system of record; everything
// here is rebuildable from the stored files.

export interface WhColumn { name: string; type: "INTEGER" | "REAL" | "TEXT" }
export interface WhTableSchema { name: string; columns: WhColumn[] }
export interface SqlResult { columns: string[]; rows: unknown[][] }

const TYPE_RANK: Record<WhColumn["type"], number> = { INTEGER: 0, REAL: 1, TEXT: 2 };
const MAX_RESULT_ROWS = 200;
const MAX_RESULT_CHARS = 10_000;

export function warehouseDir(): string {
  return process.env.RUNOFF_WAREHOUSE_DIR ?? "data/warehouses";
}

export function warehousePath(projectId: string): string {
  return join(warehouseDir(), `${projectId}.db`);
}

/** ATTACH the project's warehouse as `wh`. Must be called OUTSIDE any transaction. */
export function attachWarehouse(sqlite: Database.Database, projectId: string): void {
  mkdirSync(warehouseDir(), { recursive: true });
  sqlite.prepare("ATTACH DATABASE ? AS wh").run(warehousePath(projectId));
}

export function detachWarehouse(sqlite: Database.Database): void {
  sqlite.prepare("DETACH DATABASE wh").run();
}

function q(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

function schemaOf(sqlite: Database.Database, table: string): WhColumn[] {
  const cols = sqlite.prepare(`SELECT name, type FROM wh.pragma_table_info(?)`).all(table) as { name: string; type: string }[];
  return cols
    .filter((c) => c.name !== "_period")
    .map((c) => ({ name: c.name, type: (["INTEGER", "REAL", "TEXT"].includes(c.type) ? c.type : "TEXT") as WhColumn["type"] }));
}

/** Every warehouse table of one family: `fam_<key>` plus `fam_<key>__*`. */
export function whFamilyTables(sqlite: Database.Database, familyKey: string): WhTableSchema[] {
  const base = `fam_${familyKey}`;
  const names = (sqlite.prepare("SELECT name FROM wh.sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
    .map((r) => r.name)
    .filter((n) => n === base || n.startsWith(`${base}__`));
  return names.map((name) => ({ name, columns: schemaOf(sqlite, name) }));
}

/**
 * Human-readable drift lines for the confirm UI. A brand-new family (no
 * existing tables) has no drift — everything is new, nothing to warn about.
 * Order: new tables, missing tables, then per-common-table column drift.
 */
export function computeDrift(existing: WhTableSchema[], incoming: WhTableSchema[]): string[] {
  if (!existing.length) return [];
  const lines: string[] = [];
  const exByName = new Map(existing.map((t) => [t.name, t]));
  const inByName = new Map(incoming.map((t) => [t.name, t]));
  for (const t of incoming) if (!exByName.has(t.name)) lines.push(`new table: ${t.name}`);
  for (const t of existing) if (!inByName.has(t.name)) lines.push(`missing table: ${t.name}`);
  for (const t of incoming) {
    const ex = exByName.get(t.name);
    if (!ex) continue;
    const exCols = new Map(ex.columns.map((c) => [c.name, c]));
    const inCols = new Map(t.columns.map((c) => [c.name, c]));
    for (const c of t.columns) if (!exCols.has(c.name)) lines.push(`new column: ${t.name}.${c.name} (${c.type})`);
    for (const c of t.columns) {
      const prev = exCols.get(c.name);
      if (prev && TYPE_RANK[c.type] > TYPE_RANK[prev.type]) lines.push(`type change: ${t.name}.${c.name} ${prev.type} → ${c.type}`);
    }
    for (const c of ex.columns) if (!inCols.has(c.name)) lines.push(`missing column: ${t.name}.${c.name}`);
  }
  return lines;
}

/**
 * Create/extend warehouse tables to accept `incoming`. New columns are ADDed;
 * type widening (INTEGER → REAL → TEXT, one-way) rebuilds the table preserving
 * rows. Narrowing is ignored. Caller wraps this in its transaction.
 */
export function applySchema(sqlite: Database.Database, periodic: boolean, incoming: WhTableSchema[]): void {
  for (const t of incoming) {
    const existing = schemaOf(sqlite, t.name);
    const exists = (sqlite.prepare("SELECT 1 FROM wh.sqlite_master WHERE type='table' AND name = ?").get(t.name)) !== undefined;
    if (!exists) {
      const cols = t.columns.map((c) => `${q(c.name)} ${c.type}`);
      if (periodic) cols.push(`"_period" TEXT NOT NULL`);
      sqlite.prepare(`CREATE TABLE wh.${q(t.name)} (${cols.join(", ")})`).run();
      continue;
    }
    const exByName = new Map(existing.map((c) => [c.name, c]));
    const widened = t.columns.some((c) => {
      const prev = exByName.get(c.name);
      return prev && TYPE_RANK[c.type] > TYPE_RANK[prev.type];
    });
    if (!widened) {
      for (const c of t.columns) {
        if (!exByName.has(c.name)) sqlite.prepare(`ALTER TABLE wh.${q(t.name)} ADD COLUMN ${q(c.name)} ${c.type}`).run();
      }
      continue;
    }
    // Rebuild with the union schema at widened types (SQLite can't ALTER a column type).
    const merged: WhColumn[] = existing.map((prev) => {
      const inc = t.columns.find((c) => c.name === prev.name);
      return inc && TYPE_RANK[inc.type] > TYPE_RANK[prev.type] ? { name: prev.name, type: inc.type } : prev;
    });
    for (const c of t.columns) if (!merged.some((m) => m.name === c.name)) merged.push(c);
    const tmp = `${t.name}__rebuild`;
    sqlite.prepare(`ALTER TABLE wh.${q(t.name)} RENAME TO ${q(tmp)}`).run();
    const cols = merged.map((c) => `${q(c.name)} ${c.type}`);
    if (periodic) cols.push(`"_period" TEXT NOT NULL`);
    sqlite.prepare(`CREATE TABLE wh.${q(t.name)} (${cols.join(", ")})`).run();
    const copyCols = [...existing.map((c) => q(c.name)), ...(periodic ? ['"_period"'] : [])].join(", ");
    sqlite.prepare(`INSERT INTO wh.${q(t.name)} (${copyCols}) SELECT ${copyCols} FROM wh.${q(tmp)}`).run();
    sqlite.prepare(`DROP TABLE wh.${q(tmp)}`).run();
  }
}

/** Clear one period's rows (periodic) or all rows (constant, period=null). */
export function deleteRows(sqlite: Database.Database, tables: string[], period: string | null): void {
  for (const t of tables) {
    if (period === null) sqlite.prepare(`DELETE FROM wh.${q(t)}`).run();
    else sqlite.prepare(`DELETE FROM wh.${q(t)} WHERE "_period" = ?`).run(period);
  }
}

/** Bulk-insert one batch. Values: undefined → NULL; Dates/booleans → String. */
export function insertRows(sqlite: Database.Database, table: string, columns: string[], rows: unknown[][], period: string | null): void {
  if (!rows.length) return;
  const cols = [...columns.map(q), ...(period !== null ? ['"_period"'] : [])];
  const placeholders = cols.map(() => "?").join(", ");
  const stmt = sqlite.prepare(`INSERT INTO wh.${q(table)} (${cols.join(", ")}) VALUES (${placeholders})`);
  for (const row of rows) {
    const vals = columns.map((_, i) => coerce(row[i]));
    stmt.run(...(period !== null ? [...vals, period] : vals));
  }
}

function coerce(v: unknown): string | number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number" || typeof v === "string") return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Read-only direct open (no attach) for catalog building — null if no warehouse yet. */
function openReadonly(projectId: string): Database.Database | null {
  const path = warehousePath(projectId);
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");
  return db;
}

/** Schema + per-period row counts for one family, for the catalog. */
export function readWarehouseTables(
  projectId: string,
  familyKey: string,
): { name: string; columns: WhColumn[]; rowCounts: Record<string, number> }[] {
  const db = openReadonly(projectId);
  if (!db) return [];
  try {
    const base = `fam_${familyKey}`;
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
      .map((r) => r.name)
      .filter((n) => n === base || n.startsWith(`${base}__`));
    return names.map((name) => {
      const cols = (db.prepare(`SELECT name, type FROM pragma_table_info(?)`).all(name) as { name: string; type: string }[]);
      const periodic = cols.some((c) => c.name === "_period");
      const rowCounts: Record<string, number> = {};
      if (periodic) {
        for (const r of db.prepare(`SELECT "_period" AS p, COUNT(*) AS n FROM ${q(name)} GROUP BY "_period" ORDER BY "_period"`).all() as { p: string; n: number }[]) {
          rowCounts[r.p] = r.n;
        }
      } else {
        rowCounts[""] = (db.prepare(`SELECT COUNT(*) AS n FROM ${q(name)}`).get() as { n: number }).n;
      }
      return {
        name,
        columns: cols.filter((c) => c.name !== "_period").map((c) => ({ name: c.name, type: (["INTEGER", "REAL", "TEXT"].includes(c.type) ? c.type : "TEXT") as WhColumn["type"] })),
        rowCounts,
      };
    });
  } finally {
    db.close();
  }
}

/** One read-only statement against the project warehouse. Throws on any error. */
export function runWarehouseSql(projectId: string, sql: string): SqlResult {
  const db = openReadonly(projectId);
  if (!db) throw new Error("no data ingested yet");
  try {
    const stmt = db.prepare(sql); // multi-statement strings throw here
    if (!stmt.reader) { stmt.run(); return { columns: [], rows: [] }; } // writes throw under query_only
    return { columns: stmt.columns().map((c) => c.name), rows: stmt.raw().all() as unknown[][] };
  } finally {
    db.close();
  }
}

/** Serialize a result for the copilot: header, pipe-separated rows, hard caps. */
export function formatSqlResult(res: SqlResult): string {
  if (!res.rows.length) return "(0 rows)";
  const header = res.columns.join(" | ");
  const lines = [header];
  let chars = header.length;
  let shown = 0;
  for (const row of res.rows) {
    if (shown >= MAX_RESULT_ROWS) break;
    const line = row.map((v) => (v === null || v === undefined ? "" : String(v))).join(" | ");
    if (chars + 1 + line.length > MAX_RESULT_CHARS) break;
    lines.push(line);
    chars += 1 + line.length;
    shown++;
  }
  if (shown < res.rows.length) lines.push(`… truncated at ${shown} of ${res.rows.length} rows`);
  return lines.join("\n");
}
