"""Port of the NON-LLM half of apps/web/lib/goldenPipeline.ts:
`projectOf`, `execFor`, `queriesForBlueprint`, `rebuildRunGoldenInventory`,
`verifyStoredInventory`. `bindExemplar`/`unifyAndBindExemplar` are LLM (R3).
"""

import json

from runoff_api.core.db import RunoffDb
from runoff_api.core.jsonutil import to_json
from runoff_api.core.warehouse import run_warehouse_sql
from runoff_api.core.warehouse_catalog import build_warehouse_catalog

from .golden_binding import inventory_from_citations, verify_inventory
from .goldens import resolve_golden


def _project_of(db: RunoffDb, blueprint_id: str) -> str:
    """Blueprint → project resolution used by every entry point."""
    row = db.execute("SELECT project_id AS p FROM blueprints WHERE id = ?", (blueprint_id,)).fetchone()
    return row["p"]


def _exec_for(project_id: str, period: str | None):
    """Golden-scoped executor: :period binds to the GOLDEN's period."""

    def run(sql: str) -> dict:
        return run_warehouse_sql(project_id, sql, period)

    return run


def _queries_for_blueprint(db: RunoffDb, blueprint_id: str):
    """The blueprint's current revision section queries, as (sectionKey) => queries[]."""
    row = db.execute(
        "SELECT content FROM blueprint_revisions WHERE blueprint_id = ? "
        "AND rev = (SELECT current_rev FROM blueprints WHERE id = ?)",
        (blueprint_id, blueprint_id),
    ).fetchone()
    by_key: dict[str, list[dict]] = {}
    if row is not None and row["content"]:
        content = json.loads(row["content"])
        for s in content.get("sections") or []:
            by_key[s["key"]] = s.get("queries") or []

    def queries_for(section_key: str) -> list[dict]:
        return by_key.get(section_key, [])

    return queries_for


def rebuild_run_golden_inventory(db: RunoffDb, golden_id: str) -> None:
    g = resolve_golden(db, golden_id)
    if not g or not g["document"]:
        return
    row = db.execute("SELECT blueprint_id AS b FROM goldens WHERE id = ?", (golden_id,)).fetchone()
    project_id = _project_of(db, row["b"])
    submitted = inventory_from_citations(
        g["document"], build_warehouse_catalog(db, project_id), _queries_for_blueprint(db, row["b"])
    )
    verified = verify_inventory(submitted, _exec_for(project_id, g["period"]), g["period"], g["document"])
    db.execute("UPDATE goldens SET bindings = ? WHERE id = ?", (to_json(verified), golden_id))


def verify_stored_inventory(db: RunoffDb, golden_id: str) -> None:
    g = resolve_golden(db, golden_id)
    if not g or not g["inventory"] or not g["document"]:
        return
    row = db.execute("SELECT blueprint_id AS b FROM goldens WHERE id = ?", (golden_id,)).fetchone()
    verified = verify_inventory(
        g["inventory"], _exec_for(_project_of(db, row["b"]), g["period"]), g["period"], g["document"]
    )
    db.execute("UPDATE goldens SET bindings = ? WHERE id = ?", (to_json(verified), golden_id))
