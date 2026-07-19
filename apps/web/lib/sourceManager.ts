import { join } from "node:path";
import {
  attachWarehouse, detachWarehouse, whFamilyTables, applySchema, deleteRows, insertRows,
  newId, PERIOD_REGEX, type Granularity, type ProjectSourceRow, type RunoffDb, type WhTableSchema,
} from "@runoff/core";
import { buildSourcePack, packForPrompt, isTabular, scanTabular, readTabular, type TabularScan } from "@runoff/engine";

// Confirm/refile operations open an explicit BEGIN…COMMIT with await gaps in
// between (streaming ingest); the shared SQLite handle must not see statements
// from other requests inside that window. One promise chain = one at a time.
let ingestChain: Promise<unknown> = Promise.resolve();
function withIngestLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = ingestChain.then(fn, fn);
  ingestChain = run.then(() => undefined, () => undefined);
  return run;
}

/** Final warehouse table name per detected slug: single table → fam_<key>. */
export function tableNamesFor(familyKey: string, slugs: string[]): Record<string, string> {
  const single = slugs.length === 1;
  return Object.fromEntries(slugs.map((s) => [s, single ? `fam_${familyKey}` : `fam_${familyKey}__${s}`]));
}

// Server-only slot logic for the project source manager. Never import from
// client code — it touches the SQLite handle and node:fs (via readContentSample).

export interface FamilySummary {
  id: string;
  key: string;
  label: string;
  kind: "periodic" | "constant";
  granularity: Granularity | null;
  filedPeriods: string[];
  /** Filed periodic entries (ascending by period); `[]` for constant families. */
  filedEntries: { period: string; sourceId: string; name: string }[];
  liveFile: { sourceId: string; name: string } | null;
}

/**
 * Every family in a project (with its filed periods, ascending) plus the
 * project's still-unfiled uploads. `liveFile` is the single live file of a
 * constant family (constants have no period); periodic families report null.
 */
export function listProjectSources(
  db: RunoffDb,
  projectId: string,
): { families: FamilySummary[]; unfiled: ProjectSourceRow[] } {
  const fams = db.sqlite
    .prepare("SELECT id, key, label, kind, granularity FROM source_families WHERE project_id = ? ORDER BY key")
    .all(projectId) as { id: string; key: string; label: string; kind: "periodic" | "constant"; granularity: Granularity | null }[];
  const entriesStmt = db.sqlite.prepare(
    "SELECT period, id AS sourceId, name FROM sources WHERE family_id = ? AND status='filed' AND period IS NOT NULL ORDER BY period",
  );
  const liveStmt = db.sqlite.prepare(
    "SELECT id, name FROM sources WHERE family_id = ? AND status='filed' AND period IS NULL LIMIT 1",
  );
  const families = fams.map((f) => {
    const live = f.kind === "constant" ? (liveStmt.get(f.id) as { id: string; name: string } | undefined) : undefined;
    const filedEntries = f.kind === "constant"
      ? []
      : (entriesStmt.all(f.id) as { period: string; sourceId: string; name: string }[]);
    return {
      ...f,
      filedPeriods: filedEntries.map((r) => r.period),
      filedEntries,
      liveFile: live ? { sourceId: live.id, name: live.name } : null,
    };
  });

  const unfiled = (
    db.sqlite
      .prepare(
        "SELECT id, project_id AS projectId, family_id AS familyId, period, name, kind, stored_filename AS storedFilename, mime, size, status, proposal, uploaded_at AS uploadedAt, filed_at AS filedAt FROM sources WHERE project_id = ? AND status='unfiled' ORDER BY uploaded_at, id",
      )
      .all(projectId) as (Omit<ProjectSourceRow, "proposal"> & { proposal: string | null })[]
  ).map((r) => ({ ...r, proposal: r.proposal ? JSON.parse(r.proposal) : null }));

  return { families, unfiled };
}

export interface FileSourceArgs {
  projectId: string;
  sourceId: string;
  familyId?: string;
  newFamily?: { key: string; label: string; kind: "periodic" | "constant"; granularity: Granularity | null };
  period: string | null;
}

/**
 * File (or refile) one source into a family slot. Creates the family when
 * `newFamily` is given; validates period against granularity (constant ⇒ null);
 * marks any live occupant `replaced`; everything in one transaction. Shared by
 * the confirm and refile routes.
 */
export async function fileSource(db: RunoffDb, args: FileSourceArgs): Promise<{ ok: true } | { error: string; status: number }> {
  const src = db.sqlite
    .prepare("SELECT id, name, mime, stored_filename AS storedFilename FROM sources WHERE id = ? AND project_id = ?")
    .get(args.sourceId, args.projectId) as { id: string; name: string; mime: string; storedFilename: string } | undefined;
  if (!src) return { error: "source not found", status: 404 };

  return withIngestLock(async () => {
    // --- resolve + validate (reads only; serialized by the lock) ------------
    let familyId = args.familyId ?? null;
    let familyKey: string;
    let kind: "periodic" | "constant";
    let granularity: Granularity | null;
    if (args.newFamily) {
      const dup = db.sqlite
        .prepare("SELECT id FROM source_families WHERE project_id = ? AND key = ?")
        .get(args.projectId, args.newFamily.key);
      if (dup) return { error: `family key already exists: ${args.newFamily.key}`, status: 400 };
      if (args.newFamily.kind === "periodic" && !args.newFamily.granularity) return { error: "periodic family requires a granularity", status: 400 };
      if (args.newFamily.kind === "constant" && args.newFamily.granularity) return { error: "constant family cannot have a granularity", status: 400 };
      familyKey = args.newFamily.key; kind = args.newFamily.kind; granularity = args.newFamily.granularity;
    } else {
      const fam = db.sqlite
        .prepare("SELECT key, kind, granularity FROM source_families WHERE id = ? AND project_id = ?")
        .get(familyId, args.projectId) as { key: string; kind: "periodic" | "constant"; granularity: Granularity | null } | undefined;
      if (!fam) return { error: "family not found", status: 404 };
      familyKey = fam.key; kind = fam.kind; granularity = fam.granularity;
    }
    if (kind === "constant") {
      if (args.period !== null) return { error: "constant families take no period", status: 400 };
    } else if (args.period === null || !PERIOD_REGEX[granularity as Granularity].test(args.period)) {
      return { error: "invalid period for granularity", status: 400 };
    }

    // --- scan + attach (async) before any write -----------------------------
    // A scanTabular rejection (corrupt/missing file) or an attachWarehouse throw
    // must surface as the contractual `ingest failed: <cause>` 500 rather than
    // escape as a raised exception. The `no tables detected` 400 is a plain
    // return, so this catch (which only fires on a throw) leaves it untouched.
    const filesDir = process.env.RUNOFF_FILES_DIR ?? "data/files";
    const filePath = join(filesDir, src.storedFilename);
    const tabular = isTabular(src.mime, src.name);
    let scan: TabularScan | null = null;
    try {
      if (tabular) {
        scan = await scanTabular(filePath, src.mime, src.name);
        if (!scan.tables.length) return { error: "no tables detected in file", status: 400 };
        attachWarehouse(db.sqlite, args.projectId);
      }
    } catch (err) {
      return { error: `ingest failed: ${err instanceof Error ? err.message : String(err)}`, status: 500 };
    }

    // --- write: one explicit transaction across app DB + attached warehouse -
    try {
      db.sqlite.exec("BEGIN IMMEDIATE");
      try {
        if (args.newFamily) {
          familyId = newId("fam");
          db.sqlite
            .prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES (?, ?, ?, ?, ?, ?)")
            .run(familyId, args.projectId, args.newFamily.key, args.newFamily.label, args.newFamily.kind, args.newFamily.granularity);
        }
        db.sqlite
          .prepare("UPDATE sources SET status='replaced' WHERE family_id = ? AND status='filed' AND (period IS ? OR period = ?) AND id != ?")
          .run(familyId, args.period, args.period, args.sourceId);
        db.sqlite
          .prepare("UPDATE sources SET family_id = ?, period = ?, status='filed', filed_at=datetime('now') WHERE id = ?")
          .run(familyId, args.period, args.sourceId);

        if (tabular && scan) {
          const names = tableNamesFor(familyKey, scan.tables.map((t) => t.slug));
          const incoming: WhTableSchema[] = scan.tables.map((t) => ({ name: names[t.slug], columns: t.columns }));
          applySchema(db.sqlite, kind === "periodic", incoming);
          // Clear this slot's rows in EVERY family table (existing ∪ incoming):
          // a table missing from this period's file must not keep stale rows.
          const all = new Set([...whFamilyTables(db.sqlite, familyKey).map((t) => t.name), ...incoming.map((t) => t.name)]);
          deleteRows(db.sqlite, [...all], kind === "periodic" ? args.period : null);
          await readTabular(filePath, src.mime, src.name, (table) => {
            const tname = names[table.slug] ?? `fam_${familyKey}__${table.slug}`;
            const cols = table.columns.map((c) => c.name);
            return (batch) => insertRows(db.sqlite, tname, cols, batch, kind === "periodic" ? args.period : null);
          });
        }
        db.sqlite.exec("COMMIT");
      } catch (err) {
        db.sqlite.exec("ROLLBACK");
        return { error: `ingest failed: ${err instanceof Error ? err.message : String(err)}`, status: 500 };
      }
    } finally {
      if (tabular) detachWarehouse(db.sqlite);
    }
    return { ok: true };
  });
}

/**
 * Pack one stored file through the engine's parser and return the head of its
 * packed text (first 2,000 chars) — a content sample for the classifier that
 * handles PDFs and CSVs alike.
 */
export async function readContentSample(
  filesDir: string,
  row: { storedFilename: string; name: string; mime: string },
): Promise<string> {
  const pack = await buildSourcePack([
    { id: "sample", name: row.name, mime: row.mime, path: join(filesDir, row.storedFilename) },
  ]);
  return packForPrompt(pack, ["sample"], 20).slice(0, 2000);
}
