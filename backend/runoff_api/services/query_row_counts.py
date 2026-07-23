"""Port of apps/web/lib/queryRowCounts.ts — computeQueryRowCounts.

Per-query row counts for a blueprint's baked section queries, bound to the
project's latest filed period. Shape: sectionKey -> query name -> count (None
when the query fails to compile or run). Sections without queries are omitted.
"""

from runoff_api.core.db import RunoffDb
from runoff_api.core.warehouse import run_warehouse_sql


def compute_query_row_counts(
    db: RunoffDb, project_id: str, content: dict
) -> dict[str, dict[str, int | None]]:
    latest = db.execute(
        "SELECT MAX(period) AS p FROM sources WHERE project_id = ? AND status='filed' AND period IS NOT NULL",
        (project_id,),
    ).fetchone()["p"]

    query_row_counts: dict[str, dict[str, int | None]] = {}
    for s in content["sections"]:
        if not s["queries"]:
            continue
        query_row_counts[s["key"]] = {}
        for qy in s["queries"]:
            try:
                res = run_warehouse_sql(project_id, f"SELECT COUNT(*) FROM ({qy['sql']})", latest)
                rows = res["rows"]
                count = rows[0][0] if rows else None
                query_row_counts[s["key"]][qy["name"]] = count if count is not None else None
            except Exception:  # noqa: BLE001 — any compile/run error => null count
                query_row_counts[s["key"]][qy["name"]] = None
    return query_row_counts
