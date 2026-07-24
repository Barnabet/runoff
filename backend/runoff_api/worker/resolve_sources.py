"""Port of apps/worker/src/resolveSources.ts.

Resolve a blueprint's bound families to concrete files for one run period.
EngineFile["id"] is the FAMILY id, so locators/citations (sum(fam_x.amount))
stay stable across periods. gaps carries the keys of bound families with no
live file in the slot; the run proceeds without them.
"""

import os

from runoff_api.core.db import RunoffDb


def resolve_run_sources(db: RunoffDb, blueprint_id: str, period: str | None) -> dict:
    files_dir = os.environ.get("RUNOFF_FILES_DIR", "data/files")
    fams = db.execute(
        "SELECT f.id, f.key, f.label, f.kind FROM blueprint_families bf "
        "JOIN source_families f ON f.id = bf.family_id WHERE bf.blueprint_id = ? ORDER BY f.key",
        (blueprint_id,),
    ).fetchall()
    files: list[dict] = []
    gaps: list[str] = []
    for f in fams:
        row = db.execute(
            "SELECT mime, stored_filename AS storedFilename FROM sources "
            "WHERE family_id = ? AND status='filed' AND period IS ?",
            (f["id"], None if f["kind"] == "constant" else period),
        ).fetchone()
        if row is None:
            gaps.append(f["key"])
            continue
        files.append(
            {
                "id": f["id"],
                "name": f["label"],
                "mime": row["mime"],
                "path": os.path.join(files_dir, row["storedFilename"]),
            }
        )
    return {"files": files, "gaps": gaps}
