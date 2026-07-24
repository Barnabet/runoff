"""R2 source-ingestion routes — statement-for-statement ports of the TS handlers
under apps/web/app/api/projects/[id]/sources/**.

Six handlers: multipart upload (POST /sources), refile (PATCH), delete (DELETE),
classify (POST /sources/classify, LLM), confirm (POST /sources/confirm), and
replan (POST /sources/:sourceId/replan, LLM). The GET /sources read landed in
R1 (api/projects.py). The LLM client is constructed per-request via
make_llm_client() at the same point the TS route calls getLlmClient().
"""

import json
import os
import re

from fastapi import APIRouter, Depends, Request

from runoff_api.core.db import RunoffDb
from runoff_api.core.ids import new_id
from runoff_api.core.jsonutil import to_json
from runoff_api.core.types.parse_plan import ParsePlan, plan_table_name
from runoff_api.core.warehouse import (
    attach_warehouse,
    compute_drift,
    delete_rows,
    detach_warehouse,
    read_warehouse_tables,
    wh_family_tables,
)
from runoff_api.deps import err, get_db
from runoff_api.engine.classify import classify_source
from runoff_api.engine.llm import make_llm_client
from runoff_api.engine.tabular import is_tabular, scan_sample, scan_tabular
from runoff_api.services.plan_propose import plan_for_upload
from runoff_api.services.source_manager import (
    file_source,
    read_content_sample,
    table_names_for,
    with_ingest_lock,
)

router = APIRouter()

EXT_MIME = {
    ".pdf": "application/pdf",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}

MAX_UPLOAD_BYTES = 100 * 1024 * 1024


def _files_dir() -> str:
    return os.environ.get("RUNOFF_FILES_DIR", "data/files")


def _sanitize_name(name: str) -> str:
    """Strip path components and reduce to a filesystem-safe basename."""
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", os.path.basename(name))
    return safe or "file"


def _parse_stored_plan(raw: dict) -> dict:
    """ParsePlanSchema.parse for the plain-dict runtime (zod's onPeriodMismatch default)."""
    plan = ParsePlan.model_validate(raw).model_dump(by_alias=True, exclude_unset=True)
    for t in plan["tables"]:
        t.setdefault("onPeriodMismatch", "keep")
    return plan


# POST /projects/:id/sources — multipart upload of one or more files under the
# `files` key. Each becomes an `unfiled` source row; bytes land under
# RUNOFF_FILES_DIR/<id>_<sanitized-origname>.
@router.post("/projects/{id}/sources")
async def upload_sources(id: str, request: Request, db: RunoffDb = Depends(get_db)):
    project = db.execute("SELECT id FROM projects WHERE id = ?", (id,)).fetchone()
    if project is None:
        return err(404, "project not found")

    # TS `req.formData()` throws on a JSON content-type; Starlette's form() instead
    # returns an empty form, so guard on the content-type first (urlencoded is a
    # valid form body in both stacks), then still catch a malformed multipart body.
    content_type = request.headers.get("content-type") or ""
    if not (
        "multipart/form-data" in content_type
        or "application/x-www-form-urlencoded" in content_type
    ):
        return err(400, "expected multipart form data")
    try:
        form = await request.form()
    except Exception:  # noqa: BLE001 — malformed multipart body (mirrors the TS `catch`)
        return err(400, "expected multipart form data")

    files = [f for f in form.getlist("files") if hasattr(f, "filename") and hasattr(f, "read")]
    if len(files) == 0:
        return err(400, "files are required")

    # Validate every file's size before any byte is written or row inserted.
    for file in files:
        if (file.size or 0) > MAX_UPLOAD_BYTES:
            return err(413, "file exceeds 100MB limit")

    # Read bytes up front (before taking the lock), then serialize the write
    # phase (mkdir + per-file write + INSERT loop) on the shared ingest lock so it
    # can't interleave into an in-flight ingest's transaction gap.
    buffers = [(file, await file.read()) for file in files]

    def write_phase() -> list[dict]:
        dir_ = _files_dir()
        os.makedirs(dir_, exist_ok=True)
        rows: list[dict] = []
        for file, buf in buffers:
            source_id = new_id("src")
            safe = _sanitize_name(file.filename)
            stored_filename = f"{source_id}_{safe}"
            # Multipart defaults a typeless part to application/octet-stream; treat
            # that as "unknown" and prefer an extension-derived mime when we can.
            declared = (
                file.content_type
                if file.content_type and file.content_type != "application/octet-stream"
                else ""
            )
            mime = declared or EXT_MIME.get(os.path.splitext(safe)[1].lower()) or "application/octet-stream"
            with open(os.path.join(dir_, stored_filename), "wb") as fh:
                fh.write(buf)
            db.execute(
                "INSERT INTO sources (id, project_id, name, kind, stored_filename, mime, size, status) "
                "VALUES (?, ?, ?, 'file', ?, ?, ?, 'unfiled')",
                (source_id, id, file.filename, stored_filename, mime, len(buf)),
            )
            rows.append(
                {
                    "id": source_id,
                    "name": file.filename,
                    "storedFilename": stored_filename,
                    "mime": mime,
                    "size": len(buf),
                    "status": "unfiled",
                }
            )
        return rows

    inserted = with_ingest_lock(write_phase)
    return {"sources": inserted}


# PATCH /projects/:id/sources/:sourceId — refile a source into a (possibly new)
# family slot. Same body + rules as confirm.
@router.patch("/projects/{id}/sources/{sourceId}")
async def refile_source(id: str, sourceId: str, request: Request, db: RunoffDb = Depends(get_db)):
    try:
        body = await request.json()
    except Exception:
        return err(400, "invalid JSON body")
    if not isinstance(body, dict):
        body = {}

    result = file_source(
        db,
        {
            "projectId": id,
            "sourceId": sourceId,
            "familyId": body.get("familyId"),
            "newFamily": body.get("newFamily"),
            "period": body.get("period"),
        },
    )
    if "error" in result:
        return err(result["status"], result["error"])
    return {"ok": True}


# DELETE /projects/:id/sources/:sourceId — remove an unfiled or filed source and
# its stored file. `replaced` rows are kept (400) to preserve provenance.
@router.delete("/projects/{id}/sources/{sourceId}")
def delete_source(id: str, sourceId: str, db: RunoffDb = Depends(get_db)):
    row = db.execute(
        "SELECT status, family_id AS familyId, period, stored_filename AS storedFilename "
        "FROM sources WHERE id = ? AND project_id = ?",
        (sourceId, id),
    ).fetchone()
    if row is None:
        return err(404, "source not found")
    if row["status"] == "replaced":
        return err(400, "replaced sources cannot be deleted")

    # The mutation (row removal + warehouse cleanup + stored-file unlink)
    # serializes on the shared ingest lock. The SELECT/validation above stays
    # outside. Row removal precedes warehouse cleanup — worst case on crash is
    # orphan warehouse rows, which the next re-file of the slot clears.
    def run() -> None:
        db.execute("DELETE FROM sources WHERE id = ?", (sourceId,))

        if row["status"] == "filed" and row["familyId"]:
            fam = db.execute(
                "SELECT key, kind FROM source_families WHERE id = ?", (row["familyId"],)
            ).fetchone()
            if fam:
                attach_warehouse(db, id)
                try:
                    tables = [t["name"] for t in wh_family_tables(db, fam["key"])]
                    delete_rows(db, tables, row["period"] if fam["kind"] == "periodic" else None)
                finally:
                    detach_warehouse(db)

        try:
            os.remove(os.path.join(_files_dir(), row["storedFilename"]))
        except OSError:
            # Stored file may already be gone; the row removal is what matters.
            pass

    with_ingest_lock(run)
    return {"ok": True}


# POST /projects/:id/sources/classify — body { sourceIds: string[] }. For each
# still-unfiled row in this project, sample its content and ask the engine where
# it belongs; persist the proposal (or leave NULL). Returns the updated rows.
@router.post("/projects/{id}/sources/classify")
async def classify_sources(id: str, request: Request, db: RunoffDb = Depends(get_db)):
    project = db.execute("SELECT id FROM projects WHERE id = ?", (id,)).fetchone()
    if project is None:
        return err(404, "project not found")

    try:
        body = await request.json()
    except Exception:
        return err(400, "invalid JSON body")
    if not isinstance(body, dict):
        body = {}
    raw_ids = body.get("sourceIds")
    source_ids = [s for s in raw_ids if isinstance(s, str)] if isinstance(raw_ids, list) else []

    families = [
        dict(r)
        for r in db.execute(
            "SELECT key, label, kind, granularity FROM source_families WHERE project_id = ?", (id,)
        ).fetchall()
    ]

    client = make_llm_client()
    dir_ = _files_dir()
    updated: list[dict] = []

    for source_id in source_ids:
        row = db.execute(
            "SELECT id, name, mime, stored_filename AS storedFilename FROM sources "
            "WHERE id = ? AND project_id = ? AND status = 'unfiled'",
            (source_id, id),
        ).fetchone()
        if row is None:
            continue
        row = dict(row)

        # A file that fails to parse must not sink the rest of the batch: treat it
        # like classify_source's own null-on-failure contract (no proposal).
        proposal: dict | None = None
        scan: dict | None = None
        try:
            path = os.path.join(dir_, row["storedFilename"])
            if is_tabular(row["mime"], row["name"]):
                try:
                    scan = scan_tabular(path, row["mime"], row["name"])
                    content_sample = scan_sample(scan)
                except Exception:  # noqa: BLE001 — corrupt tabular file: classify from raw text
                    # build_source_pack skips csv/xlsx, so a genuine tabular mime
                    # yields an empty sample — fall back to raw file bytes so the
                    # classifier sees more than a bare filename.
                    content_sample = read_content_sample(dir_, row)
                    if not content_sample:
                        with open(path, "rb") as fh:
                            content_sample = fh.read().decode("utf-8", "replace")[:2000]
            else:
                content_sample = read_content_sample(dir_, row)
            proposal = classify_source(
                client=client, filename=row["name"], content_sample=content_sample, families=families
            )
            if proposal and scan:
                nf = proposal.get("newFamily")
                key = (nf.get("key") if nf else None) or proposal.get("familyKey")
                # Propose (or reuse) a parse plan. A plan problem must never break
                # classification: on any failure the outcome is "none" and the
                # proposal stays plan-less.
                outcome: dict = {"planStatus": "none"}
                try:
                    fam_row = db.execute(
                        "SELECT id, kind, granularity, parse_plan AS parsePlan "
                        "FROM source_families WHERE project_id = ? AND key = ?",
                        (id, key),
                    ).fetchone()
                    stored_plan = (
                        _parse_stored_plan(json.loads(fam_row["parsePlan"]))
                        if fam_row and fam_row["parsePlan"]
                        else None
                    )
                    outcome = plan_for_upload(
                        client=client,
                        filename=row["name"],
                        path=path,
                        mime=row["mime"],
                        scan=scan,
                        stored_plan=stored_plan,
                        slot_period=proposal.get("period"),
                        granularity=(fam_row["granularity"] if fam_row else None)
                        or (nf.get("granularity") if nf else None),
                    )
                except Exception:  # noqa: BLE001 — plan failure keeps the plan-less proposal
                    pass
                # Enrichment: plan output schemas when a plan landed, else
                # scan-based. Enrichment failure keeps the un-enriched proposal.
                try:
                    if outcome["planStatus"] != "none":
                        plan = outcome["plan"]
                        incoming = [
                            {"name": plan_table_name(key, plan, s["name"]), "columns": s["columns"]}
                            for s in outcome["outputSchemas"]
                        ]
                        tables = [
                            {
                                "name": plan_table_name(key, plan, s["name"]),
                                "columns": [c["name"] for c in s["columns"]],
                                "rowCount": outcome["report"]["tables"][i]["rowsKept"],
                            }
                            for i, s in enumerate(outcome["outputSchemas"])
                        ]
                    else:
                        names = table_names_for(key, [t["slug"] for t in scan["tables"]])
                        incoming = [
                            {"name": names[t["slug"]], "columns": t["columns"]} for t in scan["tables"]
                        ]
                        tables = [
                            {
                                "name": names[t["slug"]],
                                "columns": [c["name"] for c in t["columns"]],
                                "rowCount": t["rowCount"],
                            }
                            for t in scan["tables"]
                        ]
                    existing = [
                        {"name": t["name"], "columns": t["columns"]}
                        for t in read_warehouse_tables(id, key)
                    ]
                    proposal = {
                        **proposal,
                        "tables": tables,
                        "skippedFragments": len(scan["skipped"]),
                        "drift": compute_drift(existing, incoming),
                    }
                    if outcome["planStatus"] != "none":
                        proposal = {
                            **proposal,
                            "plan": outcome["plan"],
                            "planStatus": outcome["planStatus"],
                            "preview": outcome["preview"],
                            "report": outcome["report"],
                        }
                except Exception:  # noqa: BLE001 — enrichment failure keeps the un-enriched proposal
                    pass
        except Exception:  # noqa: BLE001 — mirrors the TS outer catch-all
            proposal = None
        db.execute(
            "UPDATE sources SET proposal = ? WHERE id = ?",
            (to_json(proposal) if proposal else None, row["id"]),
        )
        updated.append({"id": row["id"], "proposal": proposal if proposal else None})

    return {"sources": updated}


# POST /projects/:id/sources/confirm — file an unfiled source into a family slot
# (creating the family when `newFamily` is given). Delegates slot rules to
# fileSource.
@router.post("/projects/{id}/sources/confirm")
async def confirm_source(id: str, request: Request, db: RunoffDb = Depends(get_db)):
    try:
        body = await request.json()
    except Exception:
        return err(400, "invalid JSON body")
    if not isinstance(body, dict):
        body = {}
    if not isinstance(body.get("sourceId"), str):
        return err(400, "sourceId is required")
    # Guard the period-mismatch override: only "keep"/"exclude" may reach the plan.
    # Gate on presence (TS `!== undefined`), so an explicit JSON `null` still 400s.
    period_mismatch = body.get("periodMismatch")
    if "periodMismatch" in body and period_mismatch != "keep" and period_mismatch != "exclude":
        return err(400, 'periodMismatch must be "keep" or "exclude"')

    result = file_source(
        db,
        {
            "projectId": id,
            "sourceId": body["sourceId"],
            "familyId": body.get("familyId"),
            "newFamily": body.get("newFamily"),
            "period": body.get("period"),
            "periodMismatch": period_mismatch,
        },
    )
    if "error" in result:
        return err(result["status"], result["error"])
    return {"ok": True}


# POST /projects/:id/sources/:sourceId/replan — body { feedback }. Revises the
# current plan proposal with user feedback; the prior proposal is only replaced
# on success.
@router.post("/projects/{id}/sources/{sourceId}/replan")
async def replan_source(id: str, sourceId: str, request: Request, db: RunoffDb = Depends(get_db)):
    try:
        body = await request.json()
    except Exception:
        return err(400, "invalid JSON body")
    if not isinstance(body, dict):
        body = {}
    feedback = body.get("feedback")
    if not isinstance(feedback, str) or not feedback.strip():
        return err(400, "feedback is required")

    row = db.execute(
        "SELECT id, name, mime, stored_filename AS storedFilename, proposal FROM sources "
        "WHERE id = ? AND project_id = ? AND status = 'unfiled'",
        (sourceId, id),
    ).fetchone()
    if row is None:
        return err(404, "source not found")
    row = dict(row)
    proposal = json.loads(row["proposal"]) if row["proposal"] else None
    if not proposal or not is_tabular(row["mime"], row["name"]):
        return err(400, "source has no plan proposal")

    try:
        path = os.path.join(_files_dir(), row["storedFilename"])
        scan = scan_tabular(path, row["mime"], row["name"])
        nf = proposal.get("newFamily")
        key = (nf.get("key") if nf else None) or proposal.get("familyKey")
        fam_row = db.execute(
            "SELECT granularity FROM source_families WHERE project_id = ? AND key = ?", (id, key)
        ).fetchone()
        outcome = plan_for_upload(
            client=make_llm_client(),
            filename=row["name"],
            path=path,
            mime=row["mime"],
            scan=scan,
            stored_plan=_parse_stored_plan(proposal["plan"]) if proposal.get("plan") else None,
            slot_period=proposal.get("period"),
            granularity=(fam_row["granularity"] if fam_row else None)
            or (nf.get("granularity") if nf else None),
            feedback=feedback,
        )
        if outcome["planStatus"] == "none":
            return err(500, "replan failed: no plan produced")
        updated = {
            **proposal,
            "plan": outcome["plan"],
            "planStatus": outcome["planStatus"],
            "preview": outcome["preview"],
            "report": outcome["report"],
        }
        db.execute("UPDATE sources SET proposal = ? WHERE id = ?", (to_json(updated), row["id"]))
        return {"proposal": updated}
    except Exception as e:  # noqa: BLE001 — mirrors the TS catch-all
        return err(500, f"replan failed: {e}")
