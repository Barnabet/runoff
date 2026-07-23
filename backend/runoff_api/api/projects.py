from fastapi import APIRouter, Depends, Request

from runoff_api.core.db import RunoffDb
from runoff_api.core.ids import new_id
from runoff_api.deps import err, get_db
from runoff_api.services.queries import get_project_payload, list_projects
from runoff_api.services.source_manager import list_project_sources

router = APIRouter()


@router.get("/projects")
def get_projects(db: RunoffDb = Depends(get_db)):
    return {"projects": list_projects(db)}


@router.get("/projects/{id}")
def get_project(id: str, db: RunoffDb = Depends(get_db)):
    payload = get_project_payload(db, id)
    if payload is None:
        return err(404, "project not found")
    return payload


@router.get("/projects/{id}/sources")
def get_project_sources(id: str, db: RunoffDb = Depends(get_db)):
    project = db.execute("SELECT id FROM projects WHERE id = ?", (id,)).fetchone()
    if project is None:
        return err(404, "project not found")
    return list_project_sources(db, id)


@router.post("/projects")
async def create_project(request: Request, db: RunoffDb = Depends(get_db)):
    try:
        body = await request.json()
    except Exception:
        return err(400, "invalid JSON body")
    raw_name = body.get("name") if isinstance(body, dict) else None
    name = raw_name.strip() if isinstance(raw_name, str) else ""
    if not name:
        return err(400, "name required")
    id = new_id("proj")
    db.execute("INSERT INTO projects (id, name) VALUES (?, ?)", (id, name))
    return {"id": id}


@router.patch("/projects/{id}")
async def update_project(id: str, request: Request, db: RunoffDb = Depends(get_db)):
    exists = db.execute("SELECT id FROM projects WHERE id = ?", (id,)).fetchone()
    if exists is None:
        return err(404, "project not found")
    try:
        body = await request.json()
    except Exception:
        return err(400, "invalid JSON body")
    raw_name = body.get("name") if isinstance(body, dict) else None
    name = raw_name.strip() if isinstance(raw_name, str) else ""
    if not name:
        return err(400, "name required")
    db.execute("UPDATE projects SET name = ? WHERE id = ?", (name, id))
    return {"ok": True}
