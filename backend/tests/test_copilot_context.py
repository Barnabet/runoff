"""Port of the context-shape cases from apps/web/test/copilotApi.test.ts
(the `buildCopilotContext exposes the family tree...` case). The route-level
cases (SSE, persistence, memories, getRunSection/scaffoldDigest callbacks) land
in Task 11 with the copilot route/engine port.
"""

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
