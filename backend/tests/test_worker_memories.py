"""Port of apps/worker/test/memories.test.ts.

The engine seam (execute_run / distill_run) is faked by monkeypatching the
run_loop module's imported names, mirroring the TS `vi.mock("@runoff/engine")`.
Real temp DBs via open_db.
"""

import tempfile
from pathlib import Path

import pytest

import runoff_api.worker.run_loop as run_loop
from runoff_api.core.db import RunoffDb, open_db
from runoff_api.core.jsonutil import to_json
from runoff_api.worker.run_loop import process_one

CONTENT = to_json(
    {
        "title": "T",
        "clientName": "C",
        "eyebrow": "E",
        "dateline": "D",
        "sections": [
            {
                "key": "exec",
                "number": 1,
                "heading": "Executive Summary",
                "mode": "auto",
                "instruction": "",
                "fixedText": "",
                "familyIds": [],
                "queries": [],
                "rules": [],
            }
        ],
        "globalRules": [],
        "delivery": {"recipient": "", "autoDeliverOnClear": False},
    }
)
DOC = {"title": "T", "eyebrow": "E", "dateline": "D", "sections": []}
STATS = {
    "durationMs": 1,
    "words": 1,
    "sourcesUsed": 0,
    "checksPassed": 0,
    "checksFailed": 0,
    "flagCount": 0,
    "citationCount": 0,
    "retries": 0,
}
RUN_ID = "run_cur"


def seed_db() -> RunoffDb:
    d = tempfile.mkdtemp(prefix="runoff-worker-mem-")
    db = open_db(str(Path(d) / "t.db"))
    db.execute("INSERT INTO projects (id, name) VALUES ('proj_1', 'P')")
    db.execute(
        "INSERT INTO blueprints (id, name, client_name, current_rev, project_id) "
        "VALUES ('bp_1', 'B', 'C', 1, 'proj_1')"
    )
    db.execute(
        "INSERT INTO blueprint_revisions (blueprint_id, rev, content) VALUES ('bp_1', 1, ?)", (CONTENT,)
    )
    return db


def queue_run(db: RunoffDb, id: str, created_at: str) -> None:
    db.execute(
        "INSERT INTO runs (id, blueprint_id, blueprint_rev, status, created_at) "
        "VALUES (?, 'bp_1', 1, 'queued', ?)",
        (id, created_at),
    )


def test_passes_active_memories_of_both_scopes_into_execute_run(monkeypatch):
    db = seed_db()
    db.execute(
        "INSERT INTO memories (id, blueprint_id, body, source) "
        "VALUES ('m1','bp_1','Use percentages.','copilot')"
    )
    db.execute(
        "INSERT INTO memories (id, blueprint_id, body, source) VALUES ('m2','bp_1','Be terse.','distilled')"
    )
    db.execute(
        "INSERT INTO memories (id, blueprint_id, body, source, status) "
        "VALUES ('m3','bp_1','Old.','copilot','disabled')"
    )
    # A project-scoped memory (blueprint_id NULL) of this blueprint's project.
    db.execute(
        "INSERT INTO memories (id, scope, project_id, body, source) "
        "VALUES ('mp','project','proj_1','Always use GBP.','copilot')"
    )
    queue_run(db, RUN_ID, "2026-07-18 09:00:00")

    captured = {}

    def fake_execute_run(**opts):
        captured.update(opts)
        return {"document": DOC, "stats": STATS}

    monkeypatch.setattr(run_loop, "execute_run", fake_execute_run)
    monkeypatch.setattr(run_loop, "distill_run", lambda **_: pytest.fail("distiller should not run"))

    process_one(db, object())

    assert captured["memories"] == [
        {"id": "m1", "body": "Use percentages.", "scope": "blueprint"},
        {"id": "m2", "body": "Be terse.", "scope": "blueprint"},
        {"id": "mp", "body": "Always use GBP.", "scope": "project"},
    ]


def test_inserts_distilled_memories_after_interactive_run_and_skips_distiller_for_quiet_run(monkeypatch):
    db = seed_db()
    queue_run(db, RUN_ID, "2026-07-18 09:00:00")

    def interactive_execute(**opts):
        io = opts["io"]
        io.emit({"type": "steer_received", "sectionKey": "exec", "text": "shorter please"})
        io.emit(
            {
                "type": "question_raised",
                "questionId": "q_1",
                "sectionKey": "exec",
                "question": "Which fiscal year?",
                "options": [],
                "fallback": "",
                "deadlineSection": "exec",
            }
        )
        io.emit({"type": "question_answered", "questionId": "q_1", "answer": "FY2025"})
        io.emit({"type": "run_completed", "stats": STATS, "document": DOC})
        return {"document": DOC, "stats": STATS}

    distill_calls = []

    def fake_distill(**opts):
        distill_calls.append(opts)
        return [{"body": "Keep the executive summary short.", "scope": "blueprint"}]

    monkeypatch.setattr(run_loop, "execute_run", interactive_execute)
    monkeypatch.setattr(run_loop, "distill_run", fake_distill)

    process_one(db, object())

    assert len(distill_calls) == 1
    arg = distill_calls[0]
    assert arg["interactions"]["steers"] == ["shorter please"]
    # The distiller must receive the question TEXT, not the opaque questionId.
    assert arg["interactions"]["answers"] == [{"question": "Which fiscal year?", "answer": "FY2025"}]
    rows = db.execute(
        "SELECT scope, project_id AS projectId, blueprint_id AS blueprintId, body, source, "
        "origin_id AS originId, status FROM memories WHERE source='distilled'"
    ).fetchall()
    assert [dict(r) for r in rows] == [
        {
            "scope": "blueprint",
            "projectId": "proj_1",
            "blueprintId": "bp_1",
            "body": "Keep the executive summary short.",
            "source": "distilled",
            "originId": RUN_ID,
            "status": "active",
        }
    ]

    # Quiet run: no steers/answers/resolved flags -> distiller never called.
    distill_calls.clear()
    queue_run(db, "run_2", "2026-07-18 10:00:00")

    def quiet_execute(**opts):
        opts["io"].emit({"type": "run_completed", "stats": STATS, "document": DOC})
        return {"document": DOC, "stats": STATS}

    monkeypatch.setattr(run_loop, "execute_run", quiet_execute)

    process_one(db, object())

    assert distill_calls == []


def test_a_distiller_failure_never_flips_a_completed_run_to_failed(monkeypatch):
    db = seed_db()
    queue_run(db, RUN_ID, "2026-07-18 09:00:00")

    def interactive_execute(**opts):
        io = opts["io"]
        io.emit({"type": "steer_received", "sectionKey": "exec", "text": "shorter please"})
        io.emit({"type": "run_completed", "stats": STATS, "document": DOC})
        return {"document": DOC, "stats": STATS}

    def boom(**_):
        raise RuntimeError("distill boom")

    monkeypatch.setattr(run_loop, "execute_run", interactive_execute)
    monkeypatch.setattr(run_loop, "distill_run", boom)

    process_one(db, object())

    run = db.execute("SELECT status FROM runs WHERE id = ?", (RUN_ID,)).fetchone()
    assert run["status"] == "complete"
    failed = db.execute(
        "SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'run_failed'", (RUN_ID,)
    ).fetchone()
    assert failed["n"] == 0


def test_caps_active_memories_at_30_disabling_the_oldest_active_row(monkeypatch):
    db = seed_db()
    for i in range(30):
        db.execute(
            "INSERT INTO memories (id, blueprint_id, body, source) VALUES (?, 'bp_1', ?, 'distilled')",
            (f"seed_{i}", f"Memory {i}."),
        )

    queue_run(db, RUN_ID, "2026-07-18 09:00:00")

    def interactive_execute(**opts):
        io = opts["io"]
        io.emit({"type": "steer_received", "sectionKey": "exec", "text": "shorter please"})
        io.emit({"type": "run_completed", "stats": STATS, "document": DOC})
        return {"document": DOC, "stats": STATS}

    monkeypatch.setattr(run_loop, "execute_run", interactive_execute)
    monkeypatch.setattr(
        run_loop, "distill_run", lambda **_: [{"body": "A fresh distilled memory.", "scope": "blueprint"}]
    )

    process_one(db, object())

    # The new memory landed.
    fresh = db.execute("SELECT status FROM memories WHERE body = 'A fresh distilled memory.'").fetchone()
    assert fresh is not None and fresh["status"] == "active"

    # The cap holds: still exactly 30 active.
    active = db.execute(
        "SELECT COUNT(*) AS n FROM memories WHERE blueprint_id = 'bp_1' AND status = 'active'"
    ).fetchone()
    assert active["n"] == 30

    # The disabled row is the OLDEST of the original 30 (lowest rowid).
    disabled = db.execute(
        "SELECT id FROM memories WHERE blueprint_id = 'bp_1' AND status = 'disabled'"
    ).fetchall()
    assert [r["id"] for r in disabled] == ["seed_0"]


def test_applies_the_30_cap_independently_per_scope(monkeypatch):
    db = seed_db()
    # 30 active project memories (blueprint_id NULL) …
    for i in range(30):
        db.execute(
            "INSERT INTO memories (id, scope, project_id, body, source) "
            "VALUES (?, 'project', 'proj_1', ?, 'distilled')",
            (f"proj_{i}", f"Project memory {i}."),
        )
    # … plus 5 active blueprint memories that must be left untouched.
    for i in range(5):
        db.execute(
            "INSERT INTO memories (id, blueprint_id, body, source) VALUES (?, 'bp_1', ?, 'distilled')",
            (f"bp_mem_{i}", f"Blueprint memory {i}."),
        )

    queue_run(db, RUN_ID, "2026-07-18 09:00:00")

    def interactive_execute(**opts):
        io = opts["io"]
        io.emit({"type": "steer_received", "sectionKey": "exec", "text": "shorter please"})
        io.emit({"type": "run_completed", "stats": STATS, "document": DOC})
        return {"document": DOC, "stats": STATS}

    monkeypatch.setattr(run_loop, "execute_run", interactive_execute)
    monkeypatch.setattr(
        run_loop, "distill_run", lambda **_: [{"body": "A fresh project memory.", "scope": "project"}]
    )

    process_one(db, object())

    # New project memory landed with blueprint_id NULL.
    fresh = db.execute(
        "SELECT scope, project_id AS projectId, blueprint_id AS blueprintId, status "
        "FROM memories WHERE body = 'A fresh project memory.'"
    ).fetchone()
    assert dict(fresh) == {"scope": "project", "projectId": "proj_1", "blueprintId": None, "status": "active"}

    # Project scope holds at 30 active; the oldest PROJECT row was disabled.
    active_project = db.execute(
        "SELECT COUNT(*) AS n FROM memories WHERE scope='project' AND project_id='proj_1' AND status='active'"
    ).fetchone()
    assert active_project["n"] == 30
    disabled = db.execute("SELECT id FROM memories WHERE status='disabled'").fetchall()
    assert [r["id"] for r in disabled] == ["proj_0"]

    # Blueprint memories are untouched: all 5 still active.
    active_blueprint = db.execute(
        "SELECT COUNT(*) AS n FROM memories "
        "WHERE scope='blueprint' AND blueprint_id='bp_1' AND status='active'"
    ).fetchone()
    assert active_blueprint["n"] == 5
