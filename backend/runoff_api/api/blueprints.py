import json
import queue
import threading
import types

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from pydantic import ValidationError

from runoff_api.core.db import RunoffDb
from runoff_api.core.ids import new_id
from runoff_api.core.jsonutil import to_json
from runoff_api.core.types.blueprint import BlueprintContent
from runoff_api.deps import err, get_db
from runoff_api.engine.copilot import copilot_turn
from runoff_api.engine.llm import make_llm_client
from runoff_api.services.golden_binding import boundness_line, render_golden_for_prompt
from runoff_api.services.goldens import list_goldens, resolve_golden, scaffold_digest_for
from runoff_api.services.queries import build_copilot_context, list_blueprints_with_runs
from runoff_api.services.query_row_counts import compute_query_row_counts
from runoff_api.services.run_options import get_run_options
from runoff_api.services.source_manager import list_project_sources

router = APIRouter()


@router.get("/blueprints")
def get_blueprints(request: Request, db: RunoffDb = Depends(get_db)):
    project_id = request.query_params.get("projectId")
    if not project_id:
        return err(400, "projectId is required")
    return {"blueprints": list_blueprints_with_runs(db, project_id)}


@router.get("/blueprints/{id}")
def get_blueprint(id: str, db: RunoffDb = Depends(get_db)):
    blueprint = db.execute(
        """SELECT id, name, client_name AS clientName, cadence_label AS cadenceLabel,
              status, current_rev AS currentRev, created_at AS createdAt,
              project_id AS projectId
       FROM blueprints WHERE id = ?""",
        (id,),
    ).fetchone()
    if blueprint is None:
        return err(404, "blueprint not found")

    project_id = blueprint["projectId"]
    project_row = db.execute(
        "SELECT id, name FROM projects WHERE id = ?", (project_id,)
    ).fetchone()
    project = dict(project_row) if project_row is not None else {"id": project_id, "name": ""}

    rev_row = db.execute(
        "SELECT content FROM blueprint_revisions WHERE blueprint_id = ? AND rev = ?",
        (id, blueprint["currentRev"]),
    ).fetchone()
    content = json.loads(rev_row["content"]) if rev_row is not None else None

    families = list_project_sources(db, project_id)["families"]
    bound_family_ids = [
        r["familyId"]
        for r in db.execute(
            "SELECT family_id AS familyId FROM blueprint_families WHERE blueprint_id = ?", (id,)
        ).fetchall()
    ]

    query_row_counts = compute_query_row_counts(db, project_id, content) if content else {}

    return {
        "blueprint": dict(blueprint),
        "content": content,
        "project": project,
        "families": families,
        "boundFamilyIds": bound_family_ids,
        "queryRowCounts": query_row_counts,
    }


@router.get("/blueprints/{id}/run-options")
def get_blueprint_run_options(id: str, db: RunoffDb = Depends(get_db)):
    options = get_run_options(db, id)
    if options is None:
        return err(404, "blueprint not found")
    return options


@router.get("/blueprints/{id}/memories")
def get_blueprint_memories(id: str, db: RunoffDb = Depends(get_db)):
    # Both scopes: this blueprint's own rows plus the project-scoped rows of its
    # project, so the builder drawer can badge each memory's scope.
    rows = db.execute(
        """SELECT id, scope, project_id AS projectId, blueprint_id AS blueprintId, body, source,
              origin_id AS originId, status, created_at AS createdAt
       FROM memories
       WHERE blueprint_id = ?
          OR (scope='project' AND project_id = (SELECT project_id FROM blueprints WHERE id = ?))
       ORDER BY rowid DESC""",
        (id, id),
    ).fetchall()
    return {"memories": [dict(r) for r in rows]}


SELECT_MSG = "SELECT id, role, body, actions, status, created_at AS createdAt FROM copilot_messages"


@router.get("/blueprints/{id}/copilot")
def get_blueprint_copilot(id: str, db: RunoffDb = Depends(get_db)):
    rows = db.execute(f"{SELECT_MSG} WHERE blueprint_id = ? ORDER BY rowid", (id,)).fetchall()
    messages = []
    for r in rows:
        m = dict(r)
        m["actions"] = json.loads(r["actions"]) if r["actions"] else []
        messages.append(m)
    return {"messages": messages}


@router.post("/blueprints/{id}/copilot")
async def post_blueprint_copilot(id: str, request: Request, db: RunoffDb = Depends(get_db)):
    """One builder-copilot turn, streamed as SSE (docs/api/v1.md §2.13 + §3.2).

    Guards → thread/memory load → user-row insert → golden/scaffold cache
    pre-resolve → context, all on the app connection. The turn itself runs on a
    daemon thread whose ``io.emit`` both enqueues each CopilotEvent and mirrors
    TS's accumulation (text_delta → streamed text; edit/memory_saved → actions);
    it persists the terminal row, enqueues the terminal event, then a ``None``
    sentinel. A sync generator drains the queue into ``data: <json>\\n\\n`` frames.

    DB/thread note: the connection is app-scoped (``request.app.state.db``, opened
    check_same_thread=False) and outlives the response, exactly like the runs
    events SSE generator — so the worker thread and context callbacks reuse it
    rather than opening a second connection.
    """
    try:
        body = await request.json()
    except Exception:
        return err(400, "invalid JSON body")
    if not isinstance(body, dict):
        body = {}

    message = body["message"].strip() if isinstance(body.get("message"), str) else ""
    if not message:
        return err(400, "message is required")

    try:
        parsed = BlueprintContent.model_validate(body.get("draft"))
    except ValidationError:
        return err(400, "invalid draft")
    draft = parsed.model_dump(by_alias=True)

    selected_key = body["selectedKey"] if isinstance(body.get("selectedKey"), str) else None

    # Thread + memories load BEFORE inserting the new user row, so the engine
    # sees the prior conversation without the just-posted message.
    thread = [
        {"role": r["role"], "body": r["body"]}
        for r in db.execute(
            "SELECT role, body FROM copilot_messages WHERE blueprint_id = ? AND status = 'ok' ORDER BY rowid",
            (id,),
        ).fetchall()
    ]
    memories = [
        {"id": r["id"], "body": r["body"], "scope": r["scope"]}
        for r in db.execute(
            """SELECT id, body, scope FROM memories
               WHERE (blueprint_id = ?
                      OR (scope='project'
                          AND project_id = (SELECT project_id FROM blueprints WHERE id = ?)))
                 AND status = 'active'
               ORDER BY rowid""",
            (id, id),
        ).fetchall()
    ]

    db.execute(
        "INSERT INTO copilot_messages (id, blueprint_id, role, body) VALUES (?, ?, 'user', ?)",
        (new_id("cmsg"), id, message),
    )

    # Pre-resolve golden texts + scaffold digests so the engine context stays
    # synchronous. Unresolvable goldens are skipped.
    golden_cache: dict[str, dict] = {}
    scaffold_cache: dict[str, str] = {}
    for g in list_goldens(db, id):
        resolved = resolve_golden(db, g["id"])
        if resolved is None:
            continue
        golden_cache[g["id"]] = {
            "description": f"{resolved['label']} — {boundness_line(resolved['inventory'])}",
            "text": render_golden_for_prompt(resolved),
        }
        scaffold_cache[g["id"]] = scaffold_digest_for(resolved)
    context = build_copilot_context(db, id, golden_cache, scaffold_cache)

    q: queue.Queue = queue.Queue()
    msg_id = new_id("cmsg")

    def run_turn() -> None:
        streamed_text = ""
        streamed_actions: list[dict] = []

        def emit(e: dict) -> None:
            nonlocal streamed_text
            if e["type"] == "text_delta":
                streamed_text += e["text"]
            elif e["type"] == "edit":
                streamed_actions.append({"kind": "edit", "op": e["op"]})
            elif e["type"] == "memory_saved":
                streamed_actions.append({"kind": "memory", "memoryId": e["memoryId"], "body": e["body"]})
            q.put(e)

        io = types.SimpleNamespace(emit=emit)
        try:
            result = copilot_turn(
                client=make_llm_client(),
                draft=draft,
                selected_key=selected_key,
                message=message,
                thread=thread,
                memories=memories,
                ctx=context,
                io=io,
            )
            db.execute(
                "INSERT INTO copilot_messages (id, blueprint_id, role, body, actions) "
                "VALUES (?, ?, 'assistant', ?, ?)",
                (msg_id, id, result["reply"], to_json(result["actions"])),
            )
            q.put({"type": "done", "messageId": msg_id})
        except Exception as exc:  # noqa: BLE001 — surfaced as the terminal error event
            db.execute(
                "INSERT INTO copilot_messages (id, blueprint_id, role, body, actions, status) "
                "VALUES (?, ?, 'assistant', ?, ?, 'failed')",
                (msg_id, id, streamed_text, to_json(streamed_actions)),
            )
            q.put({"type": "error", "message": str(exc)})
        finally:
            q.put(None)

    def generate():
        while (e := q.get()) is not None:
            yield f"data: {to_json(e)}\n\n"

    threading.Thread(target=run_turn, daemon=True).start()
    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


# --- writes -----------------------------------------------------------------

# Columns updatable by PATCH /blueprints/{id}: body key → DB column.
_PATCH_COLUMNS = {
    "name": "name",
    "clientName": "client_name",
    "cadenceLabel": "cadence_label",
    "status": "status",
}


@router.post("/blueprints")
async def create_blueprint(request: Request, db: RunoffDb = Depends(get_db)):
    try:
        body = await request.json()
    except Exception:
        return err(400, "invalid JSON body")
    if not isinstance(body, dict):
        body = {}

    name = body["name"].strip() if isinstance(body.get("name"), str) else ""
    if not name:
        return err(400, "name is required")
    client_name = body["clientName"] if isinstance(body.get("clientName"), str) else ""

    project_id = body["projectId"] if isinstance(body.get("projectId"), str) else ""
    if not project_id:
        return err(400, "projectId is required")
    project = db.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone()
    if project is None:
        return err(400, "unknown projectId")

    id = new_id("bp")
    content = {
        "title": name,
        "clientName": client_name,
        "eyebrow": "",
        "dateline": "",
        "sections": [],
        "globalRules": [],
        "delivery": {"recipient": "", "autoDeliverOnClear": False},
    }

    try:
        db.execute("BEGIN")
        db.execute(
            "INSERT INTO blueprints (id, name, client_name, project_id, current_rev) VALUES (?, ?, ?, ?, 1)",
            (id, name, client_name, project_id),
        )
        db.execute(
            "INSERT INTO blueprint_revisions (id, blueprint_id, rev, content) VALUES (?, ?, 1, ?)",
            (new_id("rev"), id, to_json(content)),
        )
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise

    return {"id": id}


@router.patch("/blueprints/{id}")
async def update_blueprint(id: str, request: Request, db: RunoffDb = Depends(get_db)):
    bp = db.execute(
        "SELECT project_id AS projectId FROM blueprints WHERE id = ?", (id,)
    ).fetchone()
    if bp is None:
        return err(404, "blueprint not found")

    try:
        body = await request.json()
    except Exception:
        return err(400, "invalid JSON body")
    if not isinstance(body, dict):
        body = {}

    # Validate the family set BEFORE the write transaction: every id must exist
    # and belong to this blueprint's project, and the periodic granularities must
    # agree. Bad requests get a 400 with the rows left untouched.
    family_ids: list[str] | None = None
    if isinstance(body.get("familyIds"), list):
        family_ids = [f for f in body["familyIds"] if isinstance(f, str)]
        granularities: set[str] = set()
        for fam_id in family_ids:
            fam = db.execute(
                "SELECT kind, granularity, project_id AS projectId FROM source_families WHERE id = ?",
                (fam_id,),
            ).fetchone()
            if fam is None or fam["projectId"] != bp["projectId"]:
                return err(400, "unknown family for this project")
            if fam["kind"] == "periodic" and fam["granularity"]:
                granularities.add(fam["granularity"])
        if len(granularities) > 1:
            return err(400, "granularity differs among bound periodic families")

    try:
        db.execute("BEGIN")
        sets: list[str] = []
        values: list[object] = []
        for key, column in _PATCH_COLUMNS.items():
            if isinstance(body.get(key), str):
                sets.append(f"{column} = ?")
                values.append(body[key])
        if sets:
            db.execute(
                f"UPDATE blueprints SET {', '.join(sets)} WHERE id = ?", (*values, id)
            )
        if family_ids is not None:
            db.execute("DELETE FROM blueprint_families WHERE blueprint_id = ?", (id,))
            for fam_id in family_ids:
                db.execute(
                    "INSERT OR IGNORE INTO blueprint_families (blueprint_id, family_id) VALUES (?, ?)",
                    (id, fam_id),
                )
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise

    return {"ok": True}


@router.post("/blueprints/{id}/revisions")
async def create_revision(id: str, request: Request, db: RunoffDb = Depends(get_db)):
    exists = db.execute("SELECT id FROM blueprints WHERE id = ?", (id,)).fetchone()
    if exists is None:
        return err(404, "blueprint not found")

    try:
        body = await request.json()
    except Exception:
        return err(400, "invalid JSON body")

    content = body.get("content") if isinstance(body, dict) else None
    try:
        parsed = BlueprintContent.model_validate(content)
    except ValidationError as e:
        return err_with_issues("invalid blueprint content", e)

    # Read currentRev and write the bump in one immediate (write-locked) transaction
    # so concurrent saves cannot compute the same rev and collide on the UNIQUE index.
    try:
        db.execute("BEGIN IMMEDIATE")
        cur = db.execute(
            "SELECT current_rev AS currentRev FROM blueprints WHERE id = ?", (id,)
        ).fetchone()
        rev = cur["currentRev"] + 1
        db.execute(
            "INSERT INTO blueprint_revisions (id, blueprint_id, rev, content) VALUES (?, ?, ?, ?)",
            (new_id("rev"), id, rev, to_json(parsed.model_dump(by_alias=True, exclude_unset=True))),
        )
        db.execute("UPDATE blueprints SET current_rev = ? WHERE id = ?", (rev, id))
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise

    return {"rev": rev}


def err_with_issues(message: str, e: ValidationError):
    from fastapi.responses import JSONResponse

    issues = [
        {"loc": list(err_item.get("loc", ())), "msg": err_item.get("msg"), "type": err_item.get("type")}
        for err_item in e.errors()
    ]
    return JSONResponse({"error": message, "issues": issues}, status_code=400)
