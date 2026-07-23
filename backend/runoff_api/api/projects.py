from fastapi import APIRouter, Depends

from runoff_api.core.db import RunoffDb
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
