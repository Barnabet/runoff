"""Port of apps/web/lib/goldenPipeline.ts.

Non-LLM half (R1): `projectOf`, `execFor`, `queriesForBlueprint`,
`rebuildRunGoldenInventory`, `verifyStoredInventory`.
LLM half (R3): `siblingsFor`, `bindExemplar`, `unifyAndBindExemplar`.
"""

import json
import os

from runoff_api.core.bindings import parse_bindings
from runoff_api.core.db import RunoffDb
from runoff_api.core.jsonutil import to_json
from runoff_api.core.warehouse import format_sql_result, run_warehouse_sql
from runoff_api.core.warehouse_catalog import build_warehouse_catalog
from runoff_api.engine.bind_golden import bind_golden
from runoff_api.engine.llm import make_llm_client
from runoff_api.engine.source_pack import extract_file_text
from runoff_api.engine.unify_golden import is_unsupported_exemplar_mime, unify_golden_report

from .golden_binding import inventory_from_citations, verify_inventory
from .goldens import get_golden_row, resolve_golden


def _files_dir() -> str:
    """RUNOFF_FILES_DIR (default data/files) — where uploaded exemplars are stored."""
    return os.environ.get("RUNOFF_FILES_DIR", "data/files")


def _project_of(db: RunoffDb, blueprint_id: str) -> str:
    """Blueprint → project resolution used by every entry point."""
    row = db.execute("SELECT project_id AS p FROM blueprints WHERE id = ?", (blueprint_id,)).fetchone()
    return row["p"]


def _exec_for(project_id: str, period: str | None):
    """Golden-scoped executor: :period binds to the GOLDEN's period."""

    def run(sql: str) -> dict:
        return run_warehouse_sql(project_id, sql, period)

    return run


def _run_sql_for(project_id: str, period: str | None):
    """Golden-scoped run_sql closure for the bind agent: formatted rows, :period bound."""

    def run(sql: str) -> str:
        return format_sql_result(run_warehouse_sql(project_id, sql, period))

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


def _siblings_for(db: RunoffDb, blueprint_id: str, exclude_golden_id: str) -> list[dict]:
    """Sibling context: bound inventories of the blueprint's OTHER goldens, newest 3.

    A single corrupt/schema-drifted sibling row degrades to skip (mirrors parse_bindings)
    rather than failing every other golden's bind.
    """
    rows = db.execute(
        "SELECT id, period, bindings FROM goldens WHERE blueprint_id = ? AND id != ? "
        "AND bindings IS NOT NULL ORDER BY rowid DESC LIMIT 3",
        (blueprint_id, exclude_golden_id),
    ).fetchall()
    out: list[dict] = []
    for r in rows:
        inventory = parse_bindings(r["bindings"])
        if inventory is None:
            continue  # corrupt/schema-drifted → skip, not fatal
        out.append({"period": r["period"], "inventory": inventory})
    return out


def bind_exemplar(db: RunoffDb, golden_id: str, feedback: str | None = None) -> dict:
    """Bind a unified golden to warehouse data via the LLM agent, verify, and persist.

    Returns {"ok": True} or {"ok": False, "error": <str>}. The whole body is guarded so
    any failure surfaces as an error dict rather than raising.
    """
    try:
        g = resolve_golden(db, golden_id)
        if not g or not g["document"]:
            return {"ok": False, "error": "golden is not unified"}
        row = db.execute("SELECT blueprint_id AS b FROM goldens WHERE id = ?", (golden_id,)).fetchone()
        project_id = _project_of(db, row["b"])
        submitted = bind_golden(
            client=make_llm_client(),
            catalog=build_warehouse_catalog(db, project_id),
            run_sql=_run_sql_for(project_id, g["period"]),
            document=g["document"],
            period=g["period"],
            siblings=_siblings_for(db, row["b"], golden_id),
            prior_inventory=g["inventory"],
            feedback=feedback,
        )
        if submitted is None:
            return {"ok": False, "error": "bind failed: no inventory produced"}
        verified = verify_inventory(submitted, _exec_for(project_id, g["period"]), g["period"], g["document"])
        db.execute("UPDATE goldens SET bindings = ? WHERE id = ?", (to_json(verified), golden_id))
        return {"ok": True}
    except Exception as e:  # noqa: BLE001 — mirrors the TS catch-all
        return {"ok": False, "error": f"bind failed: {e}"}


def unify_and_bind_exemplar(db: RunoffDb, golden_id: str) -> None:
    """Upload chain: extract the exemplar file, unify it into a document, then auto-bind.

    Unsupported mimes and unify failures persist to unify_error; a bind failure after a
    successful unify leaves bindings null without raising.
    """
    g = get_golden_row(db, golden_id)
    mime = g["mime"]
    if is_unsupported_exemplar_mime(mime or ""):
        db.execute(
            "UPDATE goldens SET unify_error = ? WHERE id = ?",
            (f"unsupported exemplar type for unify: {mime}", golden_id),
        )
        return
    try:
        text = extract_file_text({
            "id": g["id"],
            "name": g["name"] or "exemplar",
            "mime": mime or "text/plain",
            "path": os.path.join(_files_dir(), g["storedFilename"]),
        })
        unified = unify_golden_report(client=make_llm_client(), filename=g["name"] or "exemplar", text=text)
        if unified is None:
            db.execute(
                "UPDATE goldens SET unify_error = ? WHERE id = ?",
                ("unify failed: no document produced", golden_id),
            )
            return
        db.execute(
            "UPDATE goldens SET document = ?, period = ?, unify_error = NULL WHERE id = ?",
            (to_json(unified["document"]), unified["period"], golden_id),
        )
        bind_exemplar(db, golden_id)  # auto-chain; its failure leaves bindings null
    except Exception as e:  # noqa: BLE001 — mirrors the TS catch-all
        db.execute(
            "UPDATE goldens SET unify_error = ? WHERE id = ?",
            (f"unify failed: {e}", golden_id),
        )
