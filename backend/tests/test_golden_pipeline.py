"""Port of apps/web/test/goldenPipeline.test.ts LLM half — bind_exemplar,
unify_and_bind_exemplar, and _siblings_for.

The LLM boundary is mocked at the `unify_golden_report` / `bind_golden` seams
(exactly as the TS test mocks `@runoff/engine`'s `unifyGoldenReport`/`bindGolden`);
verification, catalog, and warehouse SQL stay real so the pipeline runs real SQL
against a test warehouse. `make_llm_client` is stubbed to a dummy client.

Two TS cases are intentionally omitted because R1 already twinned them:
- goldenPipeline.test.ts "star chain … no LLM" → test_goldens_service.py
  `test_rebuild_run_golden_inventory_stamps_bindings` (the run/section deterministic path).
- goldenPipeline.test.ts "copilot cache render" (renderGoldenForPrompt) →
  test_golden_binding.py + test_goldens_service.py already cover render_golden_for_prompt.
The `:334-338` slice of the "graceful degradation" case (corrupt bindings →
list_golden_summaries label "not yet bound") HAS no direct twin, so it is ported below.
"""

import sqlite3

import pytest

from runoff_api.services import golden_pipeline
from runoff_api.services.golden_pipeline import (
    _siblings_for,
    bind_exemplar,
    unify_and_bind_exemplar,
)
from runoff_api.services.goldens import list_golden_summaries, resolve_golden

DOC = {
    "title": "Q1 Report",
    "eyebrow": "E",
    "dateline": "D",
    "sections": [
        {"key": "exec", "heading": "Exec", "blocks": [
            {"type": "paragraph", "spans": [{"text": "Revenue was "}, {"text": "$150"}]}]},
        {"key": "outlook", "heading": "Outlook", "blocks": [
            {"type": "paragraph", "spans": [{"text": "Steady."}]}]},
    ],
}

# What the mocked bind_golden returns: unverified SQL bindings; verify stamps them.
SUBMITTED = {
    "version": 1,
    "items": [{
        "id": "rev", "kind": "value",
        "anchor": {"sectionKey": "exec", "blockIndex": 0, "spanIndex": 1},
        "raw": "$150", "parsed": 150, "reason": None,
        "binding": {"familyId": "famX", "sql": "SELECT SUM(amount) FROM fam_x WHERE _period = :period"},
    }],
}

BOUND_INV = {
    "version": 1,
    "items": [{
        "id": "a_item", "kind": "value",
        "anchor": {"sectionKey": "exec", "blockIndex": 0, "spanIndex": 0},
        "raw": "$1", "parsed": 1, "reason": None,
        "binding": {"familyId": "f", "sql": "SELECT 1", "verifiedValue": 1, "status": "bound"},
    }],
}


def _to_json(v):
    from runoff_api.core.jsonutil import to_json
    return to_json(v)


def insert_exemplar(db, gid, *, name, document=None, period=None, bindings=None,
                    unify_error=None, mime="text/markdown", stored_filename=None):
    db.execute(
        "INSERT INTO goldens (id, blueprint_id, kind, name, mime, stored_filename, period, "
        "document, bindings, unify_error) "
        "VALUES (?, 'bp1', 'exemplar', ?, ?, ?, ?, ?, ?, ?)",
        (gid, name, mime, stored_filename,
         period,
         _to_json(document) if document is not None else None,
         _to_json(bindings) if bindings is not None else None,
         unify_error),
    )


@pytest.fixture()
def seeded(db, monkeypatch):
    """Project + blueprint + a dummy LLM client seam. No warehouse."""
    db.execute("INSERT INTO projects (id, name) VALUES ('p1', 'P')")
    db.execute("INSERT INTO blueprints (id, name, project_id, current_rev) VALUES ('bp1', 'B', 'p1', 1)")
    monkeypatch.setattr(golden_pipeline, "make_llm_client", lambda: object())
    return db


def _seed_warehouse(wh_dir, monkeypatch):
    """A warehouse with fam_x: SUM(amount) over 2026-Q1 == 150."""
    wh_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("RUNOFF_WAREHOUSE_DIR", str(wh_dir))
    wh = sqlite3.connect(str(wh_dir / "p1.db"))
    wh.execute("CREATE TABLE fam_x (_period TEXT, amount REAL)")
    wh.executemany("INSERT INTO fam_x (_period, amount) VALUES (?, ?)",
                   [("2026-Q1", 100.0), ("2026-Q1", 50.0)])
    wh.commit()
    wh.close()


# ── _siblings_for ────────────────────────────────────────────────────────────


def test_siblings_newest_three_non_null_excluding_self(seeded):
    db = seeded
    # 4 bound siblings + self + one null-bindings golden.
    for gid in ("s1", "s2", "s3", "s4"):
        insert_exemplar(db, gid, name=gid, document=DOC, period="2026-Q1", bindings=BOUND_INV)
    insert_exemplar(db, "s_null", name="null", document=DOC, period="2026-Q1")  # bindings NULL → excluded
    insert_exemplar(db, "self", name="self", document=DOC, period="2026-Q2", bindings=BOUND_INV)

    sibs = _siblings_for(db, "bp1", "self")
    assert len(sibs) == 3  # newest 3 by rowid DESC
    assert [s["inventory"]["items"][0]["id"] for s in sibs] == ["a_item", "a_item", "a_item"]
    # rowid DESC ⇒ s4, s3, s2 (s_null excluded for null bindings, self excluded by id)
    assert {s["period"] for s in sibs} == {"2026-Q1"}


def test_siblings_corrupt_row_skipped_not_fatal(seeded):
    db = seeded
    insert_exemplar(db, "good", name="good", document=DOC, period="2026-Q1", bindings=BOUND_INV)
    insert_exemplar(db, "corrupt", name="corrupt", document=DOC, period="2026-Q2")
    db.execute("UPDATE goldens SET bindings = ? WHERE id = 'corrupt'",
               ('{"version":1,"items":[{"garbage":true}]}',))
    sibs = _siblings_for(db, "bp1", "target")
    assert len(sibs) == 1
    assert sibs[0]["inventory"]["items"][0]["id"] == "a_item"


# ── bind_exemplar ────────────────────────────────────────────────────────────


def test_bind_exemplar_not_unified(seeded):
    insert_exemplar(seeded, "g", name="g")  # no document
    assert bind_exemplar(seeded, "g") == {"ok": False, "error": "golden is not unified"}


def test_bind_exemplar_none_from_bind(seeded, monkeypatch):
    insert_exemplar(seeded, "g", name="g", document=DOC, period="2026-Q1")
    monkeypatch.setattr(golden_pipeline, "bind_golden", lambda **kw: None)
    res = bind_exemplar(seeded, "g")
    assert res == {"ok": False, "error": "bind failed: no inventory produced"}
    assert seeded.execute("SELECT bindings FROM goldens WHERE id = 'g'").fetchone()["bindings"] is None


def test_bind_exemplar_exception_wrapped(seeded, monkeypatch):
    insert_exemplar(seeded, "g", name="g", document=DOC, period="2026-Q1")

    def boom(**kw):
        raise RuntimeError("kaboom")

    monkeypatch.setattr(golden_pipeline, "bind_golden", boom)
    assert bind_exemplar(seeded, "g") == {"ok": False, "error": "bind failed: kaboom"}


def test_bind_exemplar_hands_sibling_inventories(seeded, monkeypatch):
    db = seeded
    insert_exemplar(db, "gold_a", name="a.md", document=DOC, period="2026-Q1", bindings=BOUND_INV)
    insert_exemplar(db, "gold_b", name="b.md", document=DOC, period="2026-Q2")

    captured = {}

    def fake_bind(**kw):
        captured.update(kw)
        return None

    monkeypatch.setattr(golden_pipeline, "bind_golden", fake_bind)
    bind_exemplar(db, "gold_b")

    assert captured["siblings"][0]["inventory"]["items"][0]["id"] == "a_item"
    assert captured["period"] == "2026-Q2"  # golden's own period drives run_sql/exec
    assert captured["prior_inventory"] is None  # gold_b has no stored bindings
    # failed bind leaves gold_b's bindings untouched (null)
    assert db.execute("SELECT bindings FROM goldens WHERE id = 'gold_b'").fetchone()["bindings"] is None


def test_bind_exemplar_sibling_degradation_good_still_reaches_agent(seeded, monkeypatch):
    db = seeded
    insert_exemplar(db, "gold_good", name="good.md", document=DOC, period="2026-Q1", bindings=BOUND_INV)
    insert_exemplar(db, "gold_corrupt", name="corrupt.md", document=DOC, period="2026-Q2")
    db.execute("UPDATE goldens SET bindings = ? WHERE id = 'gold_corrupt'",
               ('{"version":1,"items":[{"garbage":true}]}',))
    insert_exemplar(db, "gold_target", name="target.md", document=DOC, period="2026-Q3")

    captured = {}

    def fake_bind(**kw):
        captured.update(kw)
        return None

    monkeypatch.setattr(golden_pipeline, "bind_golden", fake_bind)
    res = bind_exemplar(db, "gold_target")

    assert res == {"ok": False, "error": "bind failed: no inventory produced"}
    assert len(captured["siblings"]) == 1
    assert captured["siblings"][0]["inventory"]["items"][0]["id"] == "a_item"


def test_bind_exemplar_success_verifies_and_persists(seeded, monkeypatch, tmp_path):
    db = seeded
    _seed_warehouse(tmp_path / "wh", monkeypatch)
    insert_exemplar(db, "g", name="g", document=DOC, period="2026-Q1")
    monkeypatch.setattr(golden_pipeline, "bind_golden", lambda **kw: SUBMITTED)

    assert bind_exemplar(db, "g") == {"ok": True}
    g = resolve_golden(db, "g")
    # verifiedValue is the WAREHOUSE-computed sum, proving verification executed real SQL.
    item = g["inventory"]["items"][0]
    assert item["binding"]["status"] == "bound"
    assert item["binding"]["verifiedValue"] == 150


# ── unify_and_bind_exemplar ──────────────────────────────────────────────────


def test_unify_unsupported_mime_persists_error_no_llm(seeded, monkeypatch):
    db = seeded
    insert_exemplar(db, "g", name="data.csv", mime="text/csv")
    calls = []
    monkeypatch.setattr(golden_pipeline, "unify_golden_report", lambda **kw: calls.append("u"))
    monkeypatch.setattr(golden_pipeline, "bind_golden", lambda **kw: calls.append("b"))

    unify_and_bind_exemplar(db, "g")
    row = db.execute("SELECT unify_error AS e, document AS d FROM goldens WHERE id = 'g'").fetchone()
    assert row["e"] == "unsupported exemplar type for unify: text/csv"
    assert row["d"] is None
    assert calls == []


def test_unify_none_persists_no_document_produced(seeded, monkeypatch, tmp_path):
    db = seeded
    files = tmp_path / "files"
    files.mkdir()
    (files / "r.md").write_text("text")
    monkeypatch.setenv("RUNOFF_FILES_DIR", str(files))
    insert_exemplar(db, "g", name="r.md", mime="text/markdown", stored_filename="r.md")
    monkeypatch.setattr(golden_pipeline, "unify_golden_report", lambda **kw: None)
    bind_called = []
    monkeypatch.setattr(golden_pipeline, "bind_golden", lambda **kw: bind_called.append(1))

    unify_and_bind_exemplar(db, "g")
    row = db.execute(
        "SELECT unify_error AS e, document AS d, bindings AS b FROM goldens WHERE id = 'g'"
    ).fetchone()
    assert row["e"] == "unify failed: no document produced"
    assert row["d"] is None
    assert row["b"] is None
    assert bind_called == []


def test_unify_extract_exception_persists_unify_failed(seeded, monkeypatch, tmp_path):
    db = seeded
    monkeypatch.setenv("RUNOFF_FILES_DIR", str(tmp_path / "files"))  # dir/file absent → extract raises
    insert_exemplar(db, "g", name="r.md", mime="text/markdown", stored_filename="missing.md")

    def boom(**kw):
        raise RuntimeError("should not reach unify")

    monkeypatch.setattr(golden_pipeline, "unify_golden_report", boom)
    unify_and_bind_exemplar(db, "g")
    err = db.execute("SELECT unify_error AS e FROM goldens WHERE id = 'g'").fetchone()["e"]
    assert err.startswith("unify failed: ")
    assert "should not reach unify" not in err  # failed at extract, before unify


def test_unify_then_autobind_full_chain(seeded, monkeypatch, tmp_path):
    db = seeded
    _seed_warehouse(tmp_path / "wh", monkeypatch)
    files = tmp_path / "files"
    files.mkdir()
    (files / "q1.md").write_text("# Q1\nRevenue was $150")
    monkeypatch.setenv("RUNOFF_FILES_DIR", str(files))
    insert_exemplar(db, "g", name="q1.md", mime="text/markdown", stored_filename="q1.md")

    monkeypatch.setattr(golden_pipeline, "unify_golden_report",
                        lambda **kw: {"document": DOC, "period": "2026-Q1"})
    bind_args = {}

    def fake_bind(**kw):
        bind_args.update(kw)
        return SUBMITTED

    monkeypatch.setattr(golden_pipeline, "bind_golden", fake_bind)

    unify_and_bind_exemplar(db, "g")

    # bind ran against the golden's (unified) period.
    assert bind_args["period"] == "2026-Q1"
    g = resolve_golden(db, "g")
    assert g["document"]["title"] == "Q1 Report"
    assert g["period"] == "2026-Q1"
    assert g["unifyError"] is None
    # verifiedValue is warehouse-computed, proving verify ran real SQL after auto-chain.
    assert g["inventory"]["items"][0]["binding"] == {
        "familyId": "famX",
        "sql": "SELECT SUM(amount) FROM fam_x WHERE _period = :period",
        "verifiedValue": 150,
        "status": "bound",
    }


def test_unify_success_autochain_bind_failure_leaves_bindings_null(seeded, monkeypatch, tmp_path):
    db = seeded
    files = tmp_path / "files"
    files.mkdir()
    (files / "q1.md").write_text("# Q1")
    monkeypatch.setenv("RUNOFF_FILES_DIR", str(files))
    insert_exemplar(db, "g", name="q1.md", mime="text/markdown", stored_filename="q1.md")

    monkeypatch.setattr(golden_pipeline, "unify_golden_report",
                        lambda **kw: {"document": DOC, "period": "2026-Q1"})
    monkeypatch.setattr(golden_pipeline, "bind_golden", lambda **kw: None)  # bind yields nothing

    unify_and_bind_exemplar(db, "g")  # must NOT raise
    row = db.execute(
        "SELECT document AS d, unify_error AS e, bindings AS b FROM goldens WHERE id = 'g'"
    ).fetchone()
    assert row["d"] is not None  # unify persisted
    assert row["e"] is None  # unify_error cleared
    assert row["b"] is None  # bind failure left bindings null


# ── list_golden_summaries corrupt bindings (goldenPipeline.test.ts:334-338) ───


def test_corrupt_bindings_summary_label_not_yet_bound(seeded):
    db = seeded
    insert_exemplar(db, "gold_bad", name="bad.md", document=DOC, period="2026-Q1")
    db.execute("UPDATE goldens SET bindings = ? WHERE id = 'gold_bad'", ("{not json",))
    summaries = list_golden_summaries(db, "bp1")
    summary = next(s for s in summaries if s["id"] == "gold_bad")
    assert "not yet bound" in summary["label"]
