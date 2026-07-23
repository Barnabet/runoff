"""Port of apps/web/lib/runOptions.ts — getRunOptions.

The run options for a blueprint: which periods any bound periodic family has
filed (descending), a per-period presence checklist across the bound periodic
families, and the constant-family checklist. Pure read.
"""

from runoff_api.core.db import RunoffDb


def get_run_options(db: RunoffDb, blueprint_id: str) -> dict | None:
    bp = db.execute("SELECT id FROM blueprints WHERE id = ?", (blueprint_id,)).fetchone()
    if bp is None:
        return None

    fams = db.execute(
        """SELECT f.id, f.key, f.label, f.kind, f.granularity FROM blueprint_families bf
       JOIN source_families f ON f.id = bf.family_id WHERE bf.blueprint_id = ? ORDER BY f.key""",
        (blueprint_id,),
    ).fetchall()

    periodic = [f for f in fams if f["kind"] == "periodic"]
    constants = [f for f in fams if f["kind"] == "constant"]

    filed_by_family: dict[str, set[str]] = {
        f["id"]: {
            r["period"]
            for r in db.execute(
                "SELECT period FROM sources WHERE family_id = ? AND status = 'filed' AND period IS NOT NULL",
                (f["id"],),
            ).fetchall()
        }
        for f in periodic
    }
    all_periods = sorted({p for s in filed_by_family.values() for p in s}, reverse=True)

    def live(family_id: str) -> bool:
        return (
            db.execute(
                "SELECT 1 FROM sources WHERE family_id = ? AND status = 'filed' AND period IS NULL",
                (family_id,),
            ).fetchone()
            is not None
        )

    return {
        "granularity": periodic[0]["granularity"] if periodic else None,
        "periods": [
            {
                "period": period,
                "families": [
                    {
                        "key": f["key"],
                        "label": f["label"],
                        "present": period in filed_by_family[f["id"]],
                    }
                    for f in periodic
                ],
            }
            for period in all_periods
        ],
        "constants": [
            {"key": f["key"], "label": f["label"], "present": live(f["id"])} for f in constants
        ],
    }
