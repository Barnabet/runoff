"""Port of apps/web/lib/sourceManager.ts — server-only source-manager slot logic.

listProjectSources landed in R1; the write side (withIngestLock, tableNamesFor,
fileSource, readContentSample) is R2. fileSource saves nothing new to disk — the
upload route (Task 10) writes the bytes — it resolves the family/slot, marks any
occupant `replaced`, and ingests tabular files into the per-project warehouse via
the scan or parse-plan path, all in one explicit BEGIN…COMMIT transaction.
"""

import json
import os
import threading
from collections.abc import Callable

from runoff_api.core.db import RunoffDb
from runoff_api.core.ids import new_id
from runoff_api.core.jsonutil import to_json
from runoff_api.core.types.parse_plan import ParsePlan, plan_table_name
from runoff_api.core.types.sources import PERIOD_REGEX
from runoff_api.core.warehouse import (
    apply_schema,
    attach_warehouse,
    delete_rows,
    detach_warehouse,
    insert_rows,
    read_warehouse_tables,
    wh_family_tables,
)
from runoff_api.engine.parse_plan import execute_parse_plan, load_grids
from runoff_api.engine.source_pack import build_source_pack, pack_for_prompt
from runoff_api.engine.tabular import is_tabular, read_tabular, scan_tabular

# Confirm/refile operations open an explicit BEGIN…COMMIT; the shared SQLite
# handle must not see statements from other requests inside that window. A
# module-level lock serializes them — the sync analogue of the TS promise chain.
_ingest_lock = threading.Lock()


def with_ingest_lock[T](fn: Callable[[], T]) -> T:
    with _ingest_lock:
        return fn()


def table_names_for(family_key: str, slugs: list[str]) -> dict:
    """Final warehouse table name per detected slug: single table -> fam_<key>."""
    single = len(slugs) == 1
    return {s: (f"fam_{family_key}" if single else f"fam_{family_key}__{s}") for s in slugs}


def _parse_plan(raw: dict) -> dict:
    """Port of ParsePlanSchema.parse for the plain-dict runtime: validate + apply
    zod's onPeriodMismatch default (raises on an invalid stored plan)."""
    plan = ParsePlan.model_validate(raw).model_dump(by_alias=True, exclude_unset=True)
    for t in plan["tables"]:
        t.setdefault("onPeriodMismatch", "keep")
    return plan


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


def file_source(db: RunoffDb, args: dict) -> dict:
    """File (or refile) one source into a family slot. Creates the family when
    `newFamily` is given; validates period against granularity (constant ⇒ None);
    marks any live occupant `replaced`; everything in one transaction. Shared by
    the confirm and refile routes. Returns {"ok": True} or {"error", "status"}."""
    src = db.execute(
        "SELECT id, name, mime, stored_filename AS storedFilename, status, proposal "
        "FROM sources WHERE id = ? AND project_id = ?",
        (args["sourceId"], args["projectId"]),
    ).fetchone()
    if not src:
        return {"error": "source not found", "status": 404}

    def run() -> dict:
        # --- resolve + validate (reads only; serialized by the lock) ------------
        family_id = args.get("familyId")
        new_family = args.get("newFamily")
        period = args["period"]
        if new_family:
            dup = db.execute(
                "SELECT id FROM source_families WHERE project_id = ? AND key = ?",
                (args["projectId"], new_family["key"]),
            ).fetchone()
            if dup:
                return {"error": f"family key already exists: {new_family['key']}", "status": 400}
            if new_family["kind"] == "periodic" and not new_family["granularity"]:
                return {"error": "periodic family requires a granularity", "status": 400}
            if new_family["kind"] == "constant" and new_family["granularity"]:
                return {"error": "constant family cannot have a granularity", "status": 400}
            family_key = new_family["key"]
            kind = new_family["kind"]
            granularity = new_family["granularity"]
        else:
            fam = db.execute(
                "SELECT key, kind, granularity FROM source_families WHERE id = ? AND project_id = ?",
                (family_id, args["projectId"]),
            ).fetchone()
            if not fam:
                return {"error": "family not found", "status": 404}
            family_key = fam["key"]
            kind = fam["kind"]
            granularity = fam["granularity"]
        if kind == "constant":
            if period is not None:
                return {"error": "constant families take no period", "status": 400}
        # fullmatch, not search: JS non-multiline `$` rejects a trailing "\n" but
        # Python's `$` accepts it, so `.search` would let "2026-Q1\n" gate a write to
        # sources.period. (core/types/sources.py format_period keeps `.search` on the
        # same patterns — pre-existing R1 read-side display, left untouched.)
        elif period is None or not PERIOD_REGEX[granularity].fullmatch(period):
            return {"error": "invalid period for granularity", "status": 400}

        # --- scan/load + attach before any write --------------------------------
        # A loader failure (corrupt/missing file), a corrupt stored plan, or an
        # attach_warehouse throw must surface as the contractual `ingest failed:
        # <cause>` 500 rather than escape. The `no tables detected` 400 is a plain
        # return, so the except (which only fires on a throw) leaves it alone.
        files_dir = os.environ.get("RUNOFF_FILES_DIR", "data/files")
        file_path = os.path.join(files_dir, src["storedFilename"])
        tabular = is_tabular(src["mime"], src["name"])
        scan = None
        grids = None
        plan = None
        try:
            # The source row's classify-time proposal plan wins ONLY for an unfiled
            # source (confirm flow). Refiling a filed source uses the family's stored
            # plan, so an amended family plan is never re-overwritten by a stale one.
            row_proposal = json.loads(src["proposal"]) if src["proposal"] else None
            if src["status"] == "unfiled" and row_proposal and row_proposal.get("plan"):
                plan = _parse_plan(row_proposal["plan"])
            elif family_id:
                stored = db.execute(
                    "SELECT parse_plan AS p FROM source_families WHERE id = ?", (family_id,)
                ).fetchone()
                if stored and stored["p"]:
                    plan = _parse_plan(json.loads(stored["p"]))
            if plan and args.get("periodMismatch"):
                plan = {
                    **plan,
                    "tables": [
                        {**t, "onPeriodMismatch": args["periodMismatch"]} if t.get("periodColumn") else t
                        for t in plan["tables"]
                    ],
                }

            if tabular and plan:
                grids = load_grids(file_path, src["mime"], src["name"])
                attach_warehouse(db, args["projectId"])
            elif tabular:
                scan = scan_tabular(file_path, src["mime"], src["name"])
                if not scan["tables"]:
                    return {"error": "no tables detected in file", "status": 400}
                attach_warehouse(db, args["projectId"])
        except Exception as err:  # noqa: BLE001 — mirrors the TS catch-all
            return {"error": f"ingest failed: {err}", "status": 500}

        # --- write: one explicit transaction across app DB + attached warehouse -
        try:
            db.execute("BEGIN IMMEDIATE")
            try:
                if new_family:
                    family_id = new_id("fam")
                    db.execute(
                        "INSERT INTO source_families (id, project_id, key, label, kind, granularity) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        (
                            family_id,
                            args["projectId"],
                            new_family["key"],
                            new_family["label"],
                            new_family["kind"],
                            new_family["granularity"],
                        ),
                    )
                db.execute(
                    "UPDATE sources SET status='replaced' WHERE family_id = ? AND status='filed' "
                    "AND (period IS ? OR period = ?) AND id != ?",
                    (family_id, period, period, args["sourceId"]),
                )
                db.execute(
                    "UPDATE sources SET family_id = ?, period = ?, status='filed', "
                    "filed_at=datetime('now') WHERE id = ?",
                    (family_id, period, args["sourceId"]),
                )

                slot_period = period if kind == "periodic" else None
                if tabular and plan and grids is not None:
                    result = execute_parse_plan(grids, plan, slot_period, granularity)
                    tables = result["tables"]
                    report = result["report"]
                    first_problem = next(
                        (p for t in report["tables"] for p in t["problems"]), None
                    )
                    if first_problem:
                        raise RuntimeError(first_problem)
                    if all(t["rowsKept"] == 0 for t in report["tables"]):
                        raise RuntimeError("plan produced no rows")
                    incoming = [
                        {"name": plan_table_name(family_key, plan, t["logical"]), "columns": t["columns"]}
                        for t in tables
                    ]
                    apply_schema(db, kind == "periodic", incoming)
                    all_tables = set(
                        [t["name"] for t in wh_family_tables(db, family_key)]
                        + [t["name"] for t in incoming]
                    )
                    delete_rows(db, list(all_tables), slot_period)
                    for t in tables:
                        tname = plan_table_name(family_key, plan, t["logical"])
                        cols = [c["name"] for c in t["columns"]]
                        for i in range(0, len(t["rows"]), 10_000):
                            insert_rows(db, tname, cols, t["rows"][i : i + 10_000], slot_period)
                    db.execute(
                        "UPDATE source_families SET parse_plan = ? WHERE id = ?",
                        (to_json(plan), family_id),
                    )
                    db.execute(
                        "UPDATE sources SET parse_report = ? WHERE id = ?",
                        (to_json(report), args["sourceId"]),
                    )
                elif tabular and scan is not None:
                    names = table_names_for(family_key, [t["slug"] for t in scan["tables"]])
                    incoming = [
                        {"name": names[t["slug"]], "columns": t["columns"]} for t in scan["tables"]
                    ]
                    apply_schema(db, kind == "periodic", incoming)
                    # Clear this slot's rows in EVERY family table (existing ∪ incoming):
                    # a table missing from this period's file must not keep stale rows.
                    all_tables = set(
                        [t["name"] for t in wh_family_tables(db, family_key)]
                        + [t["name"] for t in incoming]
                    )
                    delete_rows(db, list(all_tables), slot_period)

                    def on_table(table: dict) -> Callable[[list[list]], None]:
                        tname = names.get(table["slug"], f"fam_{family_key}__{table['slug']}")
                        cols = [c["name"] for c in table["columns"]]

                        def emit(batch: list[list]) -> None:
                            insert_rows(db, tname, cols, batch, slot_period)

                        return emit

                    read_tabular(file_path, src["mime"], src["name"], on_table)
                db.execute("COMMIT")
            except Exception as err:  # noqa: BLE001 — mirrors the TS catch-all
                # Guard on in_transaction: on a SQLite auto-rollback (e.g.
                # SQLITE_FULL) no txn remains, so an unconditional ROLLBACK would
                # raise "no transaction is active" and ESCAPE this handler — turning
                # the contractual `ingest failed` 500 into a framework 500. Mirrors
                # better-sqlite3's inTransaction guard.
                if db.in_transaction:
                    db.execute("ROLLBACK")
                return {"error": f"ingest failed: {err}", "status": 500}
        finally:
            if tabular:
                detach_warehouse(db)
        return {"ok": True}

    return with_ingest_lock(run)


def read_content_sample(files_dir: str, row: dict) -> str:
    """Pack one stored file through the engine's parser and return the head of its
    packed text (first 2,000 chars) — a content sample for the classifier that
    handles PDFs and CSVs alike."""
    pack = build_source_pack(
        [
            {
                "id": "sample",
                "name": row["name"],
                "mime": row["mime"],
                "path": os.path.join(files_dir, row["storedFilename"]),
            }
        ]
    )
    return pack_for_prompt(pack, ["sample"])[:2000]
