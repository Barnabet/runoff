import json

from fastapi import APIRouter, Depends, Request

from runoff_api.core.db import RunoffDb
from runoff_api.deps import err, get_db
from runoff_api.services.queries import list_blueprints_with_runs
from runoff_api.services.query_row_counts import compute_query_row_counts
from runoff_api.services.run_options import get_run_options
from runoff_api.services.source_manager import list_project_sources

router = APIRouter()


@router.get("/blueprints")
def get_blueprints(request: Request, db: RunoffDb = Depends(get_db)):
    project_id = request.query_params.get("projectId")
    if not project_id:
        return err(400, "projectId is required")
    return {"blueprints": list_blueprints_with_runs(db, project_id)}


@router.get("/blueprints/{id}")
def get_blueprint(id: str, db: RunoffDb = Depends(get_db)):
    blueprint = db.execute(
        """SELECT id, name, client_name AS clientName, cadence_label AS cadenceLabel,
              status, current_rev AS currentRev, created_at AS createdAt,
              project_id AS projectId
       FROM blueprints WHERE id = ?""",
        (id,),
    ).fetchone()
    if blueprint is None:
        return err(404, "blueprint not found")

    project_id = blueprint["projectId"]
    project_row = db.execute(
        "SELECT id, name FROM projects WHERE id = ?", (project_id,)
    ).fetchone()
    project = dict(project_row) if project_row is not None else {"id": project_id, "name": ""}

    rev_row = db.execute(
        "SELECT content FROM blueprint_revisions WHERE blueprint_id = ? AND rev = ?",
        (id, blueprint["currentRev"]),
    ).fetchone()
    content = json.loads(rev_row["content"]) if rev_row is not None else None

    families = list_project_sources(db, project_id)["families"]
    bound_family_ids = [
        r["familyId"]
        for r in db.execute(
            "SELECT family_id AS familyId FROM blueprint_families WHERE blueprint_id = ?", (id,)
        ).fetchall()
    ]

    query_row_counts = compute_query_row_counts(db, project_id, content) if content else {}

    return {
        "blueprint": dict(blueprint),
        "content": content,
        "project": project,
        "families": families,
        "boundFamilyIds": bound_family_ids,
        "queryRowCounts": query_row_counts,
    }


@router.get("/blueprints/{id}/run-options")
def get_blueprint_run_options(id: str, db: RunoffDb = Depends(get_db)):
    options = get_run_options(db, id)
    if options is None:
        return err(404, "blueprint not found")
    return options


@router.get("/blueprints/{id}/memories")
def get_blueprint_memories(id: str, db: RunoffDb = Depends(get_db)):
    # Both scopes: this blueprint's own rows plus the project-scoped rows of its
    # project, so the builder drawer can badge each memory's scope.
    rows = db.execute(
        """SELECT id, scope, project_id AS projectId, blueprint_id AS blueprintId, body, source,
              origin_id AS originId, status, created_at AS createdAt
       FROM memories
       WHERE blueprint_id = ?
          OR (scope='project' AND project_id = (SELECT project_id FROM blueprints WHERE id = ?))
       ORDER BY rowid DESC""",
        (id, id),
    ).fetchall()
    return {"memories": [dict(r) for r in rows]}


SELECT_MSG = "SELECT id, role, body, actions, status, created_at AS createdAt FROM copilot_messages"


@router.get("/blueprints/{id}/copilot")
def get_blueprint_copilot(id: str, db: RunoffDb = Depends(get_db)):
    rows = db.execute(f"{SELECT_MSG} WHERE blueprint_id = ? ORDER BY rowid", (id,)).fetchall()
    messages = []
    for r in rows:
        m = dict(r)
        m["actions"] = json.loads(r["actions"]) if r["actions"] else []
        messages.append(m)
    return {"messages": messages}
