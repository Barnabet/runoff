"""Port of apps/worker/src/runLoop.ts — the claim loop, engine IO, and
post-run distillation. TS wins on every statement.

Runtime shapes are plain camelCase-keyed dicts; execution is synchronous.
`make_engine_io` returns an object satisfying the engine's duck-typed `io`
protocol (`emit`/`poll_inputs`/`sleep`).
"""

import json
import sys
import time
from types import SimpleNamespace

from runoff_api.core.db import RunoffDb
from runoff_api.core.ids import new_id
from runoff_api.core.jsonutil import to_json
from runoff_api.core.previous_run import previous_completed_document
from runoff_api.core.types.blueprint import BlueprintContent
from runoff_api.engine.distill import distill_run
from runoff_api.engine.run import execute_run
from runoff_api.worker.resolve_sources import resolve_run_sources
from runoff_api.worker.run_data import build_run_data

# Atomically claim the oldest queued run (single statement; RETURNING gives us
# its identity). Byte-copied from CLAIM_SQL in runLoop.ts, aliases included.
CLAIM_SQL = """
UPDATE runs SET status='running', started_at=datetime('now')
WHERE id = (SELECT id FROM runs WHERE status='queued' ORDER BY created_at LIMIT 1)
RETURNING id, blueprint_id AS blueprintId, blueprint_rev AS blueprintRev, period"""


def claim_queued_run(db: RunoffDb) -> dict | None:
    row = db.execute(CLAIM_SQL).fetchone()
    return dict(row) if row is not None else None


def make_engine_io(db: RunoffDb, run_id: str):
    """The side-channel the engine drives for a single run. `emit` appends a run
    event (seq = max+1) in one transaction and mirrors run status onto the
    `runs` row (and, for flags, into the `flags` table) so the API can report
    status without replaying events. `poll_inputs` drains pending worker inputs.
    """

    def emit(e: dict) -> None:
        # Immediate mode takes the write lock up front, so the MAX(seq) read and
        # the insert see one snapshot — avoids SQLITE_BUSY_SNAPSHOT when the web
        # app writes concurrently. open_db runs in autocommit (isolation_level=None),
        # so BEGIN IMMEDIATE / COMMIT are issued explicitly to make the txn real.
        db.execute("BEGIN IMMEDIATE")
        try:
            seq = db.execute(
                "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id = ?",
                (run_id,),
            ).fetchone()["seq"]
            db.execute(
                "INSERT INTO run_events (run_id, seq, type, payload) VALUES (?, ?, ?, ?)",
                (run_id, seq, e["type"], to_json(e)),
            )
            t = e["type"]
            if t == "flag_raised":
                # The engine mints per-run flag ids (`flag_1`, …); the `flags`
                # table is globally keyed, so namespace the row id by run to avoid
                # a cross-run primary-key collision. The event payload keeps the
                # bare id; the API reads the row id back.
                db.execute(
                    "INSERT INTO flags (id, run_id, code, section_key, question, options) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        f"{run_id}_{e['flagId']}",
                        run_id,
                        e["code"],
                        e["sectionKey"],
                        e["question"],
                        to_json(e["options"]),
                    ),
                )
            elif t == "paused":
                db.execute("UPDATE runs SET status=? WHERE id = ?", ("paused", run_id))
            elif t == "resumed":
                db.execute("UPDATE runs SET status=? WHERE id = ?", ("running", run_id))
            elif t == "run_completed":
                db.execute(
                    "UPDATE runs SET status='complete', finished_at=datetime('now'), "
                    "stats=?, document=? WHERE id = ?",
                    (to_json(e["stats"]), to_json(e["document"]), run_id),
                )
            elif t == "run_failed":
                db.execute(
                    "UPDATE runs SET status='failed', finished_at=datetime('now') WHERE id = ?",
                    (run_id,),
                )
            db.execute("COMMIT")
        except Exception:
            # Guard on in_transaction: SQLite may have already auto-rolled back
            # (e.g. SQLITE_FULL), and an explicit ROLLBACK then raises "no
            # transaction is active", masking the original error. Mirrors
            # better-sqlite3's .transaction() wrapper, which rolls back only when
            # inTransaction.
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise

    def poll_inputs() -> list[dict]:
        rows = db.execute(
            "SELECT id, kind, payload FROM run_inputs WHERE run_id = ? AND consumed_at IS NULL ORDER BY id",
            (run_id,),
        ).fetchall()
        out: list[dict] = []
        for r in rows:
            db.execute("UPDATE run_inputs SET consumed_at=datetime('now') WHERE id = ?", (r["id"],))
            payload = json.loads(r["payload"])
            out.append(
                {"kind": r["kind"], "text": payload.get("text"), "questionId": payload.get("questionId")}
            )
        return out

    def sleep(ms: float) -> None:
        time.sleep(ms / 1000)

    return SimpleNamespace(emit=emit, poll_inputs=poll_inputs, sleep=sleep)


def fail_stale_runs(db: RunoffDb) -> int:
    """Boot recovery: any run left `running`/`paused` by a crashed worker is
    unrecoverable (the engine's in-memory state is gone), so mark it failed and
    append a `run_failed` event. Returns how many runs were recovered.
    """
    stale = db.execute("SELECT id FROM runs WHERE status IN ('running', 'paused')").fetchall()
    for row in stale:
        make_engine_io(db, row["id"]).emit({"type": "run_failed", "error": "worker restarted mid-run"})
    return len(stale)


def process_one(db: RunoffDb, client) -> bool:
    """Claim and execute one queued run. Loads the pinned blueprint revision
    content and its bound source files, runs the engine (which persists success
    and, on failure, emits `run_failed` before throwing), and guards pre-engine
    throws (e.g. a malformed revision) by marking the run failed itself.
    Returns whether a run was claimed.
    """
    claimed = claim_queued_run(db)
    if not claimed:
        return False

    io = make_engine_io(db, claimed["id"])
    try:
        rev_row = db.execute(
            "SELECT content FROM blueprint_revisions WHERE blueprint_id = ? AND rev = ?",
            (claimed["blueprintId"], claimed["blueprintRev"]),
        ).fetchone()
        if rev_row is None:
            raise RuntimeError(
                f"blueprint revision not found: {claimed['blueprintId']}@{claimed['blueprintRev']}"
            )
        content = BlueprintContent.model_validate(json.loads(rev_row["content"])).model_dump(by_alias=True)

        resolved = resolve_run_sources(db, claimed["blueprintId"], claimed["period"])
        files = resolved["files"]
        gaps = resolved["gaps"]

        project_id = db.execute(
            "SELECT project_id AS projectId FROM blueprints WHERE id = ?", (claimed["blueprintId"],)
        ).fetchone()["projectId"]
        # Deduped, first-seen order (mirrors TS `[...new Set(...)]`).
        bound_family_ids = list(dict.fromkeys(fid for s in content["sections"] for fid in s["familyIds"]))
        data = build_run_data(db, project_id, bound_family_ids, claimed["period"])

        run_row = db.execute(
            "SELECT created_at AS createdAt FROM runs WHERE id = ?", (claimed["id"],)
        ).fetchone()
        previous = previous_completed_document(
            db, claimed["blueprintId"], claimed["id"], run_row["createdAt"]
        )

        memory_rows = db.execute(
            "SELECT id, body, scope FROM memories "
            "WHERE status='active' AND (blueprint_id = ? OR (scope='project' AND project_id = "
            "(SELECT project_id FROM blueprints WHERE id = ?))) "
            "ORDER BY rowid",
            (claimed["blueprintId"], claimed["blueprintId"]),
        ).fetchall()
        memories = [{"id": m["id"], "body": m["body"], "scope": m["scope"]} for m in memory_rows]

        execute_run(
            client=client,
            content=content,
            files=files,
            data=data,
            io=io,
            blueprint_rev=claimed["blueprintRev"],
            previous_document=previous["document"] if previous else None,
            memories=memories,
            period=claimed["period"],
            gaps=gaps,
        )
        # Success is already persisted by the `run_completed` emit handler.
        distill_completed_run(db, client, claimed["id"], claimed["blueprintId"], content)
    except Exception as err:  # noqa: BLE001 — mirrors the TS catch-all
        message = str(err)
        print(f"[worker] run {claimed['id']} failed: {message}", file=sys.stderr)
        # If the engine threw it already emitted `run_failed` (which set status).
        # For pre-engine throws (revision missing / validation) nothing marked it yet.
        row = db.execute("SELECT status FROM runs WHERE id = ?", (claimed["id"],)).fetchone()
        if row is not None and row["status"] != "failed":
            io.emit({"type": "run_failed", "error": message})
    return True


def distill_completed_run(db: RunoffDb, client, run_id: str, blueprint_id: str, content: dict) -> None:
    """Post-run learning: turn this run's human interventions into standing
    memories. Read-side is the run's own event log + resolved flags; any failure
    is logged and swallowed — distillation must never affect run status.
    """
    try:
        events = db.execute(
            "SELECT type, payload FROM run_events WHERE run_id = ? AND "
            "type IN ('steer_received','question_raised','question_answered') ORDER BY seq",
            (run_id,),
        ).fetchall()
        # `question_answered` carries only {questionId, answer}; the question text
        # lives in the preceding `question_raised` event, so map ids -> text first.
        question_text: dict[str, str] = {}
        for e in events:
            if e["type"] != "question_raised":
                continue
            p = json.loads(e["payload"])
            if isinstance(p.get("questionId"), str) and isinstance(p.get("question"), str):
                question_text[p["questionId"]] = p["question"]
        interactions: dict = {"steers": [], "answers": [], "flagResolutions": []}
        for e in events:
            p = json.loads(e["payload"])
            if e["type"] == "steer_received" and isinstance(p.get("text"), str):
                interactions["steers"].append(p["text"])
            if e["type"] == "question_answered" and isinstance(p.get("answer"), str):
                qid = p.get("questionId")
                interactions["answers"].append(
                    {
                        "question": question_text.get(qid, str(qid if qid is not None else "")),
                        "answer": p["answer"],
                    }
                )
        flag_rows = db.execute(
            "SELECT question, resolution FROM flags WHERE run_id = ? AND status = 'resolved' "
            "AND resolution IS NOT NULL",
            (run_id,),
        ).fetchall()
        interactions["flagResolutions"] = [
            {"question": f["question"], "resolution": f["resolution"]} for f in flag_rows
        ]

        if not interactions["steers"] and not interactions["answers"] and not interactions["flagResolutions"]:
            return

        # This blueprint's project, so project-scoped memories land on the right row.
        project_row = db.execute(
            "SELECT project_id AS projectId FROM blueprints WHERE id = ?", (blueprint_id,)
        ).fetchone()
        project_id = (
            project_row["projectId"]
            if project_row is not None and project_row["projectId"] is not None
            else ""
        )

        # Dedup pool spans both scopes (dedup is on lowercased body, scope-agnostic).
        existing = db.execute(
            "SELECT body, scope FROM memories WHERE blueprint_id = ? OR (scope='project' AND project_id = ?)",
            (blueprint_id, project_id),
        ).fetchall()
        existing_list = [{"body": r["body"], "scope": r["scope"]} for r in existing]

        fresh = distill_run(
            client=client,
            title=content["title"],
            section_headings=[s["heading"] for s in content["sections"]],
            interactions=interactions,
            existing=existing_list,
        )

        insert_sql = (
            "INSERT INTO memories (id, scope, project_id, blueprint_id, body, source, origin_id) "
            "VALUES (?, ?, ?, ?, ?, 'distilled', ?)"
        )
        for m in fresh:
            enforce_memory_cap(
                db, {"projectId": project_id} if m["scope"] == "project" else {"blueprintId": blueprint_id}
            )
            db.execute(
                insert_sql,
                (
                    new_id("mem"),
                    m["scope"],
                    project_id,
                    blueprint_id if m["scope"] == "blueprint" else None,
                    m["body"],
                    run_id,
                ),
            )
    except Exception as err:  # noqa: BLE001 — distillation must never affect run status
        print(f"[worker] distillation failed for run {run_id}: {err}", file=sys.stderr)


def enforce_memory_cap(db: RunoffDb, scope: dict) -> None:
    """Cap active memories at 30 within one scope by disabling the oldest active
    row. Project scope keys on `project_id`; blueprint scope on `blueprint_id`.
    """
    if "projectId" in scope:
        clause = "scope='project' AND project_id = ?"
        val = scope["projectId"]
    else:
        clause = "scope='blueprint' AND blueprint_id = ?"
        val = scope["blueprintId"]
    n = db.execute(
        f"SELECT COUNT(*) AS n FROM memories WHERE {clause} AND status='active'", (val,)
    ).fetchone()["n"]
    if n >= 30:
        db.execute(
            f"UPDATE memories SET status='disabled' WHERE id = "
            f"(SELECT id FROM memories WHERE {clause} AND status='active' ORDER BY rowid LIMIT 1)",
            (val,),
        )
