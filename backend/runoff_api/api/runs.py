from fastapi import APIRouter, Depends

from runoff_api.core.db import RunoffDb
from runoff_api.deps import err, get_db
from runoff_api.services.queries import get_run_payload

router = APIRouter()


@router.get("/runs/{id}")
def get_run(id: str, db: RunoffDb = Depends(get_db)):
    payload = get_run_payload(db, id)
    if payload is None:
        return err(404, "run not found")
    return payload
