"""Twin of packages/engine/test/bindGolden.test.ts (8 cases, snake_cased)."""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

from runoff_api.engine.bind_golden import bind_golden, render_doc_for_binding

DOC = {
    "title": "AR",
    "eyebrow": "",
    "dateline": "",
    "sections": [
        {
            "key": "summary",
            "heading": "Summary",
            "blocks": [
                {"type": "paragraph", "spans": [{"text": "Total "}, {"text": "$4.2M"}]},
                {
                    "type": "table",
                    "columns": ["status", "total"],
                    "rows": [{"cells": [[{"text": "open"}], [{"text": "1"}]]}],
                },
            ],
        }
    ],
}
CATALOG = [
    {
        "id": "fam_ar", "key": "ar", "label": "AR", "kind": "periodic", "granularity": "quarter",
        "queryable": True,
        "tables": [
            {"name": "fam_ar", "columns": [{"name": "amount", "type": "REAL"}], "rowCounts": {"2026-Q1": 10}}
        ],
        "filedPeriods": ["2026-Q1"],
    }
]
ITEMS = [
    {
        "id": "total", "kind": "value",
        "anchor": {"sectionKey": "summary", "blockIndex": 0, "spanIndex": 1},
        "raw": "$4.2M", "parsed": 4200000,
        "binding": {"familyId": "fam_ar", "sql": "SELECT SUM(amount) FROM fam_ar WHERE _period = :period"},
        "reason": None,
    }
]


def tool_msg(name: str, args: dict):
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                finish_reason="tool_calls",
                message=SimpleNamespace(
                    content=None,
                    tool_calls=[
                        SimpleNamespace(
                            id="c1", type="function",
                            function=SimpleNamespace(name=name, arguments=json.dumps(args)),
                        )
                    ],
                ),
            )
        ]
    )


def make_client(*responses):
    create = MagicMock(side_effect=list(responses))
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    return client, create


def test_render_doc_exposes_anchors():
    out = render_doc_for_binding(DOC)
    assert "## section: summary" in out
    assert '[b0.s1] "$4.2M"' in out
    assert "[b1] table (2 cols × 1 rows): status | total" in out


def test_runs_sql_probes_then_accepts_valid_submit():
    c, create = make_client(
        tool_msg("run_sql", {"sql": "SELECT SUM(amount) FROM fam_ar WHERE _period = :period"}),
        tool_msg("submit_inventory", {"version": 1, "items": ITEMS}),
    )
    run_sql = MagicMock(return_value="v\n4215332")
    out = bind_golden(client=c, catalog=CATALOG, run_sql=run_sql, document=DOC, period="2026-Q1", siblings=[])
    assert out["items"][0]["id"] == "total"
    assert run_sql.call_count == 1
    assert create.call_count == 2


def test_invalid_submit_byte_exact_error_and_loop_continues():
    bad = [{**ITEMS[0], "anchor": {"sectionKey": "nope", "blockIndex": 0, "spanIndex": 1}}]
    c, create = make_client(
        tool_msg("submit_inventory", {"version": 1, "items": bad}),
        tool_msg("submit_inventory", {"version": 1, "items": ITEMS}),
    )
    out = bind_golden(
        client=c, catalog=CATALOG, run_sql=MagicMock(), document=DOC, period="2026-Q1", siblings=[]
    )
    assert out is not None
    second_call_messages = create.call_args_list[1].kwargs["messages"]
    tool_result = next(m for m in reversed(second_call_messages) if m["role"] == "tool")
    assert tool_result["content"] == "Tool error: invalid inventory: unknown section: nope"


def test_siblings_prior_inventory_and_feedback_reach_prompt():
    c, create = make_client(tool_msg("submit_inventory", {"version": 1, "items": ITEMS}))
    bind_golden(
        client=c, catalog=CATALOG, run_sql=MagicMock(), document=DOC, period="2026-Q2",
        siblings=[
            {
                "period": "2026-Q1",
                "inventory": {
                    "version": 1,
                    "items": [
                        {
                            **ITEMS[0],
                            "binding": {**ITEMS[0]["binding"], "verifiedValue": 4215332, "status": "bound"},
                        }
                    ],
                },
            }
        ],
        prior_inventory={"version": 1, "items": ITEMS},
        feedback="the count is wrong",
    )
    sys = create.call_args_list[0].kwargs["messages"][0]["content"]
    assert "verified binding patterns" in sys
    assert "SELECT SUM(amount) FROM fam_ar WHERE _period = :period" in sys
    assert "the count is wrong" in sys
    assert "keep existing item ids" in sys


def test_schema_invalid_submit_yields_meaningful_error():
    # Missing required field `parsed` — a schema failure, not an anchor error.
    schema_bad = [
        {
            "id": "total", "kind": "value",
            "anchor": {"sectionKey": "summary", "blockIndex": 0, "spanIndex": 1},
            "raw": "$4.2M", "binding": {"familyId": "fam_ar", "sql": "SELECT 1"}, "reason": None,
        }
    ]
    c, create = make_client(
        tool_msg("submit_inventory", {"version": 1, "items": schema_bad}),
        tool_msg("submit_inventory", {"version": 1, "items": ITEMS}),
    )
    out = bind_golden(
        client=c, catalog=CATALOG, run_sql=MagicMock(), document=DOC, period="2026-Q1", siblings=[]
    )
    assert out is not None
    second_call_messages = create.call_args_list[1].kwargs["messages"]
    tool_result = next(m for m in reversed(second_call_messages) if m["role"] == "tool")
    assert tool_result["content"].startswith("Tool error: invalid inventory: ")
    assert tool_result["content"] != "Tool error: invalid inventory: ["
    assert "parsed" in tool_result["content"]


def test_returns_none_after_cap_and_nudge_without_valid_submit():
    probe = tool_msg("run_sql", {"sql": "SELECT 1"})
    c, create = make_client(*[probe for _ in range(18)])
    out = bind_golden(
        client=c, catalog=CATALOG, run_sql=MagicMock(return_value="ok"),
        document=DOC, period=None, siblings=[],
    )
    assert out is None
    # 16 tool rounds + nudged round + post-nudge round, hard stop.
    assert create.call_count == 18


def test_accepts_valid_submit_in_post_nudge_round():
    probe = tool_msg("run_sql", {"sql": "SELECT 1"})
    submit = tool_msg("submit_inventory", {"version": 1, "items": ITEMS})

    def create_impl(**kwargs):
        messages = kwargs["messages"]
        last_tool = next((m for m in reversed(messages) if m["role"] == "tool"), None)
        if last_tool and "Tool budget exhausted" in (last_tool.get("content") or ""):
            return submit
        return probe

    create = MagicMock(side_effect=create_impl)
    c = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    out = bind_golden(
        client=c, catalog=CATALOG, run_sql=MagicMock(return_value="ok"),
        document=DOC, period="2026-Q1", siblings=[],
    )
    assert out["items"][0]["id"] == "total"
    assert create.call_count == 18


def test_client_throw_yields_none():
    create = MagicMock(side_effect=Exception("boom"))
    c = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    out = bind_golden(
        client=c, catalog=CATALOG, run_sql=MagicMock(), document=DOC, period=None, siblings=[]
    )
    assert out is None
