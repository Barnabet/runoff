"""Port of packages/core/src/warehouseCatalog.ts."""

from runoff_api.core.db import RunoffDb
from runoff_api.core.warehouse import read_warehouse_tables


def build_warehouse_catalog(db: RunoffDb, project_id: str) -> list[dict]:
    """Families → warehouse tables/columns/counts for one project."""
    fams = db.execute(
        "SELECT id, key, label, kind, granularity FROM source_families WHERE project_id = ? ORDER BY key",
        (project_id,),
    ).fetchall()
    catalog: list[dict] = []
    for f in fams:
        tables = read_warehouse_tables(project_id, f["key"])
        if f["kind"] == "constant":
            filed_periods: list[str] = []
        else:
            filed_periods = [
                r["period"]
                for r in db.execute(
                    "SELECT period FROM sources WHERE family_id = ? AND status='filed' "
                    "AND period IS NOT NULL ORDER BY period",
                    (f["id"],),
                ).fetchall()
            ]
        catalog.append(
            {
                "id": f["id"],
                "key": f["key"],
                "label": f["label"],
                "kind": f["kind"],
                "granularity": f["granularity"],
                "queryable": len(tables) > 0,
                "tables": tables,
                "filedPeriods": filed_periods,
            }
        )
    return catalog
