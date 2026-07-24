"""Ports the `copilotTurn` describe block of packages/engine/test/copilot.test.ts.

Every TS case drives its assertions through `copilotTurn`; this file twins them
through the real `copilot_turn` streaming loop (Task 10), using `make_fake_client`
streaming scripts that mirror the TS `makeFakeClient` scripts. The tool-executor
behaviours are also exercised directly in `test_copilot_tools.py` (Task 9); here
they run end-to-end through the loop, so the loop's wiring — packs built up front,
`tool_activity` emitted + action appended before execution, capped tool results
fed back, the 12-round cap + single nudge, and the post-nudge hard stop — is
covered as well.
"""

from __future__ import annotations

from types import SimpleNamespace

from runoff_api.engine.copilot import copilot_turn
from tests.fake_client import make_fake_client

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
        "defaultFiles": [],
        "periodFiles": [],
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


def collect():
    events: list[dict] = []
    return events, SimpleNamespace(emit=events.append)


def recording(script):
    """Wrap the fake client so tests can read back the tool RESULT strings the loop
    feeds the model. `messages` is mutated in place by copilot_turn, so capturing
    any create call's list reference exposes every role:"tool" message written."""
    base = make_fake_client(script)
    inner = base.chat.completions.create
    captured: dict = {"messages": []}

    def create(**params):
        captured["messages"] = params["messages"]
        return inner(**params)

    base.chat.completions = SimpleNamespace(create=create)

    def tool_results():
        return [m["content"] for m in captured["messages"] if m.get("role") == "tool"]

    return base, tool_results, lambda: captured["messages"]


FAMILIES = [
    {"id": "fam_rev", "key": "revenue", "label": "Revenue", "kind": "periodic",
     "granularity": "quarter", "filedPeriods": ["2026-Q1", "2026-Q2"], "hasLiveFile": False, "bound": True},
    {"id": "fam_ref", "key": "pricebook", "label": "Price book", "kind": "constant",
     "granularity": None, "filedPeriods": [], "hasLiveFile": True, "bound": True},
    {"id": "fam_un", "key": "leftover", "label": "Leftover", "kind": "periodic",
     "granularity": "month", "filedPeriods": [], "hasLiveFile": False, "bound": False},
]


# --- edit / add / remove / masthead / memory -------------------------------

def test_applies_valid_edit_section_patch():
    client = make_fake_client([
        [{"toolUse": {"name": "edit_section",
                      "input": {"key": "exec", "patch": {"instruction": "Summarize the quarter in three sentences."}}}}],  # noqa: E501
        [{"text": "Tightened the exec summary instruction."}],
    ])
    events, io = collect()
    res = copilot_turn(
        client=client, draft=CONTENT, selected_key="exec", message="tighten the exec instruction",
        thread=[], memories=[], ctx=make_ctx(), io=io,
    )
    edit = next(e for e in events if e["type"] == "edit")
    assert edit["op"]["type"] == "edit_section"
    assert edit["op"]["key"] == "exec"
    assert edit["op"]["before"]["instruction"] == "Summarize."
    assert edit["op"]["after"]["instruction"] == "Summarize the quarter in three sentences."
    assert res["draft"]["sections"][0]["instruction"] == "Summarize the quarter in three sentences."
    assert res["reply"] == "Tightened the exec summary instruction."
    assert any(a["kind"] == "edit" for a in res["actions"])
    # Every executed tool announces itself first.
    assert any(e["type"] == "tool_activity" for e in events)
    # Input draft is not mutated (deep-copied up front).
    assert CONTENT["sections"][0]["instruction"] == "Summarize."


def test_rejects_invalid_patch_as_tool_error():
    client = make_fake_client([
        [{"toolUse": {"name": "edit_section", "input": {"key": "exec", "patch": {"mode": "bogus"}}}}],
        [{"text": "That mode is not valid."}],
    ])
    events, io = collect()
    res = copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="break it",
        thread=[], memories=[], ctx=make_ctx(), io=io,
    )
    assert not any(e["type"] == "edit" for e in events)
    assert res["draft"]["sections"][0]["instruction"] == "Summarize."
    assert res["reply"] == "That mode is not valid."


def test_add_section_inserts_and_renumbers_remove_carries_after_key():
    client = make_fake_client([
        [{"toolUse": {"name": "add_section", "input": {
            "afterKey": "exec",
            "section": {"key": "kpis", "heading": "KPI summary", "mode": "auto",
                        "instruction": "Key metrics.", "familyIds": [], "queries": [], "rules": []},
        }}}],
        [{"toolUse": {"name": "remove_section", "input": {"key": "budget"}}}],
        [{"text": "Done."}],
    ])
    events, io = collect()
    res = copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="restructure",
        thread=[], memories=[], ctx=make_ctx(), io=io,
    )
    assert [s["key"] for s in res["draft"]["sections"]] == ["exec", "kpis"]
    assert [s["number"] for s in res["draft"]["sections"]] == [1, 2]
    remove_op = next(e["op"] for e in events if e["type"] == "edit" and e["op"]["type"] == "remove_section")
    assert remove_op["afterKey"] == "kpis"  # budget's predecessor at removal time
    assert remove_op["removed"]["key"] == "budget"


def test_save_memory_passes_scope_and_emits_event():
    saved = {}
    client = make_fake_client([
        [{"toolUse": {"name": "save_memory", "input": {"body": "Always use GBP.", "scope": "project"}}}],
        [{"text": "Noted."}],
    ])
    events, io = collect()
    copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="remember that",
        thread=[], memories=[],
        ctx=make_ctx(saveMemory=lambda b, s: (saved.update(body=b, scope=s), "mem_42")[1]), io=io,
    )
    assert saved == {"body": "Always use GBP.", "scope": "project"}
    assert next(e for e in events if e["type"] == "memory_saved") == {
        "type": "memory_saved", "memoryId": "mem_42", "body": "Always use GBP."}


def test_save_memory_defaults_missing_or_invalid_scope_to_blueprint():
    scopes = []
    client = make_fake_client([
        [{"toolUse": {"name": "save_memory", "input": {"body": "No scope."}}}],
        [{"toolUse": {"name": "save_memory", "input": {"body": "Bad scope.", "scope": "global"}}}],
        [{"text": "Noted."}],
    ])
    _, io = collect()
    copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="remember that",
        thread=[], memories=[],
        ctx=make_ctx(saveMemory=lambda b, s: (scopes.append(s), "mem_1")[1]), io=io,
    )
    assert scopes == ["blueprint", "blueprint"]


# --- turn-loop machinery (the Task 10 deferred cases) ----------------------

def test_streams_text_deltas_and_caps_the_loop_at_12_iterations_with_wrapup():
    # 13 scripted tool turns; the fake client repeats its last script entry, so
    # iteration 13 would also tool-call — the cap must inject the wrap-up nudge
    # and accept the next text turn instead.
    tool_turn = [{"toolUse": {"name": "query_sources", "input": {}}}]
    script = [tool_turn for _ in range(13)]
    script.append([{"text": "Here is what I found."}])
    client, tool_results, messages = recording(script)
    events, io = collect()
    res = copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="dig around",
        thread=[], memories=[], ctx=make_ctx(), io=io,
    )
    assert res["reply"] == "Here is what I found."
    assert len([e for e in events if e["type"] == "text_delta"]) > 0
    # Exactly 12 tool-executing rounds run before the wrap-up nudge fires.
    assert len([e for e in events if e["type"] == "tool_activity"]) == 12
    assert len([a for a in res["actions"] if a["kind"] == "tool"]) == 12
    # 12 executed query_sources results, then exactly one wrap-up nudge message.
    results = tool_results()
    assert results.count("No data families in this project.") == 12
    nudge = "Tool budget for this turn is exhausted. Summarize what you have and finish your reply now."
    assert results.count(nudge) == 1
    # The nudge round appends an assistant message whose content is None (the
    # capped round streamed no text) carrying the still-pending tool_calls.
    nudge_asst = [m for m in messages() if m["role"] == "assistant" and m.get("content") is None]
    assert nudge_asst and nudge_asst[-1]["tool_calls"][0]["function"]["name"] == "query_sources"


def test_hard_stops_after_one_nudge_when_model_keeps_calling_tools_forever():
    # The fake client repeats its last script entry forever, so every turn is a
    # tool call. After 12 tool rounds the loop nudges once; the next turn is still
    # a tool call, so the loop must terminate instead of re-nudging or executing.
    client = make_fake_client([[{"toolUse": {"name": "query_sources", "input": {}}}]])
    events, io = collect()
    res = copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="loop forever",
        thread=[], memories=[], ctx=make_ctx(), io=io,
    )
    # Resolved (did not hang) with exactly 12 tool rounds; the post-nudge round
    # executed no tool (no 13th tool_activity).
    assert res is not None
    assert len([e for e in events if e["type"] == "tool_activity"]) == 12


# --- query_sources ---------------------------------------------------------

def test_query_sources_no_args_family_tree_with_trailer():
    client, tool_results, _ = recording([
        [{"toolUse": {"name": "query_sources", "input": {}}}],
        [{"text": "There you go."}],
    ])
    _, io = collect()
    copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="what data is there",
        thread=[], memories=[], ctx=make_ctx(families=FAMILIES), io=io,
    )
    tree = tool_results()[0]
    assert "revenue · periodic · quarter · periods: 2026-Q1 ✓, 2026-Q2 ✓" in tree
    assert "pricebook · constant · live file ✓" in tree
    assert "Not bound to this blueprint:" in tree
    assert "leftover · periodic · month · no data yet" in tree
    assert tree.index("revenue") < tree.index("Not bound to this blueprint:")
    assert tree.index("Not bound to this blueprint:") < tree.index("leftover")


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
    client, tool_results, _ = recording([
        [{"toolUse": {"name": "query_sources", "input": {"familyId": "fam_rev", "period": None}}}],
        [{"toolUse": {"name": "query_sources", "input": {"familyId": "fam_rev", "period": "2026-Q1"}}}],
        [{"toolUse": {"name": "query_sources", "input": {"familyId": "fam_rev", "period": "2026-Q4"}}}],
        [{"text": "Done inspecting."}],
    ])
    _, io = collect()
    copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="inspect revenue",
        thread=[], memories=[],
        ctx=make_ctx(families=FAMILIES, defaultFiles=default_files, periodFiles=period_files), io=io,
    )
    default_out, q1_out, bad = tool_results()
    assert "250" in default_out  # default resolution = latest period (Q2)
    assert "100" in q1_out  # period-addressed Q1
    assert "250" not in q1_out
    assert bad == "Tool error: no file for revenue at 2026-Q4"


def test_edit_section_rejects_unbound_family_ids():
    client, tool_results, _ = recording([
        [{"toolUse": {"name": "edit_section", "input": {"key": "budget", "patch": {"familyIds": ["fam_unbound"]}}}}],  # noqa: E501
        [{"text": "That family is not bound."}],
    ])
    events, io = collect()
    res = copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="bind leftover",
        thread=[], memories=[], ctx=make_ctx(families=FAMILIES), io=io,
    )
    assert tool_results()[0] == "Tool error: family not bound to this blueprint: fam_unbound"
    assert not any(e["type"] == "edit" for e in events)
    assert res["draft"]["sections"][1]["familyIds"] == ["src_data"]


def test_run_sql_returns_executor_formatted_result():
    calls = []
    client, tool_results, _ = recording([
        [{"toolUse": {"name": "run_sql", "input": {"sql": "SELECT a, b FROM fam_x"}}}],
        [{"text": "Here are the rows."}],
    ])
    _, io = collect()
    copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="run a query",
        thread=[], memories=[],
        ctx=make_ctx(runSql=lambda sql: (calls.append(sql), "a | b\n1 | 2")[1]), io=io,
    )
    assert calls == ["SELECT a, b FROM fam_x"]
    assert tool_results()[0] == "a | b\n1 | 2"


def test_run_sql_result_at_cap_passes_through_clamp_intact():
    # formatSqlResult caps its output at 10_000 chars and appends a contractual
    # "… truncated at N of M rows" line. The loop's tool-result clamp (10_100)
    # must not clip such a result — doing so would drop the truncation line and
    # leave a mangled trailing number the model could read as real data.
    trunc_line = "… truncated at 200 of 500 rows"
    stub = "x" * (9_500 - len(trunc_line)) + trunc_line
    assert len(stub) == 9_500
    client, tool_results, _ = recording([
        [{"toolUse": {"name": "run_sql", "input": {"sql": "SELECT * FROM fam_x"}}}],
        [{"text": "Here are the rows."}],
    ])
    _, io = collect()
    copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="run a big query",
        thread=[], memories=[], ctx=make_ctx(runSql=lambda sql: stub), io=io,
    )
    assert tool_results()[0] == stub
    assert tool_results()[0].endswith(trunc_line)


def test_run_sql_failures_surface_as_tool_error():
    client, tool_results, _ = recording([
        [{"toolUse": {"name": "run_sql", "input": {"sql": "SELECT 1"}}}],
        [{"text": "No data yet."}],
    ])
    _, io = collect()
    copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="run a query",
        thread=[], memories=[],
        ctx=make_ctx(runSql=lambda sql: _raise("no data ingested yet")), io=io,
    )
    assert tool_results()[0] == "Tool error: sql: no data ingested yet"


def test_query_sources_tree_appends_table_lines_for_queryable():
    client, tool_results, _ = recording([
        [{"toolUse": {"name": "query_sources", "input": {}}}],
        [{"text": "There you go."}],
    ])
    _, io = collect()
    copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="what data is there",
        thread=[], memories=[],
        ctx=make_ctx(
            families=[fam_info(key="spend", bound=True)],
            catalog=[cat_fam(key="spend", queryable=True,
                             tables=[{"name": "fam_spend", "columns": [{"name": "amount", "type": "REAL"}], "rowCounts": {"2026-Q1": 2}}])],  # noqa: E501
        ), io=io,
    )
    tree = tool_results()[0]
    assert "spend · periodic" in tree
    assert "fam_spend(amount REAL)" in tree


def test_query_sources_inspect_queryable_returns_schema_and_sample():
    calls = []
    cat = cat_fam(id="fam_1", key="spend", queryable=True,
                  tables=[{"name": "fam_spend", "columns": [{"name": "amount", "type": "REAL"}], "rowCounts": {"2026-Q1": 2}}])  # noqa: E501
    fams = [fam_info(id="fam_1", key="spend", kind="periodic", filedPeriods=["2026-Q1"], bound=True)]
    client, tool_results, _ = recording([
        [{"toolUse": {"name": "query_sources", "input": {"familyId": "fam_1", "period": "2026-Q1"}}}],
        [{"toolUse": {"name": "query_sources", "input": {"familyId": "fam_1", "period": "2026-Q3"}}}],
        [{"text": "Done inspecting."}],
    ])
    _, io = collect()
    copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="inspect spend",
        thread=[], memories=[],
        ctx=make_ctx(families=fams, catalog=[cat], runSql=lambda sql: (calls.append(sql), "amount\n1")[1]), io=io,  # noqa: E501
    )
    assert calls == ["SELECT * FROM fam_spend WHERE _period = '2026-Q1' LIMIT 10"]
    ok, miss = tool_results()
    assert "amount\n1" in ok
    assert miss == "Tool error: no file for spend at 2026-Q3"


# --- update_section_queries / add_section validation -----------------------

def test_update_section_queries_validates_dry_runs_commits_and_is_invertible():
    calls = []
    client = make_fake_client([
        [{"toolUse": {"name": "update_section_queries", "input": {
            "sectionKey": "exec", "queries": [{"name": "total", "sql": "SELECT 1", "description": None}]}}}],
        [{"text": "Baked the total query."}],
    ])
    events, io = collect()
    res = copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="bake a query",
        thread=[], memories=[],
        ctx=make_ctx(runSql=lambda sql: (calls.append(sql), "1")[1]), io=io,
    )
    assert calls == ["SELECT 1"]  # dry-run once
    edit = next(e for e in events if e["type"] == "edit")
    assert edit["op"]["type"] == "update_section_queries"
    assert edit["op"]["sectionKey"] == "exec"
    assert edit["op"]["before"] == []
    assert edit["op"]["after"] == [{"name": "total", "sql": "SELECT 1"}]
    assert res["draft"]["sections"][0]["queries"] == [{"name": "total", "sql": "SELECT 1"}]


def test_update_section_queries_rejects_bad_names_and_failing_sql():
    def run(sql):
        if sql == "SELECT * FROM x":
            raise Exception("no such table: x")
        return "1"
    client, tool_results, _ = recording([
        [{"toolUse": {"name": "update_section_queries", "input": {
            "sectionKey": "exec", "queries": [{"name": "Total Paid", "sql": "SELECT 1", "description": None}]}}}],  # noqa: E501
        [{"toolUse": {"name": "update_section_queries", "input": {
            "sectionKey": "exec", "queries": [{"name": "total", "sql": "SELECT * FROM x", "description": None}]}}}],  # noqa: E501
        [{"toolUse": {"name": "update_section_queries", "input": {
            "sectionKey": "exec", "queries": [
                {"name": "total", "sql": "SELECT 1", "description": None},
                {"name": "total", "sql": "SELECT 2", "description": None}]}}}],
        [{"text": "Fixed."}],
    ])
    _, io = collect()
    copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="bake queries",
        thread=[], memories=[], ctx=make_ctx(runSql=run), io=io,
    )
    bad_name, fail_sql, dup = tool_results()
    assert bad_name == "Tool error: invalid query name: Total Paid"
    assert fail_sql == "Tool error: invalid query total: no such table: x"
    assert dup == "Tool error: invalid query name: total"


def test_add_section_strips_nested_query_and_rule_nulls():
    calls = []
    client = make_fake_client([
        [{"toolUse": {"name": "add_section", "input": {
            "afterKey": "exec",
            "section": {
                "key": "metrics", "heading": "Metrics", "mode": "auto", "instruction": "Cover metrics.",
                "fixedText": None, "familyIds": [],
                "queries": [{"name": "total", "sql": "SELECT 1", "description": None}],
                "rules": [{"kind": "style", "text": "Be concise.", "sql": None, "op": None, "value": None, "withinPct": None}],  # noqa: E501
            },
        }}}],
        [{"text": "Added."}],
    ])
    events, io = collect()
    res = copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="add a metrics section",
        thread=[], memories=[],
        ctx=make_ctx(runSql=lambda sql: (calls.append(sql), "1")[1]), io=io,
    )
    assert calls == ["SELECT 1"]  # dry-run once before commit
    added = next(s for s in res["draft"]["sections"] if s["key"] == "metrics")
    assert added["queries"] == [{"name": "total", "sql": "SELECT 1"}]
    assert added["rules"] == [{"kind": "style", "text": "Be concise."}]
    assert any(e["type"] == "edit" and e["op"]["type"] == "add_section" for e in events)


def test_add_section_rejects_failing_sql():
    def run(sql):
        if sql == "SELECT * FROM x":
            raise Exception("no such table: x")
        return "1"
    client, tool_results, _ = recording([
        [{"toolUse": {"name": "add_section", "input": {
            "afterKey": None,
            "section": {
                "key": "metrics", "heading": "Metrics", "mode": "auto", "instruction": "Cover metrics.",
                "fixedText": None, "familyIds": [],
                "queries": [{"name": "total", "sql": "SELECT * FROM x", "description": None}], "rules": [],
            },
        }}}],
        [{"text": "Fixed."}],
    ])
    events, io = collect()
    res = copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="add metrics",
        thread=[], memories=[], ctx=make_ctx(runSql=run), io=io,
    )
    assert tool_results()[0] == "Tool error: invalid query total: no such table: x"
    assert [s["key"] for s in res["draft"]["sections"]] == ["exec", "budget"]
    assert not any(e["type"] == "edit" for e in events)


def test_add_section_rejects_bad_query_name():
    client, tool_results, _ = recording([
        [{"toolUse": {"name": "add_section", "input": {
            "afterKey": None,
            "section": {
                "key": "metrics", "heading": "Metrics", "mode": "auto", "instruction": "Cover metrics.",
                "fixedText": None, "familyIds": [],
                "queries": [{"name": "Total Paid", "sql": "SELECT 1", "description": None}], "rules": [],
            },
        }}}],
        [{"text": "Fixed."}],
    ])
    events, io = collect()
    res = copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="add metrics",
        thread=[], memories=[], ctx=make_ctx(runSql=lambda sql: "1"), io=io,
    )
    assert tool_results()[0] == "Tool error: invalid query name: Total Paid"
    assert [s["key"] for s in res["draft"]["sections"]] == ["exec", "budget"]
    assert not any(e["type"] == "edit" for e in events)


def test_compute_is_no_longer_a_tool():
    # `compute` (agg-over-pack) is retired: the warehouse owns tabular data, so
    # the CSV pack it read no longer exists. A call falls through to the unknown-tool branch.
    client, tool_results, _ = recording([
        [{"toolUse": {"name": "compute", "input": {"expression": "sum(fam_rev.amount)"}}}],
        [{"text": "Computed."}],
    ])
    _, io = collect()
    copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="sum revenue",
        thread=[], memories=[], ctx=make_ctx(families=FAMILIES), io=io,
    )
    assert tool_results()[0] == "Tool error: unknown tool compute"


# --- get_golden_scaffold + its 20k clamp -----------------------------------

def test_get_golden_scaffold_returns_ctx_digest_verbatim():
    calls = []
    digest = 'SCAFFOLD DIGEST — golden "g" (period none, nothing to bind)'
    client, tool_results, _ = recording([
        [{"toolUse": {"name": "get_golden_scaffold", "input": {"goldenId": "g1"}}}],
        [{"text": "Scaffolded from the golden."}],
    ])
    _, io = collect()
    copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="scaffold sections from g1",
        thread=[], memories=[],
        ctx=make_ctx(scaffoldDigest=lambda gid: (calls.append(gid), digest)[1]), io=io,
    )
    assert calls == ["g1"]
    assert tool_results()[0] == digest


def test_clamps_get_golden_scaffold_results_at_20000_chars():
    client, tool_results, _ = recording([
        [{"toolUse": {"name": "get_golden_scaffold", "input": {"goldenId": "g1"}}}],
        [{"text": "Done."}],
    ])
    _, io = collect()
    copilot_turn(
        client=client, draft=CONTENT, selected_key=None, message="scaffold from a big golden",
        thread=[], memories=[], ctx=make_ctx(scaffoldDigest=lambda gid: "x" * 25_000), io=io,
    )
    assert len(tool_results()[0]) == 20_000
