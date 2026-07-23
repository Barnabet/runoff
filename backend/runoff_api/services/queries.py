"""Port of apps/web/lib/queries.ts — listProjects, getProjectPayload,
listBlueprintsWithRuns, getRunPayload (NOT buildCopilotContext, which is R3).

Server-only db reads shared by the API routes and the server-rendered pages so
the joins live in exactly one place.
"""

import json

from runoff_api.core.db import RunoffDb
from runoff_api.core.previous_run import previous_completed_document
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
        masthead = {
            "title": rev_content["title"],
            "eyebrow": rev_content["eyebrow"],
            "dateline": rev_content["dateline"],
            "delivery": rev_content.get("delivery")
            or {"recipient": "", "autoDeliverOnClear": False},
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
