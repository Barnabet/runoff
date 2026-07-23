"""Covers apps/web/lib/goldens.ts (list/get/resolve + degradation paths) and the
non-LLM golden_pipeline entry points against the conftest `db` fixture.
"""

import sqlite3

from runoff_api.core.bindings import parse_bindings
from runoff_api.core.jsonutil import to_json
from runoff_api.services.golden_pipeline import rebuild_run_golden_inventory, verify_stored_inventory
from runoff_api.services.goldens import get_golden_row, golden_label, list_goldens, resolve_golden

DOC = {
    "title": "AR Review",
    "eyebrow": "",
    "dateline": "",
    "sections": [
        {"key": "summary", "heading": "Summary",
         "blocks": [{"type": "paragraph", "spans": [{"text": "Total 300"}]}]},
        {"key": "detail", "heading": "Detail",
         "blocks": [{"type": "paragraph", "spans": [{"text": "x"}]}]},
    ],
}


def insert_golden(db, **over):
    row = {
        "id": "g1", "blueprint_id": "b1", "kind": "run", "run_id": None, "section_key": None,
        "name": None, "mime": None, "stored_filename": None, "note": None, "period": None,
        "document": None, "unify_error": None, "bindings": None,
    }
    row.update(over)
    db.execute(
        "INSERT INTO goldens (id, blueprint_id, kind, run_id, section_key, name, mime, "
        "stored_filename, note, period, document, unify_error, bindings) "
        "VALUES (:id,:blueprint_id,:kind,:run_id,:section_key,:name,:mime,:stored_filename,"
        ":note,:period,:document,:unify_error,:bindings)",
        row,
    )


def insert_run(db, run_id, document):
    db.execute(
        "INSERT INTO runs (id, blueprint_id, blueprint_rev, document) VALUES (?, ?, ?, ?)",
        (run_id, "b1", 1, document),
    )


# ── list / get / label ──────────────────────────────────────────────────────


def test_list_goldens_newest_first(db):
    insert_golden(db, id="g1", kind="exemplar", name="first")
    insert_golden(db, id="g2", kind="exemplar", name="second")
    insert_golden(db, id="gX", blueprint_id="other", kind="exemplar", name="elsewhere")
    rows = list_goldens(db, "b1")
    assert [r["id"] for r in rows] == ["g2", "g1"]
    assert all(isinstance(r, dict) for r in rows)


def test_get_golden_row(db):
    insert_golden(db, id="g1", kind="exemplar", name="ex")
    assert get_golden_row(db, "g1")["name"] == "ex"
    assert get_golden_row(db, "missing") is None


def test_golden_label_forms(db):
    assert golden_label({"kind": "exemplar", "name": "my exemplar"}) == "my exemplar"
    assert golden_label({"kind": "exemplar", "name": None}) == "exemplar"
    assert golden_label({"kind": "run", "runId": "r9", "sectionKey": None}) == "run r9"
    assert golden_label({"kind": "section", "runId": "r9", "sectionKey": "summary"}) == "run r9 §summary"


# ── resolve ──────────────────────────────────────────────────────────────────


def test_resolve_missing_returns_none(db):
    assert resolve_golden(db, "nope") is None


def test_resolve_run_golden_reads_run_document(db):
    insert_run(db, "r1", to_json(DOC))
    insert_golden(db, id="g1", kind="run", run_id="r1", period="2026-Q1")
    r = resolve_golden(db, "g1")
    assert r["kind"] == "run"
    assert r["label"] == "run r1"
    assert r["period"] == "2026-Q1"
    assert [s["key"] for s in r["document"]["sections"]] == ["summary", "detail"]
    assert r["inventory"] is None


def test_resolve_section_golden_filters_to_one_section(db):
    insert_run(db, "r1", to_json(DOC))
    insert_golden(db, id="g1", kind="section", run_id="r1", section_key="summary")
    r = resolve_golden(db, "g1")
    assert [s["key"] for s in r["document"]["sections"]] == ["summary"]


def test_resolve_section_golden_no_matching_section_degrades_to_none(db):
    insert_run(db, "r1", to_json(DOC))
    insert_golden(db, id="g1", kind="section", run_id="r1", section_key="ghost")
    assert resolve_golden(db, "g1")["document"] is None


def test_resolve_exemplar_golden_reads_stored_document(db):
    insert_golden(db, id="g1", kind="exemplar", name="ex", document=to_json(DOC))
    r = resolve_golden(db, "g1")
    assert r["document"]["title"] == "AR Review"


def test_resolve_corrupt_document_degrades_to_none(db):
    insert_run(db, "r1", "{not json")
    insert_golden(db, id="g1", kind="run", run_id="r1")
    assert resolve_golden(db, "g1")["document"] is None


def test_resolve_corrupt_bindings_degrade_to_none_inventory(db):
    insert_run(db, "r1", to_json(DOC))
    insert_golden(db, id="g1", kind="run", run_id="r1", bindings="{not json")
    r = resolve_golden(db, "g1")
    assert r["document"] is not None
    assert r["inventory"] is None


def test_resolve_valid_bindings_produce_inventory(db):
    inventory = {
        "version": 1,
        "items": [{
            "id": "total", "kind": "value",
            "anchor": {"sectionKey": "summary", "blockIndex": 0, "spanIndex": 0},
            "raw": "300", "parsed": 300, "reason": None,
            "binding": {"familyId": "f", "sql": "Q", "verifiedValue": 300, "status": "bound"},
        }],
    }
    insert_run(db, "r1", to_json(DOC))
    insert_golden(db, id="g1", kind="run", run_id="r1", bindings=to_json(inventory))
    r = resolve_golden(db, "g1")
    assert len(r["inventory"]["items"]) == 1


# ── golden_pipeline (rebuild / verify against a real warehouse) ──────────────

PIPE_DOC = {
    "title": "AR", "eyebrow": "", "dateline": "",
    "sections": [{
        "key": "summary", "heading": "S", "blocks": [
            {"type": "paragraph", "spans": [
                {"text": "Total "},
                {"text": "300",
                 "citation": {"sourceId": "fam_ar", "locator": "sum(fam_ar_transactions.amount)"}},
            ]},
            {"type": "table", "columns": ["status"], "rows": [{"cells": [[]]}, {"cells": [[]]}]},
        ],
    }],
}


def _seed_pipeline(db, wh_dir, monkeypatch):
    wh_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("RUNOFF_WAREHOUSE_DIR", str(wh_dir))
    wh = sqlite3.connect(str(wh_dir / "p1.db"))
    wh.execute("CREATE TABLE fam_ar_transactions (_period TEXT, amount REAL, status TEXT)")
    wh.executemany(
        "INSERT INTO fam_ar_transactions (_period, amount, status) VALUES (?, ?, ?)",
        [("2026-Q1", 100.0, "paid"), ("2026-Q1", 200.0, "open")],
    )
    wh.commit()
    wh.close()
    db.execute("INSERT INTO projects (id, name) VALUES ('p1', 'P')")
    db.execute(
        "INSERT INTO source_families (id, project_id, key, label, kind, granularity) "
        "VALUES ('fam_ar', 'p1', 'ar_transactions', 'AR', 'periodic', 'quarter')"
    )
    db.execute("INSERT INTO blueprints (id, name, project_id, current_rev) VALUES ('b1', 'B', 'p1', 1)")
    by_status_sql = "SELECT status FROM fam_ar_transactions WHERE _period = :period GROUP BY status"
    content = to_json({"sections": [
        {"key": "summary", "queries": [{"name": "by_status", "sql": by_status_sql}]}
    ]})
    db.execute(
        "INSERT INTO blueprint_revisions (id, blueprint_id, rev, content) VALUES ('rev1', 'b1', 1, ?)",
        (content,),
    )
    insert_run(db, "r1", to_json(PIPE_DOC))
    insert_golden(db, id="g1", kind="run", run_id="r1", period="2026-Q1")


def test_rebuild_run_golden_inventory_stamps_bindings(db, tmp_path, monkeypatch):
    _seed_pipeline(db, tmp_path / "wh", monkeypatch)
    rebuild_run_golden_inventory(db, "g1")
    stored = db.execute("SELECT bindings FROM goldens WHERE id = 'g1'").fetchone()["bindings"]
    inv = parse_bindings(stored)
    value = next(i for i in inv["items"] if i["kind"] == "value")
    assert value["binding"]["familyId"] == "fam_ar"
    assert value["binding"]["status"] == "bound"  # SUM(amount)=300 == parsed 300
    assert value["binding"]["verifiedValue"] == 300
    table = next(i for i in inv["items"] if i["kind"] == "table")
    assert table["binding"]["status"] == "bound"  # 2 status rows == 2 doc rows


def test_verify_stored_inventory_reverifies(db, tmp_path, monkeypatch):
    _seed_pipeline(db, tmp_path / "wh", monkeypatch)
    rebuild_run_golden_inventory(db, "g1")
    verify_stored_inventory(db, "g1")
    stored = db.execute("SELECT bindings FROM goldens WHERE id = 'g1'").fetchone()["bindings"]
    inv = parse_bindings(stored)
    assert next(i for i in inv["items"] if i["kind"] == "value")["binding"]["status"] == "bound"


def test_pipeline_no_document_is_noop(db):
    insert_golden(db, id="g1", kind="run", run_id="missing")
    rebuild_run_golden_inventory(db, "g1")  # resolve → document None → returns
    assert db.execute("SELECT bindings FROM goldens WHERE id = 'g1'").fetchone()["bindings"] is None
