from fastapi import APIRouter, Depends

from runoff_api.core.db import RunoffDb
from runoff_api.deps import get_db
from runoff_api.services.goldens import list_goldens

router = APIRouter()


@router.get("/blueprints/{id}/goldens")
def get_blueprint_goldens(id: str, db: RunoffDb = Depends(get_db)):
    return {"goldens": list_goldens(db, id)}
