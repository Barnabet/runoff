"""Port of apps/worker/src/runData.ts.

The run's warehouse window: the shared core catalog restricted to the
blueprint's bound families, with `exec` pinned to the run's period.
"""

from runoff_api.core.db import RunoffDb
from runoff_api.core.warehouse import run_warehouse_sql
from runoff_api.core.warehouse_catalog import build_warehouse_catalog


def build_run_data(db: RunoffDb, project_id: str, bound_family_ids: list[str], period: str | None) -> dict:
    bound = set(bound_family_ids)
    catalog = [f for f in build_warehouse_catalog(db, project_id) if f["id"] in bound]
    return {"catalog": catalog, "exec": lambda sql: run_warehouse_sql(project_id, sql, period)}
