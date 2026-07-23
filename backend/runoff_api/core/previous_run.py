"""Port of packages/core/src/db/previousRun.ts."""

import json

from runoff_api.core.db import RunoffDb


def previous_completed_document(
    db: RunoffDb, blueprint_id: str, run_id: str, created_at: str
) -> dict | None:
    """The most recent completed run of the same blueprint created at-or-before the
    current run — excluding the current run itself; same-second ties break by id.

    Reads the persisted `runs.document` column (written by the worker's
    run_completed handler). Returns None for a first run, a NULL document, or an
    unparseable one, so callers can treat None uniformly as "no predecessor".
    """
    row = db.execute(
        """SELECT id, document, finished_at AS finishedAt, created_at AS createdAt
       FROM runs
       WHERE blueprint_id = ? AND status = 'complete' AND id != ? AND created_at <= ?
       ORDER BY created_at DESC, id DESC LIMIT 1""",
        (blueprint_id, run_id, created_at),
    ).fetchone()
    if row is None or not row["document"]:
        return None
    try:
        document = json.loads(row["document"])
    except ValueError:
        return None
    return {
        "runId": row["id"],
        "completedAt": row["finishedAt"] if row["finishedAt"] is not None else row["createdAt"],
        "document": document,
    }
