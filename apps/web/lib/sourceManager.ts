import { join } from "node:path";
import { newId, PERIOD_REGEX, type Granularity, type ProjectSourceRow, type RunoffDb } from "@runoff/core";
import { buildSourcePack, packForPrompt } from "@runoff/engine";

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
export function fileSource(db: RunoffDb, args: FileSourceArgs): { ok: true } | { error: string; status: number } {
  const src = db.sqlite
    .prepare("SELECT id FROM sources WHERE id = ? AND project_id = ?")
    .get(args.sourceId, args.projectId);
  if (!src) return { error: "source not found", status: 404 };

  let result: { ok: true } | { error: string; status: number } = { ok: true };
  const tx = db.sqlite.transaction(() => {
    let familyId = args.familyId ?? null;
    let kind: "periodic" | "constant";
    let granularity: Granularity | null;

    // Resolve the target family's kind/granularity WITHOUT writing yet: a
    // `return` inside a better-sqlite3 transaction commits, so the new-family
    // INSERT must land only after every validation (incl. the period) passes —
    // otherwise a bad period would leave an orphan family row behind.
    if (args.newFamily) {
      const dup = db.sqlite
        .prepare("SELECT id FROM source_families WHERE project_id = ? AND key = ?")
        .get(args.projectId, args.newFamily.key);
      if (dup) { result = { error: `family key already exists: ${args.newFamily.key}`, status: 400 }; return; }
      if (args.newFamily.kind === "periodic" && !args.newFamily.granularity) { result = { error: "periodic family requires a granularity", status: 400 }; return; }
      if (args.newFamily.kind === "constant" && args.newFamily.granularity) { result = { error: "constant family cannot have a granularity", status: 400 }; return; }
      kind = args.newFamily.kind; granularity = args.newFamily.granularity;
    } else {
      const fam = db.sqlite
        .prepare("SELECT kind, granularity FROM source_families WHERE id = ? AND project_id = ?")
        .get(familyId, args.projectId) as { kind: "periodic" | "constant"; granularity: Granularity | null } | undefined;
      if (!fam) { result = { error: "family not found", status: 404 }; return; }
      kind = fam.kind; granularity = fam.granularity;
    }

    if (kind === "constant") {
      if (args.period !== null) { result = { error: "constant families take no period", status: 400 }; return; }
    } else {
      if (args.period === null || !PERIOD_REGEX[granularity as Granularity].test(args.period)) {
        result = { error: "invalid period for granularity", status: 400 }; return;
      }
    }

    // All validation passed — now it's safe to create the new family.
    if (args.newFamily) {
      familyId = newId("fam");
      db.sqlite
        .prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES (?, ?, ?, ?, ?, ?)")
        .run(familyId, args.projectId, args.newFamily.key, args.newFamily.label, args.newFamily.kind, args.newFamily.granularity);
    }

    // Replace any live occupant of the slot. NULLs are distinct in SQLite unique
    // indexes, so the constant single-live-file rule is enforced here in code:
    // `period IS ?` matches the NULL slot, `period = ?` matches a periodic slot.
    db.sqlite
      .prepare("UPDATE sources SET status='replaced' WHERE family_id = ? AND status='filed' AND (period IS ? OR period = ?) AND id != ?")
      .run(familyId, args.period, args.period, args.sourceId);
    db.sqlite
      .prepare("UPDATE sources SET family_id = ?, period = ?, status='filed', filed_at=datetime('now') WHERE id = ?")
      .run(familyId, args.period, args.sourceId);
  });
  tx();
  return result;
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
