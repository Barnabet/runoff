"""Ports packages/core/test/previousRun.test.ts.

TS signature is previousCompletedDocument(sqlite, blueprintId, {runId, createdAt});
the Python signature per the brief flattens the current-run object to positional
run_id / created_at args.
"""

from runoff_api.core.jsonutil import to_json
from runoff_api.core.previous_run import previous_completed_document

DOC = to_json({"title": "Prev", "eyebrow": "E", "dateline": "D", "sections": []})


def _insert_run(db, run_id, **over):
    db.execute(
        """INSERT INTO runs (id, blueprint_id, blueprint_rev, status, created_at, finished_at, document)
       VALUES (?, ?, 1, ?, ?, ?, ?)""",
        (
            run_id,
            over.get("blueprint_id", "bp_1"),
            over.get("status", "complete"),
            over.get("created_at", "2026-07-01 09:00:00"),
            over["finished_at"] if "finished_at" in over else "2026-07-01 09:10:00",
            over["document"] if "document" in over else DOC,
        ),
    )


def test_returns_the_latest_complete_predecessor_with_its_parsed_document(db):
    _insert_run(db, "run_old", created_at="2026-06-01 09:00:00", finished_at="2026-06-01 09:09:00")
    _insert_run(db, "run_prev", created_at="2026-07-01 09:00:00")
    _insert_run(
        db, "run_cur", status="running", created_at="2026-07-18 09:00:00", document=None, finished_at=None
    )

    prev = previous_completed_document(db, "bp_1", "run_cur", "2026-07-18 09:00:00")
    assert prev["runId"] == "run_prev"
    assert prev["completedAt"] == "2026-07-01 09:10:00"
    assert prev["document"]["title"] == "Prev"


def test_skips_non_complete_newer_other_blueprint_runs_and_itself(db):
    _insert_run(db, "run_queued", status="queued", created_at="2026-07-01 09:00:00")
    _insert_run(db, "run_failed", status="failed", created_at="2026-07-02 09:00:00")
    _insert_run(db, "run_other", blueprint_id="bp_2", created_at="2026-07-03 09:00:00")
    _insert_run(db, "run_newer", created_at="2026-07-20 09:00:00")
    _insert_run(db, "run_cur", created_at="2026-07-18 09:00:00")

    prev = previous_completed_document(db, "bp_1", "run_cur", "2026-07-18 09:00:00")
    assert prev is None


def test_falls_back_to_created_at_when_finished_at_is_null(db):
    _insert_run(db, "run_prev", created_at="2026-07-01 09:00:00", finished_at=None)
    prev = previous_completed_document(db, "bp_1", "run_cur", "2026-07-18 09:00:00")
    assert prev["completedAt"] == "2026-07-01 09:00:00"


def test_returns_null_when_the_document_column_is_null_or_unparseable(db):
    _insert_run(db, "run_nodoc", created_at="2026-07-01 09:00:00", document=None)
    assert previous_completed_document(db, "bp_1", "run_cur", "2026-07-18 09:00:00") is None

    _insert_run(db, "run_baddoc", created_at="2026-07-02 09:00:00", document="{not json")
    assert previous_completed_document(db, "bp_1", "run_cur", "2026-07-18 09:00:00") is None


def test_breaks_same_second_created_at_ties_by_id_desc(db):
    _insert_run(db, "run_a", created_at="2026-07-01 09:00:00")
    _insert_run(db, "run_b", created_at="2026-07-01 09:00:00")

    prev = previous_completed_document(db, "bp_1", "run_cur", "2026-07-18 09:00:00")
    assert prev["runId"] == "run_b"
    assert prev["document"]["title"] == "Prev"
