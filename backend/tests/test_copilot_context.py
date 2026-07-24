"""Port of apps/web/test/copilotApi.test.ts context-shape cases plus the seven
CopilotContext method callbacks (runSql, listRuns, getRunSection, listGoldens,
getGolden, scaffoldDigest, saveMemory). Only the route-wiring cases (SSE,
message persistence, the memories HTTP routes) stay in Task 11.
"""

import json

import pytest

from runoff_api.services.queries import build_copilot_context


def seed_blueprint(db, bp_id: str) -> None:
    """A bound constant family (fam_1, one live file), a bound periodic family
    (fam_rev, two filed quarters), and an unbound periodic family (fam_un)."""
    db.execute(
        "INSERT INTO blueprints (id, name, client_name, project_id, current_rev) "
        "VALUES (?, 'R', 'C', 'proj_1', 1)",
        (bp_id,),
    )
    db.execute(
        "INSERT INTO source_families (id, project_id, key, label, kind) "
        "VALUES ('fam_1', 'proj_1', 'src', 'Src', 'constant')"
    )
    db.execute(
        "INSERT INTO source_families (id, project_id, key, label, kind, granularity) "
        "VALUES ('fam_rev', 'proj_1', 'revenue', 'Revenue', 'periodic', 'quarter')"
    )
    db.execute(
        "INSERT INTO source_families (id, project_id, key, label, kind, granularity) "
        "VALUES ('fam_un', 'proj_1', 'leftover', 'Leftover', 'periodic', 'month')"
    )
    src = (
        "INSERT INTO sources (id, project_id, family_id, period, name, kind, "
        "stored_filename, mime, size, status) "
        "VALUES (?, 'proj_1', ?, ?, ?, 'file', ?, 'text/plain', 5, 'filed')"
    )
    db.execute(src, ("src_1", "fam_1", None, "Src", "src_1.txt"))
    db.execute(src, ("src_q1", "fam_rev", "2026-Q1", "Revenue Q1", "src_q1.csv"))
    db.execute(src, ("src_q2", "fam_rev", "2026-Q2", "Revenue Q2", "src_q2.csv"))
    db.execute("INSERT INTO blueprint_families (blueprint_id, family_id) VALUES (?, 'fam_1')", (bp_id,))
    db.execute("INSERT INTO blueprint_families (blueprint_id, family_id) VALUES (?, 'fam_rev')", (bp_id,))


def test_families_tree_ordered_by_key_with_bound_flags(db):
    seed_blueprint(db, "bp_1")
    ctx = build_copilot_context(db, "bp_1", {}, {})

    # Every project family appears (ordered by key); bound ones marked, filed
    # periods ascending; constants get [] + hasLiveFile, periodics hasLiveFile False.
    assert ctx["families"] == [
        {"id": "fam_un", "key": "leftover", "label": "Leftover", "kind": "periodic",
         "granularity": "month", "filedPeriods": [], "hasLiveFile": False, "bound": False},
        {"id": "fam_rev", "key": "revenue", "label": "Revenue", "kind": "periodic",
         "granularity": "quarter", "filedPeriods": ["2026-Q1", "2026-Q2"],
         "hasLiveFile": False, "bound": True},
        {"id": "fam_1", "key": "src", "label": "Src", "kind": "constant",
         "granularity": None, "filedPeriods": [], "hasLiveFile": True, "bound": True},
    ]


def test_default_files_constant_slot_and_periodic_latest(db):
    seed_blueprint(db, "bp_1")
    ctx = build_copilot_context(db, "bp_1", {}, {})

    # defaultFiles: constant live file + periodic latest period (Q2). id = family id.
    assert sorted(f["id"] for f in ctx["defaultFiles"]) == ["fam_1", "fam_rev"]
    rev = next(f for f in ctx["defaultFiles"] if f["id"] == "fam_rev")
    assert "src_q2.csv" in rev["path"]
    assert rev["name"] == "Revenue"
    assert rev["mime"] == "text/plain"
    const = next(f for f in ctx["defaultFiles"] if f["id"] == "fam_1")
    assert "src_1.txt" in const["path"]


def test_period_files_every_filed_periodic_row_of_bound_families(db):
    seed_blueprint(db, "bp_1")
    ctx = build_copilot_context(db, "bp_1", {}, {})

    assert [f"{p['familyId']}:{p['period']}" for p in ctx["periodFiles"]] == [
        "fam_rev:2026-Q1",
        "fam_rev:2026-Q2",
    ]
    # file id = family id (the familyId:period re-keying happens later in the engine).
    assert all(p["file"]["id"] == p["familyId"] for p in ctx["periodFiles"])
    assert all("src_q" in p["file"]["path"] for p in ctx["periodFiles"])


def test_catalog_is_a_list_and_caches_pass_through(db):
    seed_blueprint(db, "bp_1")
    golden_cache = {"g1": {"description": "d", "text": "t"}}
    scaffold_cache = {"g1": "digest"}
    ctx = build_copilot_context(db, "bp_1", golden_cache, scaffold_cache)

    assert isinstance(ctx["catalog"], list)
    assert ctx["goldenCache"] is golden_cache
    assert ctx["scaffoldCache"] is scaffold_cache


def test_missing_blueprint_yields_empty_families(db):
    # No blueprint row -> project_id resolves to "" -> no families for that project.
    ctx = build_copilot_context(db, "nope", {}, {})
    assert ctx["families"] == []
    assert ctx["defaultFiles"] == []
    assert ctx["periodFiles"] == []


# ── runSql ───────────────────────────────────────────────────────────────────


def test_run_sql_throws_on_empty_warehouse(db):
    seed_blueprint(db, "bp_1")
    ctx = build_copilot_context(db, "bp_1", {}, {})
    # No data ingested -> the warehouse error propagates (the engine catches, not us).
    with pytest.raises(Exception, match="no data ingested yet"):
        ctx["runSql"]("SELECT 1")


def test_run_sql_happy_binds_latest_period_and_formats(db, tmp_path, monkeypatch):
    import sqlite3

    seed_blueprint(db, "bp_1")
    wh_dir = tmp_path / "warehouses"
    wh_dir.mkdir()
    monkeypatch.setenv("RUNOFF_WAREHOUSE_DIR", str(wh_dir))
    wh = sqlite3.connect(str(wh_dir / "proj_1.db"))
    wh.execute('CREATE TABLE fam_revenue (amount INTEGER, "_period" TEXT NOT NULL)')
    wh.executemany(
        'INSERT INTO fam_revenue (amount, "_period") VALUES (?, ?)',
        [(100, "2026-Q1"), (250, "2026-Q2")],
    )
    wh.commit()
    wh.close()

    ctx = build_copilot_context(db, "bp_1", {}, {})
    # latest filed period is 2026-Q2 (MAX over sources); :period binds to it.
    out = ctx["runSql"]('SELECT amount FROM fam_revenue WHERE "_period" = :period')
    assert out == "amount\n250"


# ── listRuns ─────────────────────────────────────────────────────────────────


def _insert_run(db, run_id, *, created_at, status="complete", stats=None, rev=1, blueprint_id="bp_1"):
    db.execute(
        "INSERT INTO runs (id, blueprint_id, blueprint_rev, status, stats, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (run_id, blueprint_id, rev, status, stats, created_at),
    )


def test_list_runs_shape_order_and_limit(db):
    seed_blueprint(db, "bp_1")
    for i in range(12):
        _insert_run(db, f"run_{i:02d}", created_at=f"2026-01-{i + 1:02d}", stats=None, rev=i)
    # a run on another blueprint must not leak in
    db.execute("INSERT INTO blueprints (id, name, project_id) VALUES ('bp_2', 'X', 'proj_1')")
    _insert_run(db, "run_other", created_at="2026-12-31", blueprint_id="bp_2")
    # one run carries JSON stats and one open flag
    db.execute("UPDATE runs SET stats = ? WHERE id = 'run_11'", (json.dumps({"words": 5}),))
    db.execute(
        "INSERT INTO flags (id, run_id, code, section_key, question, options) "
        "VALUES ('fl_1', 'run_11', 'C', 'a', 'q?', '[]')"
    )

    ctx = build_copilot_context(db, "bp_1", {}, {})
    runs = ctx["listRuns"]()
    assert len(runs) == 10  # LIMIT 10
    assert [r["id"] for r in runs][:2] == ["run_11", "run_10"]  # newest first
    assert all(r["id"] != "run_other" for r in runs)
    top = runs[0]
    assert set(top.keys()) == {"id", "createdAt", "status", "stats", "rev", "flagCount"}
    assert top["stats"] == {"words": 5}
    assert top["flagCount"] == 1
    assert top["rev"] == 11
    assert runs[1]["stats"] is None


# ── getRunSection ────────────────────────────────────────────────────────────


def _run_with_doc(db, run_id, doc, *, blueprint_id="bp_1"):
    db.execute(
        "INSERT INTO runs (id, blueprint_id, blueprint_rev, status, document) "
        "VALUES (?, ?, 1, 'complete', ?)",
        (run_id, blueprint_id, json.dumps(doc)),
    )


def _ev(db, run_id, seq, type_, payload):
    db.execute(
        "INSERT INTO run_events (run_id, seq, type, payload) VALUES (?, ?, ?, ?)",
        (run_id, seq, type_, json.dumps(payload)),
    )


def test_get_run_section_scopes_answers_by_raised_section(db):
    seed_blueprint(db, "bp_1")
    doc = {
        "title": "T", "eyebrow": "E", "dateline": "D",
        "sections": [
            {"key": "a", "heading": "A", "blocks": [{"type": "paragraph", "spans": [{"text": "Body A"}]}]},
            {"key": "b", "heading": "B", "blocks": []},
        ],
    }
    _run_with_doc(db, "run_1", doc)
    _ev(db, "run_1", 1, "question_raised",
        {"questionId": "q_1", "sectionKey": "a", "question": "Which fiscal year?"})
    _ev(db, "run_1", 2, "question_answered", {"questionId": "q_1", "answer": "FY2026"})
    # an answer whose question was raised in section b must be excluded from a
    _ev(db, "run_1", 3, "question_raised",
        {"questionId": "q_2", "sectionKey": "b", "question": "For B?"})
    _ev(db, "run_1", 4, "question_answered", {"questionId": "q_2", "answer": "nope"})
    _ev(db, "run_1", 5, "check_failed", {"sectionKey": "a", "detail": "too long"})
    _ev(db, "run_1", 6, "retry_started", {"sectionKey": "a", "reason": "retry"})
    _ev(db, "run_1", 7, "steer_received", {"sectionKey": "a", "text": "steer it"})
    db.execute(
        "INSERT INTO flags (id, run_id, code, section_key, question, options, status, resolution) "
        "VALUES ('fl_a', 'run_1', 'C', 'a', 'flag q', '[]', 'open', NULL)"
    )

    ctx = build_copilot_context(db, "bp_1", {}, {})
    section_a = ctx["getRunSection"]("run_1", "a")
    assert section_a["text"] == "Body A"
    assert section_a["answers"] == [{"question": "Which fiscal year?", "answer": "FY2026"}]
    assert section_a["checkFailures"] == ["too long"]
    assert section_a["retryReasons"] == ["retry"]
    assert section_a["steers"] == ["steer it"]
    assert section_a["flags"] == [{"question": "flag q", "status": "open", "resolution": None}]

    section_b = ctx["getRunSection"]("run_1", "b")
    assert section_b["answers"] == [{"question": "For B?", "answer": "nope"}]
    assert section_b["checkFailures"] == []


def test_get_run_section_rejects_foreign_or_missing(db):
    seed_blueprint(db, "bp_1")
    db.execute("INSERT INTO blueprints (id, name, project_id) VALUES ('bp_2', 'X', 'proj_1')")
    _run_with_doc(db, "run_foreign", {"sections": [{"key": "a", "heading": "A", "blocks": []}]},
                  blueprint_id="bp_2")
    ctx = build_copilot_context(db, "bp_1", {}, {})
    # run belongs to a different blueprint -> None
    assert ctx["getRunSection"]("run_foreign", "a") is None
    # unknown run -> None; unknown section -> None
    assert ctx["getRunSection"]("nope", "a") is None


# ── listGoldens / getGolden / scaffoldDigest ─────────────────────────────────


def test_list_goldens_delegates(db):
    seed_blueprint(db, "bp_1")
    db.execute(
        "INSERT INTO goldens (id, blueprint_id, kind, name) VALUES ('g1', 'bp_1', 'exemplar', 'First')"
    )
    ctx = build_copilot_context(db, "bp_1", {}, {})
    goldens = ctx["listGoldens"]()
    assert [g["id"] for g in goldens] == ["g1"]
    assert goldens[0]["kind"] == "exemplar"


def test_get_golden_and_scaffold_digest_hit_and_miss(db):
    seed_blueprint(db, "bp_1")
    golden_cache = {"g1": {"description": "d", "text": "t"}}
    scaffold_cache = {"g1": "SCAFFOLD DIGEST — golden ..."}
    ctx = build_copilot_context(db, "bp_1", golden_cache, scaffold_cache)
    assert ctx["getGolden"]("g1") == {"description": "d", "text": "t"}
    assert ctx["getGolden"]("nope") is None
    assert ctx["scaffoldDigest"]("g1") == "SCAFFOLD DIGEST — golden ..."
    assert ctx["scaffoldDigest"]("nope") == "golden not found: nope"


# ── saveMemory ───────────────────────────────────────────────────────────────


def test_save_memory_inserts_and_slices_to_500(db):
    seed_blueprint(db, "bp_1")
    ctx = build_copilot_context(db, "bp_1", {}, {})
    mem_id = ctx["saveMemory"]("x" * 600, "blueprint")
    assert mem_id.startswith("mem")
    row = db.execute(
        "SELECT scope, project_id, blueprint_id, body, source FROM memories WHERE id = ?", (mem_id,)
    ).fetchone()
    assert row["scope"] == "blueprint"
    assert row["blueprint_id"] == "bp_1"
    assert row["project_id"] == "proj_1"
    assert row["source"] == "copilot"
    assert len(row["body"]) == 500


def test_save_memory_project_scope_nulls_blueprint(db):
    seed_blueprint(db, "bp_1")
    ctx = build_copilot_context(db, "bp_1", {}, {})
    mem_id = ctx["saveMemory"]("proj memo", "project")
    row = db.execute(
        "SELECT scope, project_id, blueprint_id FROM memories WHERE id = ?", (mem_id,)
    ).fetchone()
    assert row["scope"] == "project"
    assert row["project_id"] == "proj_1"
    assert row["blueprint_id"] is None


def test_save_memory_evicts_oldest_active_at_cap_30(db):
    seed_blueprint(db, "bp_1")
    for i in range(30):
        db.execute(
            "INSERT INTO memories (id, scope, project_id, blueprint_id, body, source, status) "
            "VALUES (?, 'blueprint', 'proj_1', 'bp_1', ?, 'copilot', 'active')",
            (f"m_{i:02d}", f"mem {i}"),
        )
    ctx = build_copilot_context(db, "bp_1", {}, {})
    new_mem = ctx["saveMemory"]("new one", "blueprint")

    active = db.execute(
        "SELECT COUNT(*) AS n FROM memories WHERE blueprint_id='bp_1' AND status='active'"
    ).fetchone()["n"]
    assert active == 30
    oldest = db.execute("SELECT status FROM memories WHERE id='m_00'").fetchone()["status"]
    assert oldest == "disabled"
    newest = db.execute("SELECT status FROM memories WHERE id=?", (new_mem,)).fetchone()["status"]
    assert newest == "active"
