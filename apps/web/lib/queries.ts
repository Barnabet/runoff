import type { RunEvent, RunoffDb } from "@runoff/core";
import type { BlueprintListItem, FlagRow, GetRunResponse, RunRow, SourceRow } from "./api";

// Server-only db reads shared by the API route and the server-rendered Library
// page so the blueprint+run join lives in exactly one place. Never import this
// from client code — it touches the SQLite handle.

interface BlueprintListRow {
  id: string;
  name: string;
  clientName: string;
  cadenceLabel: string;
  status: string;
  currentRev: number;
  sourceCount: number;
}

/**
 * Every blueprint with its bound-source count, its latest run (by created_at),
 * and that run's open-flag count. Ordered newest-blueprint first.
 */
export function listBlueprintsWithRuns(db: RunoffDb): BlueprintListItem[] {
  const rows = db.sqlite
    .prepare(
      `SELECT b.id, b.name, b.client_name AS clientName, b.cadence_label AS cadenceLabel,
              b.status, b.current_rev AS currentRev,
              (SELECT COUNT(*) FROM blueprint_sources bs WHERE bs.blueprint_id = b.id) AS sourceCount
       FROM blueprints b
       ORDER BY b.created_at DESC, b.id DESC`,
    )
    .all() as BlueprintListRow[];

  const lastRunStmt = db.sqlite.prepare(
    `SELECT id, finished_at AS finishedAt, status FROM runs
     WHERE blueprint_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
  const openFlagsStmt = db.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM flags WHERE run_id = ? AND status = 'open'",
  );

  return rows.map((b) => {
    const run = lastRunStmt.get(b.id) as
      | { id: string; finishedAt: string | null; status: string }
      | undefined;
    const lastRun = run
      ? {
          id: run.id,
          finishedAt: run.finishedAt,
          status: run.status,
          openFlags: (openFlagsStmt.get(run.id) as { n: number }).n,
        }
      : null;
    return { ...b, lastRun };
  });
}

interface FlagDbRow {
  id: string;
  runId: string;
  code: string;
  sectionKey: string;
  question: string;
  options: string;
  status: string;
  resolution: string | null;
  createdAt: string;
}

/**
 * Everything the Live Run UI needs for a run in one read: the run row, the full
 * ordered event log, the run's flags, the pinned revision's section metadata and
 * masthead, source labels, and the parent blueprint. Shared by GET /api/runs/:id
 * and the server-rendered run page so the query lives in exactly one place.
 * Returns null when the run (or its blueprint) is missing so callers can 404.
 */
export function getRunPayload(db: RunoffDb, id: string): GetRunResponse | null {
  const run = db.sqlite
    .prepare(
      `SELECT id, blueprint_id AS blueprintId, blueprint_rev AS blueprintRev,
              trigger_kind AS triggerKind, status, started_at AS startedAt,
              finished_at AS finishedAt, stats, document, created_at AS createdAt
       FROM runs WHERE id = ?`,
    )
    .get(id) as RunRow | undefined;
  if (!run) return null;

  const blueprint = db.sqlite
    .prepare("SELECT id, name, client_name AS clientName FROM blueprints WHERE id = ?")
    .get(run.blueprintId) as { id: string; name: string; clientName: string } | undefined;
  if (!blueprint) return null;

  const events = (
    db.sqlite.prepare("SELECT payload FROM run_events WHERE run_id = ? ORDER BY seq").all(id) as {
      payload: string;
    }[]
  ).map((r) => JSON.parse(r.payload) as RunEvent);

  const flags: FlagRow[] = (
    db.sqlite
      .prepare(
        `SELECT id, run_id AS runId, code, section_key AS sectionKey, question,
                options, status, resolution, created_at AS createdAt
         FROM flags WHERE run_id = ? ORDER BY code, id`,
      )
      .all(id) as FlagDbRow[]
  ).map((f) => ({
    ...f,
    options: JSON.parse(f.options) as string[],
    resolution: f.resolution ? (JSON.parse(f.resolution) as { option: string; note?: string }) : null,
  }));

  // Section metadata + masthead come from the revision the run is pinned to, not
  // the blueprint's current revision — the run drafted against that snapshot.
  const revRow = db.sqlite
    .prepare("SELECT content FROM blueprint_revisions WHERE blueprint_id = ? AND rev = ?")
    .get(run.blueprintId, run.blueprintRev) as { content: string } | undefined;
  const content = revRow
    ? (JSON.parse(revRow.content) as {
        title: string;
        eyebrow: string;
        dateline: string;
        sections: { key: string; number: number; heading: string }[];
      })
    : null;
  const sectionMeta = content
    ? content.sections
        .map((s) => ({ key: s.key, number: s.number, heading: s.heading }))
        .sort((a, b) => a.number - b.number)
    : [];
  const masthead = content
    ? { title: content.title, eyebrow: content.eyebrow, dateline: content.dateline }
    : { title: "", eyebrow: "", dateline: "" };

  const sourceRows = db.sqlite
    .prepare(
      `SELECT s.id, s.name FROM blueprint_sources bs
       JOIN sources s ON s.id = bs.source_id
       WHERE bs.blueprint_id = ?`,
    )
    .all(run.blueprintId) as { id: string; name: string }[];
  const sourceLabels: Record<string, string> = Object.fromEntries(
    sourceRows.map((s) => [s.id, s.name]),
  );

  return { run, events, flags, sectionMeta, sourceLabels, blueprint, content: masthead };
}

/**
 * Every source with a count of blueprints referencing it (`usedBy`), newest
 * upload first. Shared by the GET /api/sources route and the server-rendered
 * Sources page so the join lives in exactly one place.
 */
export function listSourcesWithUsage(db: RunoffDb): SourceRow[] {
  return db.sqlite
    .prepare(
      `SELECT s.id, s.name, s.kind, s.stored_filename AS storedFilename, s.mime, s.size,
              s.uploaded_at AS uploadedAt, s.refreshed_at AS refreshedAt,
              (SELECT COUNT(*) FROM blueprint_sources bs WHERE bs.source_id = s.id) AS usedBy
       FROM sources s
       ORDER BY s.uploaded_at DESC, s.id DESC`,
    )
    .all() as SourceRow[];
}
