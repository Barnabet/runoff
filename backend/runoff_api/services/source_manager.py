"""Port of the read part of apps/web/lib/sourceManager.ts — listProjectSources.

The write side (fileSource / withIngestLock / uploads) is R2+ and lives
elsewhere; this module carries only the pure read used by the source manager.
"""

import json

from runoff_api.core.db import RunoffDb
from runoff_api.core.warehouse import read_warehouse_tables


def list_project_sources(db: RunoffDb, project_id: str) -> dict:
    """Every family in a project (with its filed periods, ascending) plus the
    project's still-unfiled uploads. `liveFile` is the single live file of a
    constant family (constants have no period); periodic families report None."""
    fams = db.execute(
        "SELECT id, key, label, kind, granularity FROM source_families "
        "WHERE project_id = ? ORDER BY key",
        (project_id,),
    ).fetchall()

    families: list[dict] = []
    for f in fams:
        live = None
        if f["kind"] == "constant":
            live = db.execute(
                "SELECT id, name FROM sources "
                "WHERE family_id = ? AND status='filed' AND period IS NULL LIMIT 1",
                (f["id"],),
            ).fetchone()
        filed_entries = (
            []
            if f["kind"] == "constant"
            else [
                {"period": r["period"], "sourceId": r["sourceId"], "name": r["name"]}
                for r in db.execute(
                    "SELECT period, id AS sourceId, name FROM sources "
                    "WHERE family_id = ? AND status='filed' AND period IS NOT NULL ORDER BY period",
                    (f["id"],),
                ).fetchall()
            ]
        )
        families.append(
            {
                "id": f["id"],
                "key": f["key"],
                "label": f["label"],
                "kind": f["kind"],
                "granularity": f["granularity"],
                "filedPeriods": [r["period"] for r in filed_entries],
                "filedEntries": filed_entries,
                "liveFile": {"sourceId": live["id"], "name": live["name"]} if live else None,
                "tables": [
                    {"name": t["name"], "rowCount": sum(t["rowCounts"].values())}
                    for t in read_warehouse_tables(project_id, f["key"])
                ],
            }
        )

    unfiled: list[dict] = []
    for r in db.execute(
        "SELECT id, project_id AS projectId, family_id AS familyId, period, name, kind, "
        "stored_filename AS storedFilename, mime, size, status, proposal, "
        "uploaded_at AS uploadedAt, filed_at AS filedAt "
        "FROM sources WHERE project_id = ? AND status='unfiled' ORDER BY uploaded_at, id",
        (project_id,),
    ).fetchall():
        row = dict(r)
        row["proposal"] = json.loads(r["proposal"]) if r["proposal"] else None
        unfiled.append(row)

    return {"families": families, "unfiled": unfiled}
