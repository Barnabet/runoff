"""Port of apps/worker/test/runLoop.test.ts."""

import json
import tempfile
from pathlib import Path

from fake_client import make_fake_client

from runoff_api.core.db import RunoffDb, open_db
from runoff_api.core.ids import new_id
from runoff_api.core.jsonutil import to_json
from runoff_api.worker.run_loop import claim_queued_run, fail_stale_runs, make_engine_io, process_one


def temp_db() -> RunoffDb:
    return open_db(str(Path(tempfile.mkdtemp(prefix="runoff-worker-")) / "t.db"))


# A fixed-only blueprint: fixed sections never call the model, so `process_one`
# can drive an end-to-end run with a `None` client.
FIXED_ONLY_CONTENT = {
    "title": "Weekly Digest",
    "clientName": "Acme",
    "eyebrow": "Weekly",
    "dateline": "July 2026",
    "sections": [
        {
            "key": "intro",
            "number": 1,
            "heading": "Introduction",
            "mode": "fixed",
            "instruction": "",
            "fixedText": "Welcome to the digest.",
            "familyIds": [],
            "queries": [],
            "rules": [],
        },
    ],
    "globalRules": [],
    "delivery": {"recipient": "", "autoDeliverOnClear": False},
}

# A single review-mode section: one model call (drafts plain text that passes
# checks), then the engine auto-raises a review flag (rule 7). Proves flag ids are
# run-scoped across two runs on one DB.
REVIEW_CONTENT = {
    "title": "Review Digest",
    "clientName": "Acme",
    "eyebrow": "Weekly",
    "dateline": "July 2026",
    "sections": [
        {
            "key": "summary",
            "number": 1,
            "heading": "Summary",
            "mode": "review",
            "instruction": "Review the summary.",
            "familyIds": [],
            "queries": [],
            "rules": [],
        },
    ],
    "globalRules": [],
    "delivery": {"recipient": "", "autoDeliverOnClear": False},
}


def flag_raising_client():
    """One turn of plain text, then `stop` — the draft engine streams it."""
    return make_fake_client([[{"text": "The review reads well."}]])


def seed_queued_run(db: RunoffDb, content: dict) -> str:
    bp_id = new_id("bp")
    db.execute("INSERT INTO blueprints (id, name, current_rev) VALUES (?, 'Digest', 1)", (bp_id,))
    db.execute(
        "INSERT INTO blueprint_revisions (id, blueprint_id, rev, content) VALUES (?, ?, 1, ?)",
        (new_id("rev"), bp_id, to_json(content)),
    )
    run_id = new_id("run")
    db.execute(
        "INSERT INTO runs (id, blueprint_id, blueprint_rev, status) VALUES (?, ?, 1, 'queued')",
        (run_id, bp_id),
    )
    return run_id


# --- process_one ----------------------------------------------------------


def test_claims_and_completes_a_fixed_only_run_without_touching_the_client():
    db = temp_db()
    run_id = seed_queued_run(db, FIXED_ONLY_CONTENT)

    assert process_one(db, None) is True

    run = db.execute(
        "SELECT status, document, stats, started_at, finished_at FROM runs WHERE id = ?", (run_id,)
    ).fetchone()
    assert run["status"] == "complete"
    assert run["started_at"]
    assert run["finished_at"]
    assert run["stats"]

    doc = json.loads(run["document"])
    assert len(doc["sections"]) == 1
    assert doc["sections"][0]["heading"] == "Introduction"

    events = db.execute(
        "SELECT seq, type FROM run_events WHERE run_id = ? ORDER BY seq", (run_id,)
    ).fetchall()
    types = [e["type"] for e in events]
    assert "run_started" in types
    assert "run_completed" in types
    assert types.index("run_started") < types.index("run_completed")

    seqs = [e["seq"] for e in events]
    assert seqs[0] == 1
    assert seqs == sorted(seqs)  # monotonic
    assert len(set(seqs)) == len(seqs)  # unique


def test_returns_false_when_nothing_is_queued():
    db = temp_db()
    assert process_one(db, None) is False


def test_threads_the_runs_period_onto_run_started_fixed_only_run():
    db = temp_db()
    bp_id = new_id("bp")
    db.execute("INSERT INTO blueprints (id, name, current_rev) VALUES (?, 'Digest', 1)", (bp_id,))
    db.execute(
        "INSERT INTO blueprint_revisions (id, blueprint_id, rev, content) VALUES (?, ?, 1, ?)",
        (new_id("rev"), bp_id, to_json(FIXED_ONLY_CONTENT)),
    )
    run_id = new_id("run")
    db.execute(
        "INSERT INTO runs (id, blueprint_id, blueprint_rev, status, period) "
        "VALUES (?, ?, 1, 'queued', '2026-Q1')",
        (run_id, bp_id),
    )

    assert process_one(db, None) is True

    started = db.execute(
        "SELECT payload FROM run_events WHERE run_id = ? AND type = 'run_started'", (run_id,)
    ).fetchone()
    assert json.loads(started["payload"])["period"] == "2026-Q1"


def test_keeps_flag_ids_run_scoped_so_two_flagged_runs_on_one_db_both_complete():
    db = temp_db()
    client = flag_raising_client()
    run1 = seed_queued_run(db, REVIEW_CONTENT)
    run2 = seed_queued_run(db, REVIEW_CONTENT)

    # Each flagged run raises `flag_1` internally; the worker namespaces the row id
    # by run, so the second run's insert does not hit UNIQUE(flags.id).
    assert process_one(db, client) is True
    assert process_one(db, client) is True

    for run_id in (run1, run2):
        run = db.execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()
        assert run["status"] == "complete"

    flags = db.execute("SELECT id, run_id FROM flags").fetchall()
    assert len(flags) == 2
    assert len({f["id"] for f in flags}) == 2
    assert {f["run_id"] for f in flags} == {run1, run2}


def test_marks_run_failed_when_revision_content_is_invalid():
    db = temp_db()
    bp_id = new_id("bp")
    db.execute("INSERT INTO blueprints (id, name, current_rev) VALUES (?, 'Broken', 1)", (bp_id,))
    # Content that fails BlueprintContent validation (missing required fields).
    db.execute(
        "INSERT INTO blueprint_revisions (id, blueprint_id, rev, content) VALUES (?, ?, 1, ?)",
        (new_id("rev"), bp_id, to_json({"title": "oops"})),
    )
    run_id = new_id("run")
    db.execute(
        "INSERT INTO runs (id, blueprint_id, blueprint_rev, status) VALUES (?, ?, 1, 'queued')",
        (run_id, bp_id),
    )

    assert process_one(db, None) is True

    run = db.execute("SELECT status, finished_at FROM runs WHERE id = ?", (run_id,)).fetchone()
    assert run["status"] == "failed"
    assert run["finished_at"]

    events = db.execute("SELECT type FROM run_events WHERE run_id = ?", (run_id,)).fetchall()
    assert any(e["type"] == "run_failed" for e in events)


# --- make_engine_io -------------------------------------------------------


def test_inserts_a_matching_flags_row_when_a_flag_raised_event_is_emitted():
    db = temp_db()
    run_id = new_id("run")
    db.execute(
        "INSERT INTO runs (id, blueprint_id, blueprint_rev, status) VALUES (?, 'bp_x', 1, 'running')",
        (run_id,),
    )

    io = make_engine_io(db, run_id)
    io.emit(
        {
            "type": "flag_raised",
            "flagId": "flag_1",
            "code": "F1",
            "sectionKey": "body",
            "question": "Keep this?",
            "options": ["Keep", "Drop"],
        }
    )

    flag = db.execute(
        "SELECT id, run_id, code, section_key, question, options, status FROM flags WHERE id = ?",
        (f"{run_id}_flag_1",),
    ).fetchone()
    assert flag is not None
    assert flag["id"] == f"{run_id}_flag_1"
    assert flag["run_id"] == run_id
    assert flag["code"] == "F1"
    assert flag["section_key"] == "body"
    assert flag["question"] == "Keep this?"
    assert json.loads(flag["options"]) == ["Keep", "Drop"]
    assert flag["status"] == "open"

    ev = db.execute("SELECT type FROM run_events WHERE run_id = ?", (run_id,)).fetchall()
    assert any(e["type"] == "flag_raised" for e in ev)


# --- claim_queued_run -----------------------------------------------------


def test_claim_returns_none_when_nothing_is_queued():
    db = temp_db()
    assert claim_queued_run(db) is None


def test_claims_the_oldest_queued_run_and_flips_it_to_running():
    db = temp_db()
    run_id = seed_queued_run(db, FIXED_ONLY_CONTENT)
    claimed = claim_queued_run(db)
    assert claimed["id"] == run_id
    assert isinstance(claimed["blueprintId"], str)
    assert claimed["blueprintRev"] == 1
    assert claimed["period"] is None
    assert set(claimed.keys()) == {"id", "blueprintId", "blueprintRev", "period"}
    row = db.execute("SELECT status, started_at FROM runs WHERE id = ?", (run_id,)).fetchone()
    assert row["status"] == "running"
    assert row["started_at"]
    # Once claimed, it is no longer available.
    assert claim_queued_run(db) is None


# --- fail_stale_runs ------------------------------------------------------


def test_flips_stuck_running_paused_runs_to_failed_with_a_run_failed_event():
    db = temp_db()
    running = new_id("run")
    paused = new_id("run")
    db.execute(
        "INSERT INTO runs (id, blueprint_id, blueprint_rev, status) VALUES (?, 'bp_x', 1, 'running')",
        (running,),
    )
    db.execute(
        "INSERT INTO runs (id, blueprint_id, blueprint_rev, status) VALUES (?, 'bp_x', 1, 'paused')",
        (paused,),
    )
    # A completed run must be left untouched.
    done = new_id("run")
    db.execute(
        "INSERT INTO runs (id, blueprint_id, blueprint_rev, status) VALUES (?, 'bp_x', 1, 'complete')",
        (done,),
    )

    count = fail_stale_runs(db)
    assert count == 2

    for run_id in (running, paused):
        run = db.execute("SELECT status, finished_at FROM runs WHERE id = ?", (run_id,)).fetchone()
        assert run["status"] == "failed"
        assert run["finished_at"]
        ev = db.execute(
            "SELECT type, payload FROM run_events WHERE run_id = ? ORDER BY seq", (run_id,)
        ).fetchall()
        assert any(
            e["type"] == "run_failed" and json.loads(e["payload"])["error"] == "worker restarted mid-run"
            for e in ev
        )

    assert db.execute("SELECT status FROM runs WHERE id = ?", (done,)).fetchone()["status"] == "complete"
