import type BetterSqlite3 from "better-sqlite3";
import type { RunDocument } from "../types/document.js";

export interface PreviousRun {
  runId: string;
  completedAt: string;
  document: RunDocument;
}

/**
 * The most recent completed run of the same blueprint created at-or-before the
 * current run — excluding the current run itself; same-second ties break by id.
 * Reads the persisted `runs.document` column (written by the worker's
 * run_completed handler). Returns null for a first run, a NULL document, or an
 * unparseable one, so callers can treat null uniformly as "no predecessor".
 */
export function previousCompletedDocument(
  sqlite: BetterSqlite3.Database,
  blueprintId: string,
  current: { runId: string; createdAt: string },
): PreviousRun | null {
  const row = sqlite
    .prepare(
      `SELECT id, document, finished_at AS finishedAt, created_at AS createdAt
       FROM runs
       WHERE blueprint_id = ? AND status = 'complete' AND id != ? AND created_at <= ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(blueprintId, current.runId, current.createdAt) as
    | { id: string; document: string | null; finishedAt: string | null; createdAt: string }
    | undefined;
  if (!row?.document) return null;
  try {
    return {
      runId: row.id,
      completedAt: row.finishedAt ?? row.createdAt,
      document: JSON.parse(row.document) as RunDocument,
    };
  } catch {
    return null;
  }
}
