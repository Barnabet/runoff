import os
import re

from fastapi import APIRouter, Depends, Request

from runoff_api.core.db import RunoffDb
from runoff_api.core.ids import new_id
from runoff_api.core.types.sources import PERIOD_REGEX
from runoff_api.deps import err, get_db
from runoff_api.services.golden_pipeline import (
    bind_exemplar,
    rebuild_run_golden_inventory,
    unify_and_bind_exemplar,
    verify_stored_inventory,
)
from runoff_api.services.goldens import get_golden_row, list_goldens

router = APIRouter()

# Extension → mime fallback for exemplar uploads whose part is typeless (mirrors
# the TS EXT_MIME map in apps/web/app/api/blueprints/[id]/goldens/route.ts).
EXT_MIME = {
    ".pdf": "application/pdf",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


def _files_dir() -> str:
    return os.environ.get("RUNOFF_FILES_DIR", "data/files")


def _sanitize_name(name: str) -> str:
    """basename + [^a-zA-Z0-9._-] → _, empty → "file" (mirrors the TS sanitizeName)."""
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", os.path.basename(name))
    return safe or "file"


@router.get("/blueprints/{id}/goldens")
def get_blueprint_goldens(id: str, db: RunoffDb = Depends(get_db)):
    return {"goldens": list_goldens(db, id)}


@router.post("/blueprints/{id}/goldens")
async def create_golden(id: str, request: Request, db: RunoffDb = Depends(get_db)):
    content_type = request.headers.get("content-type") or ""
    # Multipart variant (§2.14 R3): store an uploaded exemplar file, then run the
    # LLM unify+bind pipeline synchronously before responding.
    if "multipart/form-data" in content_type:
        form = await request.form()
        file = form.get("file")
        if not (hasattr(file, "filename") and hasattr(file, "read")):
            return err(400, "file is required")
        name_field = form.get("name")
        name = name_field.strip() if isinstance(name_field, str) and name_field.strip() else file.filename
        note_field = form.get("note")
        note = note_field.strip() if isinstance(note_field, str) and note_field.strip() else None

        golden_id = new_id("gold")
        safe = _sanitize_name(file.filename)
        stored_filename = f"{golden_id}_{safe}"
        # A typeless multipart part defaults to application/octet-stream; treat that
        # as "unknown" and prefer an extension-derived mime when we can.
        declared = (
            file.content_type
            if file.content_type and file.content_type != "application/octet-stream"
            else ""
        )
        mime = declared or EXT_MIME.get(os.path.splitext(safe)[1].lower()) or "application/octet-stream"
        dir_ = _files_dir()
        os.makedirs(dir_, exist_ok=True)
        with open(os.path.join(dir_, stored_filename), "wb") as fh:
            fh.write(await file.read())
        db.execute(
            "INSERT INTO goldens (id, blueprint_id, kind, name, mime, stored_filename, note) "
            "VALUES (?, ?, 'exemplar', ?, ?, ?, ?)",
            (golden_id, id, name, mime, stored_filename, note),
        )
        # Synchronous before responding; errors persist to unify_error, never raise.
        unify_and_bind_exemplar(db, golden_id)
        return {"id": golden_id}

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
    # fullmatch, not search: JS non-multiline `$` rejects a trailing "\n" but
    # Python's `$` accepts it, so `.search` would let "2026-Q1\n" pass where the
    # TS `PERIOD_REGEX[...].test(...)` rejects it (same fix R2 applied in classify).
    if period is not None and (
        not isinstance(period, str) or not any(pat.fullmatch(period) for pat in PERIOD_REGEX.values())
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


# POST /blueprints/:id/goldens/:goldenId/unify — re-run unify on an exemplar
# golden (auto-binds on success). §2.15.
@router.post("/blueprints/{id}/goldens/{goldenId}/unify")
def unify_golden(id: str, goldenId: str, db: RunoffDb = Depends(get_db)):
    row = db.execute("SELECT blueprint_id AS b, kind FROM goldens WHERE id = ?", (goldenId,)).fetchone()
    if row is None or row["b"] != id:
        return err(404, "golden not found")
    if row["kind"] != "exemplar":
        return err(400, "only exemplar goldens can be unified")
    unify_and_bind_exemplar(db, goldenId)
    return {"golden": get_golden_row(db, goldenId)}


# POST /blueprints/:id/goldens/:goldenId/bind — bind an exemplar golden (optional
# `feedback` steers the agent) or rebuild a run/section golden's inventory. §2.16.
@router.post("/blueprints/{id}/goldens/{goldenId}/bind")
async def bind_golden(id: str, goldenId: str, request: Request, db: RunoffDb = Depends(get_db)):
    row = db.execute(
        "SELECT blueprint_id AS b, kind, document, bindings FROM goldens WHERE id = ?", (goldenId,)
    ).fetchone()
    if row is None or row["b"] != id:
        return err(404, "golden not found")
    # A malformed/absent body is swallowed to no feedback; empty string → None.
    feedback = None
    try:
        body = await request.json()
        if isinstance(body, dict):
            feedback = body.get("feedback") or None
    except Exception:  # noqa: BLE001 — parse failure → no feedback (mirrors the TS catch)
        feedback = None

    if row["kind"] != "exemplar":
        if feedback:
            return err(400, "feedback requires an exemplar golden")
        rebuild_run_golden_inventory(db, goldenId)
    elif not row["document"]:
        return err(400, "golden is not unified")
    elif row["bindings"] and not feedback:
        verify_stored_inventory(db, goldenId)
    else:
        r = bind_exemplar(db, goldenId, feedback=feedback)
        if not r["ok"]:
            return err(500, r["error"])
    return {"golden": get_golden_row(db, goldenId)}
