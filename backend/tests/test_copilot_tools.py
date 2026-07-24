"""Ports the tool-executor cases of packages/engine/test/copilot.test.ts.

The TS suite is one `describe("copilotTurn")` block that drives every case
through `copilotTurn`. The turn loop is Task 10; here we exercise the same tool
behaviors directly through `execute_tool` (which is what the loop calls), plus
`copilot_system_prompt` and `activity_label`. Cases that test the loop mechanics
(text streaming, the 12-iteration cap, the one-nudge hard stop, and the
per-tool result clamp) are deferred to Task 10 — see the module docstring notes.
"""

from __future__ import annotations

import copy
from types import SimpleNamespace

from runoff_api.engine.copilot import (
    MAX_ITERATIONS,
    MAX_TOOL_RESULT_CHARS,
    activity_label,
    copilot_system_prompt,
    execute_tool,
)
from runoff_api.engine.source_pack import build_source_pack

CONTENT = {
    "title": "Monthly Performance Report",
    "clientName": "Meridian Retail",
    "eyebrow": "Marketing Performance",
    "dateline": "June 2026",
    "sections": [
        {"key": "exec", "number": 1, "heading": "Executive summary", "mode": "auto",
         "instruction": "Summarize.", "familyIds": [], "queries": [], "rules": []},
        {"key": "budget", "number": 2, "heading": "Budget", "mode": "auto",
         "instruction": "Cover spend.", "familyIds": ["src_data"], "queries": [], "rules": []},
    ],
    "globalRules": [],
    "delivery": {"recipient": "ops@example.com", "autoDeliverOnClear": False},
}


def _raise(msg):
    raise Exception(msg)


def make_ctx(**over):
    base = {
        "families": [],
        "catalog": [],
        "runSql": lambda sql: _raise("no data ingested yet"),
        "listRuns": lambda: [],
        "getRunSection": lambda run_id, key: None,
        "listGoldens": lambda: [],
        "getGolden": lambda i: None,
        "scaffoldDigest": lambda gid: "golden not found",
        "saveMemory": lambda body, scope: "mem_1",
    }
    base.update(over)
    return base


def make_state(ctx, draft=None, default_files=None, period_files=None):
    """Build the ToolState the turn loop would assemble: two packs, an io that
    collects events, and an actions list. Returns (state, events, actions)."""
    default_pack = build_source_pack(default_files or [])
    period_pack = build_source_pack(
        [{**p["file"], "id": f"{p['familyId']}:{p['period']}"} for p in (period_files or [])]
    )
    events: list[dict] = []
    actions: list[dict] = []
    io = SimpleNamespace(emit=events.append)
    state = {
        "draft": copy.deepcopy(draft if draft is not None else CONTENT),
        "default_pack": default_pack,
        "period_pack": period_pack,
        "ctx": ctx,
        "io": io,
        "actions": actions,
    }
    return state, events, actions


FAMILIES = [
    {"id": "fam_rev", "key": "revenue", "label": "Revenue", "kind": "periodic",
     "granularity": "quarter", "filedPeriods": ["2026-Q1", "2026-Q2"], "hasLiveFile": False, "bound": True},
    {"id": "fam_ref", "key": "pricebook", "label": "Price book", "kind": "constant",
     "granularity": None, "filedPeriods": [], "hasLiveFile": True, "bound": True},
    {"id": "fam_un", "key": "leftover", "label": "Leftover", "kind": "periodic",
     "granularity": "month", "filedPeriods": [], "hasLiveFile": False, "bound": False},
]


def fam_info(**over):
    base = {
        "id": f"fam_{over['key']}",
        "label": over["key"],
        "kind": "periodic",
        "granularity": "quarter",
        "filedPeriods": ["2026-Q1"],
        "hasLiveFile": False,
        "bound": False,
    }
    base.update(over)
    return base


def cat_fam(**over):
    base = {
        "id": f"fam_{over['key']}",
        "label": over["key"],
        "kind": "periodic",
        "granularity": "quarter",
        "queryable": False,
        "tables": [],
        "filedPeriods": [],
    }
    base.update(over)
    return base


# --- edit_section ----------------------------------------------------------

def test_edit_section_applies_valid_patch():
    state, events, actions = make_state(make_ctx())
    out = execute_tool(
        "edit_section",
        {"key": "exec", "patch": {"instruction": "Summarize the quarter in three sentences."}},
        state,
    )
    edit = next(e for e in events if e["type"] == "edit")
    assert edit["op"]["type"] == "edit_section"
    assert edit["op"]["key"] == "exec"
    assert edit["op"]["before"]["instruction"] == "Summarize."
    assert edit["op"]["after"]["instruction"] == "Summarize the quarter in three sentences."
    assert out["draft"]["sections"][0]["instruction"] == "Summarize the quarter in three sentences."
    assert out["result"] == "Edit applied."
    assert any(a["kind"] == "edit" for a in actions)


def test_edit_section_rejects_invalid_patch():
    state, events, _ = make_state(make_ctx())
    out = execute_tool("edit_section", {"key": "exec", "patch": {"mode": "bogus"}}, state)
    assert out["result"].startswith("Tool error: edit rejected")
    assert not any(e["type"] == "edit" for e in events)
    assert out["draft"]["sections"][0]["instruction"] == "Summarize."


def test_edit_section_rejects_unbound_family_ids():
    state, events, _ = make_state(make_ctx(families=FAMILIES))
    out = execute_tool("edit_section", {"key": "budget", "patch": {"familyIds": ["fam_unbound"]}}, state)
    assert out["result"] == "Tool error: family not bound to this blueprint: fam_unbound"
    assert not any(e["type"] == "edit" for e in events)
    assert out["draft"]["sections"][1]["familyIds"] == ["src_data"]


def test_edit_section_missing_key():
    state, _, _ = make_state(make_ctx())
    out = execute_tool("edit_section", {"key": "nope", "patch": {"instruction": "x"}}, state)
    assert out["result"] == "Tool error: no section with key nope"


def test_edit_section_empty_patch():
    state, _, _ = make_state(make_ctx())
    out = execute_tool("edit_section", {"key": "exec", "patch": {}}, state)
    assert out["result"] == "Tool error: empty patch"


# --- add_section / remove_section ------------------------------------------

def test_add_section_inserts_and_renumbers_then_remove_carries_after_key():
    state, events, _ = make_state(make_ctx())
    out1 = execute_tool(
        "add_section",
        {"afterKey": "exec", "section": {"key": "kpis", "heading": "KPI summary", "mode": "auto",
                                          "instruction": "Key metrics.", "familyIds": [], "queries": [], "rules": []}},  # noqa: E501
        state,
    )
    state["draft"] = out1["draft"]
    out2 = execute_tool("remove_section", {"key": "budget"}, state)
    assert [s["key"] for s in out2["draft"]["sections"]] == ["exec", "kpis"]
    assert [s["number"] for s in out2["draft"]["sections"]] == [1, 2]
    remove_op = next(e["op"] for e in events if e["type"] == "edit" and e["op"]["type"] == "remove_section")
    assert remove_op["afterKey"] == "kpis"  # budget's predecessor at removal time
    assert remove_op["removed"]["key"] == "budget"


def test_add_section_strips_nested_query_and_rule_nulls():
    calls = []
    ctx = make_ctx(runSql=lambda sql: (calls.append(sql), "1")[1])
    state, events, _ = make_state(ctx)
    out = execute_tool(
        "add_section",
        {"afterKey": "exec", "section": {
            "key": "metrics", "heading": "Metrics", "mode": "auto", "instruction": "Cover metrics.",
            "fixedText": None, "familyIds": [],
            "queries": [{"name": "total", "sql": "SELECT 1", "description": None}],
            "rules": [{"kind": "style", "text": "Be concise.", "sql": None, "op": None, "value": None, "withinPct": None}],  # noqa: E501
        }},
        state,
    )
    assert calls == ["SELECT 1"]  # dry-run once before commit
    added = next(s for s in out["draft"]["sections"] if s["key"] == "metrics")
    assert added["queries"] == [{"name": "total", "sql": "SELECT 1"}]
    assert added["rules"] == [{"kind": "style", "text": "Be concise."}]
    assert any(e["type"] == "edit" and e["op"]["type"] == "add_section" for e in events)


def test_add_section_rejects_failing_sql():
    def run(sql):
        if sql == "SELECT * FROM x":
            raise Exception("no such table: x")
        return "1"
    state, events, _ = make_state(make_ctx(runSql=run))
    out = execute_tool(
        "add_section",
        {"afterKey": None, "section": {
            "key": "metrics", "heading": "Metrics", "mode": "auto", "instruction": "Cover metrics.",
            "fixedText": None, "familyIds": [],
            "queries": [{"name": "total", "sql": "SELECT * FROM x", "description": None}], "rules": [],
        }},
        state,
    )
    assert out["result"] == "Tool error: invalid query total: no such table: x"
    assert [s["key"] for s in out["draft"]["sections"]] == ["exec", "budget"]
    assert not any(e["type"] == "edit" for e in events)


def test_add_section_rejects_bad_query_name():
    state, events, _ = make_state(make_ctx(runSql=lambda sql: "1"))
    out = execute_tool(
        "add_section",
        {"afterKey": None, "section": {
            "key": "metrics", "heading": "Metrics", "mode": "auto", "instruction": "Cover metrics.",
            "fixedText": None, "familyIds": [],
            "queries": [{"name": "Total Paid", "sql": "SELECT 1", "description": None}], "rules": [],
        }},
        state,
    )
    assert out["result"] == "Tool error: invalid query name: Total Paid"
    assert [s["key"] for s in out["draft"]["sections"]] == ["exec", "budget"]
    assert not any(e["type"] == "edit" for e in events)


def test_add_section_duplicate_key():
    state, _, _ = make_state(make_ctx())
    out = execute_tool(
        "add_section",
        {"afterKey": None, "section": {"key": "exec", "heading": "X", "mode": "auto",
                                       "instruction": "y", "familyIds": [], "queries": [], "rules": []}},
        state,
    )
    assert out["result"] == "Tool error: duplicate section key exec"


def test_add_section_unknown_after_key():
    state, _, _ = make_state(make_ctx())
    out = execute_tool(
        "add_section",
        {"afterKey": "nope", "section": {"key": "z", "heading": "X", "mode": "auto",
                                         "instruction": "y", "familyIds": [], "queries": [], "rules": []}},
        state,
    )
    assert out["result"] == "Tool error: no section with key nope"


def test_remove_section_missing_key():
    state, _, _ = make_state(make_ctx())
    out = execute_tool("remove_section", {"key": "nope"}, state)
    assert out["result"] == "Tool error: no section with key nope"


# --- update_masthead / update_global_rules ---------------------------------

def test_update_masthead_patches_and_is_invertible():
    state, events, _ = make_state(make_ctx())
    out = execute_tool("update_masthead", {"patch": {"title": "New Title"}}, state)
    op = next(e["op"] for e in events if e["type"] == "edit")
    assert op["type"] == "update_masthead"
    assert op["before"] == {"title": "Monthly Performance Report"}
    assert op["after"] == {"title": "New Title"}
    assert out["draft"]["title"] == "New Title"


def test_update_masthead_empty_patch():
    state, _, _ = make_state(make_ctx())
    out = execute_tool("update_masthead", {"patch": {}}, state)
    assert out["result"] == "Tool error: empty patch"


def test_update_global_rules_replaces_list():
    state, events, _ = make_state(make_ctx())
    out = execute_tool("update_global_rules", {"rules": ["Be terse.", 5, "Cite sources."]}, state)
    op = next(e["op"] for e in events if e["type"] == "edit")
    assert op["before"] == []
    assert op["after"] == ["Be terse.", "Cite sources."]  # non-strings filtered
    assert out["draft"]["globalRules"] == ["Be terse.", "Cite sources."]


# --- update_section_queries ------------------------------------------------

def test_update_section_queries_validates_dry_runs_commits():
    calls = []
    ctx = make_ctx(runSql=lambda sql: (calls.append(sql), "1")[1])
    state, events, _ = make_state(ctx)
    out = execute_tool(
        "update_section_queries",
        {"sectionKey": "exec", "queries": [{"name": "total", "sql": "SELECT 1", "description": None}]},
        state,
    )
    assert calls == ["SELECT 1"]
    op = next(e["op"] for e in events if e["type"] == "edit")
    assert op["type"] == "update_section_queries"
    assert op["sectionKey"] == "exec"
    assert op["before"] == []
    assert op["after"] == [{"name": "total", "sql": "SELECT 1"}]
    assert out["draft"]["sections"][0]["queries"] == [{"name": "total", "sql": "SELECT 1"}]


def test_update_section_queries_rejects_bad_names_and_failing_sql():
    def run(sql):
        if sql == "SELECT * FROM x":
            raise Exception("no such table: x")
        return "1"
    ctx = make_ctx(runSql=run)

    s1, _, _ = make_state(ctx)
    r1 = execute_tool("update_section_queries",
                      {"sectionKey": "exec", "queries": [{"name": "Total Paid", "sql": "SELECT 1", "description": None}]}, s1)  # noqa: E501
    assert r1["result"] == "Tool error: invalid query name: Total Paid"

    s2, _, _ = make_state(ctx)
    r2 = execute_tool("update_section_queries",
                      {"sectionKey": "exec", "queries": [{"name": "total", "sql": "SELECT * FROM x", "description": None}]}, s2)  # noqa: E501
    assert r2["result"] == "Tool error: invalid query total: no such table: x"

    s3, _, _ = make_state(ctx)
    r3 = execute_tool("update_section_queries", {"sectionKey": "exec", "queries": [
        {"name": "total", "sql": "SELECT 1", "description": None},
        {"name": "total", "sql": "SELECT 2", "description": None},
    ]}, s3)
    assert r3["result"] == "Tool error: invalid query name: total"


def test_update_section_queries_missing_section():
    state, _, _ = make_state(make_ctx())
    out = execute_tool("update_section_queries", {"sectionKey": "nope", "queries": []}, state)
    assert out["result"] == "Tool error: no section with key nope"


# --- query_sources ---------------------------------------------------------

def test_query_sources_no_args_family_tree_with_trailer():
    state, _, _ = make_state(make_ctx(families=FAMILIES))
    tree = execute_tool("query_sources", {}, state)["result"]
    assert "revenue · periodic · quarter · periods: 2026-Q1 ✓, 2026-Q2 ✓" in tree
    assert "pricebook · constant · live file ✓" in tree
    assert "Not bound to this blueprint:" in tree
    assert "leftover · periodic · month · no data yet" in tree
    assert tree.index("revenue") < tree.index("Not bound to this blueprint:")
    assert tree.index("Not bound to this blueprint:") < tree.index("leftover")


def test_query_sources_no_families():
    state, _, _ = make_state(make_ctx())
    out = execute_tool("query_sources", {}, state)
    assert out["result"] == "No data families in this project."


def test_query_sources_document_default_period_and_unknown(tmp_path):
    q1 = tmp_path / "q1.md"
    q2 = tmp_path / "q2.md"
    q1.write_text("Revenue notes: search brought 100 in Q1.\n")
    q2.write_text("Revenue notes: search brought 250 in Q2.\n")
    default_files = [{"id": "fam_rev", "name": "Revenue", "mime": "text/markdown", "path": str(q2)}]
    period_files = [
        {"familyId": "fam_rev", "period": "2026-Q1", "file": {"id": "fam_rev", "name": "Revenue", "mime": "text/markdown", "path": str(q1)}},  # noqa: E501
        {"familyId": "fam_rev", "period": "2026-Q2", "file": {"id": "fam_rev", "name": "Revenue", "mime": "text/markdown", "path": str(q2)}},  # noqa: E501
    ]
    ctx = make_ctx(families=FAMILIES)
    state, _, _ = make_state(ctx, default_files=default_files, period_files=period_files)

    default_out = execute_tool("query_sources", {"familyId": "fam_rev", "period": None}, state)["result"]
    q1_out = execute_tool("query_sources", {"familyId": "fam_rev", "period": "2026-Q1"}, state)["result"]
    bad_out = execute_tool("query_sources", {"familyId": "fam_rev", "period": "2026-Q4"}, state)["result"]

    assert "250" in default_out  # default resolution = latest period (Q2)
    assert "100" in q1_out  # period-addressed Q1
    assert "250" not in q1_out
    assert bad_out == "Tool error: no file for revenue at 2026-Q4"


def test_query_sources_tree_appends_table_lines_for_queryable():
    ctx = make_ctx(
        families=[fam_info(key="spend", bound=True)],
        catalog=[cat_fam(key="spend", queryable=True,
                         tables=[{"name": "fam_spend", "columns": [{"name": "amount", "type": "REAL"}], "rowCounts": {"2026-Q1": 2}}])],  # noqa: E501
    )
    state, _, _ = make_state(ctx)
    tree = execute_tool("query_sources", {}, state)["result"]
    assert "spend · periodic" in tree
    assert "fam_spend(amount REAL)" in tree


def test_query_sources_inspect_queryable_returns_schema_and_sample():
    calls = []
    cat = cat_fam(id="fam_1", key="spend", queryable=True,
                  tables=[{"name": "fam_spend", "columns": [{"name": "amount", "type": "REAL"}], "rowCounts": {"2026-Q1": 2}}])  # noqa: E501
    fams = [fam_info(id="fam_1", key="spend", kind="periodic", filedPeriods=["2026-Q1"], bound=True)]
    ctx = make_ctx(families=fams, catalog=[cat], runSql=lambda sql: (calls.append(sql), "amount\n1")[1])
    state, _, _ = make_state(ctx)
    ok = execute_tool("query_sources", {"familyId": "fam_1", "period": "2026-Q1"}, state)["result"]
    miss = execute_tool("query_sources", {"familyId": "fam_1", "period": "2026-Q3"}, state)["result"]
    assert calls == ["SELECT * FROM fam_spend WHERE _period = '2026-Q1' LIMIT 10"]
    assert "amount\n1" in ok
    assert miss == "Tool error: no file for spend at 2026-Q3"


# --- run_sql ---------------------------------------------------------------

def test_run_sql_returns_formatted_result():
    calls = []
    ctx = make_ctx(runSql=lambda sql: (calls.append(sql), "a | b\n1 | 2")[1])
    state, _, _ = make_state(ctx)
    out = execute_tool("run_sql", {"sql": "SELECT a, b FROM fam_x"}, state)
    assert calls == ["SELECT a, b FROM fam_x"]
    assert out["result"] == "a | b\n1 | 2"


def test_run_sql_failures_surface_as_tool_error():
    state, _, _ = make_state(make_ctx())  # default runSql throws "no data ingested yet"
    out = execute_tool("run_sql", {"sql": "SELECT 1"}, state)
    assert out["result"] == "Tool error: sql: no data ingested yet"


# --- goldens / memory / unknown --------------------------------------------

def test_get_golden_scaffold_returns_digest_verbatim():
    calls = []
    digest = 'SCAFFOLD DIGEST — golden "g" (period none, nothing to bind)'
    ctx = make_ctx(scaffoldDigest=lambda gid: (calls.append(gid), digest)[1])
    state, _, _ = make_state(ctx)
    out = execute_tool("get_golden_scaffold", {"goldenId": "g1"}, state)
    assert calls == ["g1"]
    assert out["result"] == digest


def test_save_memory_passes_scope_and_emits_event():
    saved = {}
    ctx = make_ctx(saveMemory=lambda b, s: (saved.update(body=b, scope=s), "mem_42")[1])
    state, events, actions = make_state(ctx)
    out = execute_tool("save_memory", {"body": "Always use GBP.", "scope": "project"}, state)
    assert saved == {"body": "Always use GBP.", "scope": "project"}
    assert out["result"] == "Memory saved."
    assert next(e for e in events if e["type"] == "memory_saved") == {
        "type": "memory_saved", "memoryId": "mem_42", "body": "Always use GBP."}
    assert any(a["kind"] == "memory" and a["memoryId"] == "mem_42" for a in actions)


def test_save_memory_defaults_missing_or_invalid_scope_to_blueprint():
    scopes = []
    ctx = make_ctx(saveMemory=lambda b, s: (scopes.append(s), "mem_1")[1])
    s1, _, _ = make_state(ctx)
    execute_tool("save_memory", {"body": "No scope."}, s1)
    s2, _, _ = make_state(ctx)
    execute_tool("save_memory", {"body": "Bad scope.", "scope": "global"}, s2)
    assert scopes == ["blueprint", "blueprint"]


def test_save_memory_empty_body():
    state, _, _ = make_state(make_ctx())
    out = execute_tool("save_memory", {"body": "   "}, state)
    assert out["result"] == "Tool error: empty memory body"


def test_list_runs_and_goldens_empty():
    state, _, _ = make_state(make_ctx())
    assert execute_tool("list_runs", {}, state)["result"] == "No runs yet."
    assert execute_tool("list_goldens", {}, state)["result"] == "No goldens yet."


def test_list_runs_formats_stats():
    runs = [{"id": "run_1", "createdAt": "2026-01-01", "status": "complete", "rev": 3, "flagCount": 2,
             "stats": {"citationCount": 5, "checksFailed": 1, "retries": 4}}]
    state, _, _ = make_state(make_ctx(listRuns=lambda: runs))
    out = execute_tool("list_runs", {}, state)
    assert out["result"] == "run_1 · 2026-01-01 · complete · rev 3 · 5 citations, 1 failed checks, 2 flags, 4 retries"  # noqa: E501


def test_get_run_section_not_found_and_detail():
    state, _, _ = make_state(make_ctx())
    assert execute_tool("get_run_section", {"runId": "r", "key": "k"}, state)["result"] == "Tool error: run or section not found"  # noqa: E501

    detail = {"text": "Body text.", "checkFailures": ["bad figure"], "retryReasons": ["retry x"],
              "steers": ["do y"], "answers": [{"question": "Q1", "answer": "A1"}],
              "flags": [{"question": "F1", "status": "open", "resolution": None}]}
    state2, _, _ = make_state(make_ctx(getRunSection=lambda run_id, key: detail))
    out = execute_tool("get_run_section", {"runId": "r", "key": "k"}, state2)
    assert out["result"] == (
        "Body text.\n\nCheck failures: bad figure\n\nRetries: retry x\n\nSteers: do y"
        "\n\nAnswers: Q: Q1 A: A1\n\nFlags: F1 [open]"
    )


def test_get_golden_not_found_and_hit():
    state, _, _ = make_state(make_ctx())
    assert execute_tool("get_golden", {"id": "g"}, state)["result"] == "Tool error: golden not found"
    state2, _, _ = make_state(make_ctx(getGolden=lambda i: {"description": "desc", "text": "the text"}))
    assert execute_tool("get_golden", {"id": "g"}, state2)["result"] == "desc\n\nthe text"


def test_unknown_tool_returns_error():
    # `compute` (agg-over-pack) is retired; a call falls through to the unknown-tool branch.
    state, _, _ = make_state(make_ctx(families=FAMILIES))
    out = execute_tool("compute", {"expression": "sum(fam_rev.amount)"}, state)
    assert out["result"] == "Tool error: unknown tool compute"


# --- activity_label --------------------------------------------------------

def test_activity_label_all_branches():
    fams = FAMILIES
    assert activity_label("edit_section", {"key": "exec"}, []) == "editing §exec"
    assert activity_label("edit_section", {}, []) == "editing §?"
    assert activity_label("add_section", {"section": {"heading": "KPIs"}}, []) == 'adding section "KPIs"'
    assert activity_label("add_section", {}, []) == 'adding section "?"'
    assert activity_label("remove_section", {"key": "budget"}, []) == "removing §budget"
    assert activity_label("update_masthead", {}, []) == "editing masthead"
    assert activity_label("update_global_rules", {}, []) == "editing global rules"
    assert activity_label("update_section_queries", {}, []) == "baking data queries"
    assert activity_label("query_sources", {}, fams) == "listing data families"
    assert activity_label("query_sources", {"familyId": "fam_rev"}, fams) == "reading revenue"
    assert activity_label("query_sources", {"familyId": "fam_rev", "period": "2026-Q1"}, fams) == "reading revenue @ 2026-Q1"  # noqa: E501
    assert activity_label("query_sources", {"familyId": "fam_unknown"}, fams) == "reading fam_unknown"
    assert activity_label("run_sql", {}, []) == "running SQL"
    assert activity_label("list_runs", {}, []) == "listing recent runs"
    assert activity_label("get_run_section", {"runId": "r1", "key": "k1"}, []) == "reading run r1 §k1"
    assert activity_label("get_run_section", {}, []) == "reading run ? §?"
    assert activity_label("list_goldens", {}, []) == "listing goldens"
    assert activity_label("get_golden", {"id": "g1"}, []) == "reading golden g1"
    assert activity_label("get_golden_scaffold", {"goldenId": "g1"}, []) == "scaffolding from golden g1"
    assert activity_label("save_memory", {}, []) == "saving a memory"
    assert activity_label("mystery", {}, []) == "mystery"


# --- copilot_system_prompt -------------------------------------------------

def test_system_prompt_embeds_draft_and_conditionals():
    from runoff_api.core.jsonutil import to_json

    catalog = [cat_fam(key="spend", queryable=True,
                       tables=[{"name": "fam_spend", "columns": [{"name": "amount", "type": "REAL"}], "rowCounts": {"2026-Q1": 2}}])]  # noqa: E501
    memories = [{"id": "m1", "scope": "project", "body": "Use GBP."}]
    prompt = copilot_system_prompt(CONTENT, "exec", memories, catalog)

    assert prompt.startswith("You are the builder copilot for a Runoff blueprint —")
    assert '\nThe user currently has section "exec" selected in the editor.' in prompt
    assert "\n\nData catalog (tables you can query with run_sql):\n" in prompt
    assert "fam_spend(amount REAL)" in prompt
    assert f"\n\nCurrent draft (JSON):\n{to_json(CONTENT)}" in prompt
    assert prompt.rstrip().endswith("- Use GBP.")


def test_system_prompt_omits_optional_blocks():
    from runoff_api.core.jsonutil import to_json

    prompt = copilot_system_prompt(CONTENT, None, [], [])
    assert "selected in the editor" not in prompt
    assert "Data catalog" not in prompt
    assert prompt.endswith(f"\n\nCurrent draft (JSON):\n{to_json(CONTENT)}")


# --- module constants ------------------------------------------------------

def test_constants():
    assert MAX_ITERATIONS == 12
    assert MAX_TOOL_RESULT_CHARS == 10_100
