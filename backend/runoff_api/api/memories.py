from fastapi import APIRouter, Depends, Request

from runoff_api.core.db import RunoffDb
from runoff_api.deps import err, get_db

# Blueprint-scoped memory reads live in api/blueprints.py; this router carries the
# memory write routes, added in Task 7.
router = APIRouter()


@router.patch("/memories/{id}")
async def update_memory(id: str, request: Request, db: RunoffDb = Depends(get_db)):
    try:
        body = await request.json()
    except Exception:
        return err(400, "invalid JSON body")
    status = body.get("status") if isinstance(body, dict) else None
    if status != "active" and status != "disabled":
        return err(400, "status must be 'active' or 'disabled'")
    cur = db.execute("UPDATE memories SET status = ? WHERE id = ?", (status, id))
    if cur.rowcount == 0:
        return err(404, "memory not found")
    return {"ok": True}


@router.delete("/memories/{id}")
def delete_memory(id: str, db: RunoffDb = Depends(get_db)):
    cur = db.execute("DELETE FROM memories WHERE id = ?", (id,))
    if cur.rowcount == 0:
        return err(404, "memory not found")
    return {"ok": True}
