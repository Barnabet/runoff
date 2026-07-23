from fastapi import APIRouter, Depends, Request

from runoff_api.core.db import RunoffDb
from runoff_api.core.jsonutil import to_json
from runoff_api.deps import err, get_db

# Flag write routes are added in Task 7.
router = APIRouter()


@router.post("/flags/{id}")
async def resolve_flag(id: str, request: Request, db: RunoffDb = Depends(get_db)):
    try:
        body = await request.json()
    except Exception:
        return err(400, "invalid JSON body")
    if not isinstance(body, dict):
        body = {}

    option = body.get("option")
    if not isinstance(option, str):
        return err(400, "option is required")

    flag = db.execute("SELECT run_id AS runId FROM flags WHERE id = ?", (id,)).fetchone()
    if flag is None:
        return err(404, "flag not found")

    resolution: dict = {"option": option}
    if isinstance(body.get("note"), str):
        resolution["note"] = body["note"]

    db.execute(
        "UPDATE flags SET resolution = ?, status = 'resolved' WHERE id = ?",
        (to_json(resolution), id),
    )

    row = db.execute(
        "SELECT COUNT(*) AS remainingOpen FROM flags WHERE run_id = ? AND status = 'open'",
        (flag["runId"],),
    ).fetchone()
    return {"remainingOpen": row["remainingOpen"]}
