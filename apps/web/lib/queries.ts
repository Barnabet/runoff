import type { RunoffDb } from "@runoff/core";
import type { BlueprintListItem } from "./api";

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
