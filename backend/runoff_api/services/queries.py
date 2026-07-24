"""Port of apps/web/lib/queries.ts — listProjects, getProjectPayload,
listBlueprintsWithRuns, getRunPayload, buildCopilotContext.

Server-only db reads shared by the API routes and the server-rendered pages so
the joins live in exactly one place.
"""

import json
import os

from runoff_api.core.db import RunoffDb
from runoff_api.core.ids import new_id
from runoff_api.core.previous_run import previous_completed_document
from runoff_api.core.types.document import blocks_to_plain_text
from runoff_api.core.warehouse import format_sql_result, run_warehouse_sql
from runoff_api.core.warehouse_catalog import build_warehouse_catalog
from runoff_api.services.goldens import list_golden_summaries
from runoff_api.services.source_manager import list_project_sources


def list_projects(db: RunoffDb) -> list[dict]:
    """Every project with its blueprint count and most recent activity (latest run or revision)."""
    rows = db.execute(
        """SELECT p.id, p.name,
              (SELECT COUNT(*) FROM blueprints b WHERE b.project_id = p.id) AS blueprintCount,
              (SELECT MAX(t) FROM (
                 SELECT MAX(r.created_at) AS t FROM runs r JOIN blueprints b ON b.id = r.blueprint_id
                   WHERE b.project_id = p.id
                 UNION ALL
                 SELECT MAX(br.created_at) FROM blueprint_revisions br
                   JOIN blueprints b ON b.id = br.blueprint_id
                   WHERE b.project_id = p.id
               )) AS lastActivityAt
       FROM projects p ORDER BY p.created_at DESC, p.id DESC"""
    ).fetchall()
    return [dict(r) for r in rows]


def get_project_payload(db: RunoffDb, id: str) -> dict | None:
    """One project's header row plus its scoped blueprint ledger and source manager
    state (families + unfiled uploads). Returns None when the project row is missing."""
    project = db.execute(
        "SELECT id, name, created_at AS createdAt FROM projects WHERE id = ?", (id,)
    ).fetchone()
    if project is None:
        return None
    sources = list_project_sources(db, id)
    memories = db.execute(
        """SELECT id, scope, project_id AS projectId, blueprint_id AS blueprintId, body, source,
              origin_id AS originId, status, created_at AS createdAt
       FROM memories WHERE scope='project' AND project_id = ? ORDER BY rowid DESC""",
        (id,),
    ).fetchall()
    return {
        "project": dict(project),
        "blueprints": list_blueprints_with_runs(db, id),
        "families": sources["families"],
        "unfiled": sources["unfiled"],
        "memories": [dict(m) for m in memories],
    }


def list_blueprints_with_runs(db: RunoffDb, project_id: str) -> list[dict]:
    """Every blueprint in one project with its bound-source count, its latest run (by
    created_at), and that run's open-flag count. Ordered newest-blueprint first."""
    rows = db.execute(
        """SELECT b.id, b.name, b.client_name AS clientName, b.cadence_label AS cadenceLabel,
              b.status, b.current_rev AS currentRev,
              (SELECT COUNT(*) FROM blueprint_families bf WHERE bf.blueprint_id = b.id) AS sourceCount
       FROM blueprints b
       WHERE b.project_id = ?
       ORDER BY b.created_at DESC, b.id DESC""",
        (project_id,),
    ).fetchall()

    result: list[dict] = []
    for b in rows:
        run = db.execute(
            """SELECT id, finished_at AS finishedAt, status FROM runs
         WHERE blueprint_id = ? ORDER BY created_at DESC, id DESC LIMIT 1""",
            (b["id"],),
        ).fetchone()
        if run is not None:
            open_flags = db.execute(
                "SELECT COUNT(*) AS n FROM flags WHERE run_id = ? AND status = 'open'", (run["id"],)
            ).fetchone()["n"]
            last_run: dict | None = {
                "id": run["id"],
                "finishedAt": run["finishedAt"],
                "status": run["status"],
                "openFlags": open_flags,
            }
        else:
            last_run = None
        item = dict(b)
        item["lastRun"] = last_run
        result.append(item)
    return result


def get_run_payload(db: RunoffDb, id: str) -> dict | None:
    """Everything the Live Run UI needs for a run in one read: the run row, the full
    ordered event log, the run's flags, the pinned revision's section metadata and
    masthead, source labels, and the parent blueprint. Returns None when the run
    (or its blueprint) is missing so callers can 404."""
    run = db.execute(
        """SELECT id, blueprint_id AS blueprintId, blueprint_rev AS blueprintRev,
              trigger_kind AS triggerKind, status, period, started_at AS startedAt,
              finished_at AS finishedAt, stats, document, created_at AS createdAt
       FROM runs WHERE id = ?""",
        (id,),
    ).fetchone()
    if run is None:
        return None

    previous = previous_completed_document(db, run["blueprintId"], run["id"], run["createdAt"])

    memories = db.execute(
        """SELECT id, body, scope FROM memories
       WHERE blueprint_id = ?
          OR (scope='project' AND project_id = (SELECT project_id FROM blueprints WHERE id = ?))
       ORDER BY rowid""",
        (run["blueprintId"], run["blueprintId"]),
    ).fetchall()

    blueprint_row = db.execute(
        "SELECT id, name, client_name AS clientName, project_id AS projectId FROM blueprints WHERE id = ?",
        (run["blueprintId"],),
    ).fetchone()
    if blueprint_row is None:
        return None
    project_id = blueprint_row["projectId"]
    blueprint = {
        "id": blueprint_row["id"],
        "name": blueprint_row["name"],
        "clientName": blueprint_row["clientName"],
    }

    # The owning project (for the Reader's back-link); LEFT-join semantics — a
    # blueprint predating projects (project_id '') yields an empty stub.
    project_row = db.execute(
        "SELECT id, name FROM projects WHERE id = ?", (project_id,)
    ).fetchone()
    project = dict(project_row) if project_row is not None else {"id": project_id, "name": ""}

    events = [
        json.loads(r["payload"])
        for r in db.execute(
            "SELECT payload FROM run_events WHERE run_id = ? ORDER BY seq", (id,)
        ).fetchall()
    ]

    flags: list[dict] = []
    for f in db.execute(
        """SELECT id, run_id AS runId, code, section_key AS sectionKey, question,
                options, status, resolution, created_at AS createdAt
         FROM flags WHERE run_id = ? ORDER BY code, id""",
        (id,),
    ).fetchall():
        item = dict(f)
        item["options"] = json.loads(f["options"])
        item["resolution"] = json.loads(f["resolution"]) if f["resolution"] else None
        flags.append(item)

    # Section metadata + masthead come from the revision the run is pinned to, not
    # the blueprint's current revision — the run drafted against that snapshot.
    rev_row = db.execute(
        "SELECT content FROM blueprint_revisions WHERE blueprint_id = ? AND rev = ?",
        (run["blueprintId"], run["blueprintRev"]),
    ).fetchone()
    rev_content = json.loads(rev_row["content"]) if rev_row is not None else None
    if rev_content is not None:
        section_meta = sorted(
            (
                {"key": s["key"], "number": s["number"], "heading": s["heading"]}
                for s in rev_content["sections"]
            ),
            key=lambda s: s["number"],
        )
        delivery = rev_content.get("delivery")
        masthead = {
            "title": rev_content["title"],
            "eyebrow": rev_content["eyebrow"],
            "dateline": rev_content["dateline"],
            "delivery": delivery if delivery is not None else {"recipient": "", "autoDeliverOnClear": False},
        }
    else:
        section_meta = []
        masthead = {
            "title": "",
            "eyebrow": "",
            "dateline": "",
            "delivery": {"recipient": "", "autoDeliverOnClear": False},
        }

    # sourceLabels maps family id -> family label.
    source_rows = db.execute(
        """SELECT f.id, f.label AS name FROM blueprint_families bf
       JOIN source_families f ON f.id = bf.family_id
       WHERE bf.blueprint_id = ?""",
        (run["blueprintId"],),
    ).fetchall()
    source_labels = {s["id"]: s["name"] for s in source_rows}

    return {
        "run": dict(run),
        "events": events,
        "flags": flags,
        "sectionMeta": section_meta,
        "sourceLabels": source_labels,
        "blueprint": blueprint,
        "project": project,
        "content": masthead,
        "previous": previous,
        "memories": [dict(m) for m in memories],
    }


def build_copilot_context(
    db: RunoffDb, blueprint_id: str, golden_cache: dict, scaffold_cache: dict
) -> dict:
    """Server-side data access for one copilot turn: the project family tree, the
    bound families' default/per-period files, the warehouse catalog, and the seven
    method callbacks (runSql, listRuns, getRunSection, listGoldens, getGolden,
    scaffoldDigest, saveMemory).

    Parity port of apps/web/lib/queries.ts buildCopilotContext — the returned dict
    carries both the serialisable data fields and the callables, which close over
    (db, blueprint_id, project_id, golden_cache, scaffold_cache). db.py opens the
    connection with check_same_thread=False, so these closures are safe to call
    from the copilot worker thread later. The dict also keeps `goldenCache` /
    `scaffoldCache` (harmless extra keys beyond the TS interface) so Python
    consumers can reach the caches directly.

    Caps: 30 active memories, 500-char bodies. `golden_cache` is pre-resolved by
    the caller (exemplar parsing is async; the engine context is synchronous).
    """
    files_dir = os.environ.get("RUNOFF_FILES_DIR", "data/files")

    # The full project taxonomy: every family (bound or not) with its filed
    # periods / live-file status. `bound` marks the ones on this blueprint.
    project_row = db.execute(
        "SELECT project_id AS projectId FROM blueprints WHERE id = ?", (blueprint_id,)
    ).fetchone()
    project_id = project_row["projectId"] if project_row is not None else ""
    bound_set = {
        r["familyId"]
        for r in db.execute(
            "SELECT family_id AS familyId FROM blueprint_families WHERE blueprint_id = ?",
            (blueprint_id,),
        ).fetchall()
    }
    fam_rows = db.execute(
        "SELECT id, key, label, kind, granularity FROM source_families WHERE project_id = ? ORDER BY key",
        (project_id,),
    ).fetchall()
    families: list[dict] = []
    for f in fam_rows:
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
        has_live_file = (
            db.execute(
                "SELECT 1 FROM sources WHERE family_id = ? AND status='filed' AND period IS NULL LIMIT 1",
                (f["id"],),
            ).fetchone()
            is not None
            if f["kind"] == "constant"
            else False
        )
        families.append(
            {
                "id": f["id"],
                "key": f["key"],
                "label": f["label"],
                "kind": f["kind"],
                "granularity": f["granularity"],
                "filedPeriods": filed_periods,
                "hasLiveFile": has_live_file,
                "bound": f["id"] in bound_set,
            }
        )

    # defaultFiles: each bound family resolved to its live file — constants take
    # their null-slot file, periodics the latest filed period (lexicographic MAX);
    # mirrors resolveRunSources without a run period. EngineFile.id is the FAMILY id.
    default_files: list[dict] = []
    for f in families:
        if not f["bound"]:
            continue
        if f["kind"] == "constant":
            row = db.execute(
                "SELECT mime, stored_filename AS storedFilename FROM sources "
                "WHERE family_id = ? AND status='filed' AND period IS NULL",
                (f["id"],),
            ).fetchone()
        else:
            row = db.execute(
                "SELECT mime, stored_filename AS storedFilename FROM sources "
                "WHERE family_id = ? AND status='filed' AND period IS NOT NULL ORDER BY period DESC LIMIT 1",
                (f["id"],),
            ).fetchone()
        if row is None:
            continue
        default_files.append(
            {
                "id": f["id"],
                "name": f["label"],
                "mime": row["mime"],
                "path": os.path.join(files_dir, row["storedFilename"]),
            }
        )

    # periodFiles: every filed periodic row of the bound families, so the copilot
    # can inspect any historical period via query_sources {familyId, period}.
    period_files: list[dict] = []
    for f in families:
        if not f["bound"] or f["kind"] != "periodic":
            continue
        for row in db.execute(
            "SELECT period, mime, stored_filename AS storedFilename FROM sources "
            "WHERE family_id = ? AND status='filed' AND period IS NOT NULL ORDER BY period",
            (f["id"],),
        ).fetchall():
            period_files.append(
                {
                    "familyId": f["id"],
                    "period": row["period"],
                    "file": {
                        "id": f["id"],
                        "name": f["label"],
                        "mime": row["mime"],
                        "path": os.path.join(files_dir, row["storedFilename"]),
                    },
                }
            )

    def run_sql(sql: str) -> str:
        latest = db.execute(
            "SELECT MAX(period) AS p FROM sources WHERE project_id = ? AND status='filed' "
            "AND period IS NOT NULL",
            (project_id,),
        ).fetchone()["p"]
        return format_sql_result(run_warehouse_sql(project_id, sql, period=latest))

    def list_runs() -> list[dict]:
        rows = db.execute(
            "SELECT r.id, r.created_at AS createdAt, r.status, r.stats, r.blueprint_rev AS rev, "
            "(SELECT COUNT(*) FROM flags f WHERE f.run_id = r.id) AS flagCount "
            "FROM runs r WHERE r.blueprint_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 10",
            (blueprint_id,),
        ).fetchall()
        out: list[dict] = []
        for r in rows:
            item = dict(r)
            item["stats"] = json.loads(r["stats"]) if r["stats"] else None
            out.append(item)
        return out

    def get_run_section(run_id: str, key: str) -> dict | None:
        run = db.execute(
            "SELECT blueprint_id AS blueprintId, document FROM runs WHERE id = ?", (run_id,)
        ).fetchone()
        if run is None or run["blueprintId"] != blueprint_id or not run["document"]:
            return None
        doc = json.loads(run["document"])
        section = next((s for s in doc["sections"] if s["key"] == key), None)
        if section is None:
            return None

        detail: dict = {
            "text": blocks_to_plain_text(section["blocks"]),
            "checkFailures": [],
            "retryReasons": [],
            "steers": [],
            "answers": [],
            "flags": [],
        }
        events = db.execute(
            "SELECT type, payload FROM run_events WHERE run_id = ? AND type IN "
            "('check_failed','retry_started','steer_received','question_raised','question_answered') "
            "ORDER BY seq",
            (run_id,),
        ).fetchall()
        # `question_answered` carries only {questionId, answer}; the question text
        # and its owning section live in the preceding `question_raised` event, so
        # map ids -> {question, sectionKey} first.
        raised: dict = {}
        for e in events:
            if e["type"] != "question_raised":
                continue
            p = json.loads(e["payload"])
            if isinstance(p.get("questionId"), str) and isinstance(p.get("question"), str):
                raised[p["questionId"]] = {
                    "question": p["question"],
                    "sectionKey": p["sectionKey"] if isinstance(p.get("sectionKey"), str) else None,
                }
        for e in events:
            p = json.loads(e["payload"])
            if p.get("sectionKey") and p["sectionKey"] != key:
                continue
            if e["type"] == "check_failed":
                detail["checkFailures"].append(str(p.get("detail", "")))
            if e["type"] == "retry_started":
                detail["retryReasons"].append(str(p.get("reason", "")))
            if e["type"] == "steer_received":
                detail["steers"].append(str(p.get("text", "")))
            if e["type"] == "question_answered":
                info = raised.get(p.get("questionId"))
                # Scope the answer to the section its question was raised in; if the
                # raised event is missing or had no sectionKey, keep it everywhere.
                if info and info["sectionKey"] and info["sectionKey"] != key:
                    continue
                detail["answers"].append(
                    {
                        "question": (info["question"] if info else str(p.get("questionId", ""))),
                        "answer": str(p.get("answer", "")),
                    }
                )
        flags = db.execute(
            "SELECT question, status, resolution FROM flags WHERE run_id = ? AND section_key = ?",
            (run_id, key),
        ).fetchall()
        detail["flags"] = [
            {"question": f["question"], "status": f["status"], "resolution": f["resolution"]}
            for f in flags
        ]
        return detail

    def list_goldens_cb() -> list[dict]:
        return list_golden_summaries(db, blueprint_id)

    def get_golden(golden_id: str) -> dict | None:
        return golden_cache.get(golden_id)

    def scaffold_digest(golden_id: str) -> str:
        return scaffold_cache.get(golden_id, f"golden not found: {golden_id}")

    def save_memory(body: str, scope: str) -> str:
        mem_id = new_id("mem")
        # Cap 30 active per scope; project keys on project_id, blueprint on blueprint_id.
        clause = (
            "scope='project' AND project_id = ?"
            if scope == "project"
            else "scope='blueprint' AND blueprint_id = ?"
        )
        val = project_id if scope == "project" else blueprint_id
        n = db.execute(
            f"SELECT COUNT(*) AS n FROM memories WHERE {clause} AND status='active'", (val,)
        ).fetchone()["n"]
        if n >= 30:
            db.execute(
                f"UPDATE memories SET status='disabled' WHERE id = "
                f"(SELECT id FROM memories WHERE {clause} AND status='active' ORDER BY rowid LIMIT 1)",
                (val,),
            )
        db.execute(
            "INSERT INTO memories (id, scope, project_id, blueprint_id, body, source, origin_id) "
            "VALUES (?, ?, ?, ?, ?, 'copilot', NULL)",
            (mem_id, scope, project_id, blueprint_id if scope == "blueprint" else None, body[:500]),
        )
        return mem_id

    return {
        "families": families,
        "defaultFiles": default_files,
        "periodFiles": period_files,
        "catalog": build_warehouse_catalog(db, project_id),
        "goldenCache": golden_cache,
        "scaffoldCache": scaffold_cache,
        "runSql": run_sql,
        "listRuns": list_runs,
        "getRunSection": get_run_section,
        "listGoldens": list_goldens_cb,
        "getGolden": get_golden,
        "scaffoldDigest": scaffold_digest,
        "saveMemory": save_memory,
    }
