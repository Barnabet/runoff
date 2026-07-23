import os

from fastapi import APIRouter, Depends, Request

from runoff_api.core.db import RunoffDb
from runoff_api.core.ids import new_id
from runoff_api.core.types.sources import PERIOD_REGEX
from runoff_api.deps import err, get_db
from runoff_api.services.golden_pipeline import rebuild_run_golden_inventory, verify_stored_inventory
from runoff_api.services.goldens import get_golden_row, list_goldens

router = APIRouter()


def _files_dir() -> str:
    return os.environ.get("RUNOFF_FILES_DIR", "data/files")


@router.get("/blueprints/{id}/goldens")
def get_blueprint_goldens(id: str, db: RunoffDb = Depends(get_db)):
    return {"goldens": list_goldens(db, id)}


@router.post("/blueprints/{id}/goldens")
async def create_golden(id: str, request: Request, db: RunoffDb = Depends(get_db)):
    content_type = request.headers.get("content-type") or ""
    # R1 divergence: the TS route implements multipart exemplar upload; the
    # contract tags that variant R3, so this backend declines it.
    if "multipart/form-data" in content_type:
        return err(501, "exemplar upload not yet implemented in this backend (R3)")

    try:
        body = await request.json()
    except Exception:
        return err(400, "invalid JSON body")
    if not isinstance(body, dict):
        body = {}

    kind = body["kind"] if body.get("kind") in ("run", "section") else None
    run_id = body["runId"] if isinstance(body.get("runId"), str) else ""
    section_key = body["sectionKey"] if isinstance(body.get("sectionKey"), str) else None
    if not kind or not run_id:
        return err(400, "kind ('run'|'section') and runId are required")
    if kind == "section" and not section_key:
        return err(400, "sectionKey is required for kind 'section'")

    run = db.execute("SELECT blueprint_id AS blueprintId FROM runs WHERE id = ?", (run_id,)).fetchone()
    if run is None or run["blueprintId"] != id:
        return err(404, "run not found for this blueprint")

    golden_id = new_id("gold")
    note = body["note"] if isinstance(body.get("note"), str) else None
    db.execute(
        "INSERT INTO goldens (id, blueprint_id, kind, run_id, section_key, note) VALUES (?, ?, ?, ?, ?, ?)",
        (golden_id, id, kind, run_id, section_key, note),
    )
    # Copy the run's period onto the golden so resolveGolden needs no join, then
    # build the deterministic §4 inventory from the run document's citations.
    db.execute(
        "UPDATE goldens SET period = (SELECT period FROM runs WHERE id = ?) WHERE id = ?",
        (run_id, golden_id),
    )
    rebuild_run_golden_inventory(db, golden_id)
    return {"id": golden_id}


@router.patch("/goldens/{id}")
async def update_golden(id: str, request: Request, db: RunoffDb = Depends(get_db)):
    try:
        body = await request.json()
    except Exception:
        return err(400, "invalid JSON body")
    # TS destructures `{ period }` straight off the parsed body: a missing key or
    # a non-object body yields `undefined`, which fails the regex test → 400
    # "invalid period: undefined". A non-string value (e.g. 123) coerces in the
    # RegExp.test and also 400s. Mirror both here.
    if not isinstance(body, dict) or "period" not in body:
        return err(400, "invalid period: undefined")
    period = body["period"]
    if period is not None and (
        not isinstance(period, str) or not any(pat.search(period) for pat in PERIOD_REGEX.values())
    ):
        return err(400, f"invalid period: {period}")
    row = db.execute("SELECT kind FROM goldens WHERE id = ?", (id,)).fetchone()
    if row is None:
        return err(404, "golden not found")
    db.execute("UPDATE goldens SET period = ? WHERE id = ?", (period, id))
    if row["kind"] == "exemplar":
        verify_stored_inventory(db, id)
    else:
        rebuild_run_golden_inventory(db, id)
    return {"golden": get_golden_row(db, id)}


@router.delete("/goldens/{id}")
def delete_golden(id: str, db: RunoffDb = Depends(get_db)):
    row = db.execute(
        "SELECT stored_filename AS storedFilename FROM goldens WHERE id = ?", (id,)
    ).fetchone()
    if row is None:
        return err(404, "golden not found")
    db.execute("DELETE FROM goldens WHERE id = ?", (id,))
    if row["storedFilename"]:
        try:
            os.unlink(os.path.join(_files_dir(), row["storedFilename"]))
        except OSError:
            # best-effort: a missing file must not fail the delete
            pass
    return {"ok": True}
