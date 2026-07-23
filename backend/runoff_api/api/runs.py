from fastapi import APIRouter, Depends, Request

from runoff_api.core.db import RunoffDb
from runoff_api.core.ids import new_id
from runoff_api.core.jsonutil import to_json
from runoff_api.deps import err, get_db
from runoff_api.services.queries import get_run_payload
from runoff_api.services.run_options import get_run_options

router = APIRouter()

INPUT_KINDS = {"pause", "resume", "steer", "answer"}


@router.get("/runs/{id}")
def get_run(id: str, db: RunoffDb = Depends(get_db)):
    payload = get_run_payload(db, id)
    if payload is None:
        return err(404, "run not found")
    return payload


@router.post("/runs")
async def create_run(request: Request, db: RunoffDb = Depends(get_db)):
    try:
        body = await request.json()
    except Exception:
        return err(400, "invalid JSON body")
    if not isinstance(body, dict):
        body = {}

    blueprint_id = body["blueprintId"] if isinstance(body.get("blueprintId"), str) else ""
    period = body["period"] if isinstance(body.get("period"), str) else None

    bp = db.execute(
        "SELECT current_rev AS currentRev FROM blueprints WHERE id = ?", (blueprint_id,)
    ).fetchone()
    if bp is None:
        return err(404, "blueprint not found")

    # A periodic blueprint must run a filed period; a constants-only one must not
    # carry a period. get_run_options returns non-null here (blueprint exists).
    options = get_run_options(db, blueprint_id)
    valid = (
        (period is None)
        if options["granularity"] is None
        else (period is not None and any(p["period"] == period for p in options["periods"]))
    )
    if not valid:
        return err(400, "period not available for this blueprint")

    id = new_id("run")
    db.execute(
        "INSERT INTO runs (id, blueprint_id, blueprint_rev, status, period) VALUES (?, ?, ?, 'queued', ?)",
        (id, blueprint_id, bp["currentRev"], period),
    )
    return {"id": id}


@router.post("/runs/{id}/inputs")
async def post_run_input(id: str, request: Request, db: RunoffDb = Depends(get_db)):
    try:
        body = await request.json()
    except Exception:
        return err(400, "invalid JSON body")
    if not isinstance(body, dict):
        body = {}

    kind = body.get("kind")
    if not isinstance(kind, str) or kind not in INPUT_KINDS:
        return err(400, "kind must be one of pause|resume|steer|answer")

    if db.execute("SELECT id FROM runs WHERE id = ?", (id,)).fetchone() is None:
        return err(404, "run not found")

    payload: dict = {}
    if isinstance(body.get("text"), str):
        payload["text"] = body["text"]
    if isinstance(body.get("questionId"), str):
        payload["questionId"] = body["questionId"]

    # Re-answering a question the worker has not yet consumed replaces the pending
    # row — a re-click is a changed (or repeated) answer, never a second one.
    if kind == "answer" and payload.get("questionId"):
        cur = db.execute(
            "UPDATE run_inputs SET payload = ? WHERE run_id = ? AND kind = 'answer' "
            "AND consumed_at IS NULL AND json_extract(payload, '$.questionId') = ?",
            (to_json(payload), id, payload["questionId"]),
        )
        if cur.rowcount > 0:
            return {"ok": True}

    db.execute(
        "INSERT INTO run_inputs (run_id, kind, payload) VALUES (?, ?, ?)",
        (id, kind, to_json(payload)),
    )
    return {"ok": True}
