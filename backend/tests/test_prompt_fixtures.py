"""Cross-language prompt-payload parity: replay the identical canned inputs
through the Python engine ports and assert the recorded
``chat.completions.create(**params)`` request bodies are byte-identical to the
TS-recorded fixtures in ``backend/tests/fixtures/prompts/``.

Fixtures are produced by ``scripts/dump-prompt-fixtures.ts``
(``pnpm backend:prompt-fixtures``). The canned inputs below are transcribed
byte-for-byte from that script — DO NOT edit one side without the other.

Covers: draft (first draft + retry-feedback variant), classify, propose (initial
proposal + amend/replan variant), distill, copilot (first create() of a
copilotTurn), bind (initial + rebind variants), unify (head/tail-capped exemplar).
"""

import difflib
import importlib
import json
import os
from pathlib import Path

# Pin the engine model BEFORE the harness reads it, so a dev-shell RUNOFF_MODEL
# leak can't skew the recorded request bodies (mirrors scripts/dump-prompt-
# fixtures.ts). prompts.py binds MODEL = os.environ.get("RUNOFF_MODEL", ...) at
# import time and draft/classify/distill/propose_plan copy it via
# `from prompts import MODEL`; create(model=MODEL) reads that module global at
# call time. An earlier-collected test may already have imported these under a
# leaked value, so force the env AND overwrite the captured MODEL on every module
# that holds one. (We overwrite the attribute rather than importlib.reload the
# modules — reloading draft would mint a fresh RefusalError class that run.py no
# longer catches.)
os.environ["RUNOFF_MODEL"] = "gpt-5.6-sol"
for _name in ("prompts", "classify", "distill", "draft", "propose_plan"):
    importlib.import_module(f"runoff_api.engine.{_name}").MODEL = "gpt-5.6-sol"

from runoff_api.engine.bind_golden import bind_golden  # noqa: E402
from runoff_api.engine.classify import classify_source  # noqa: E402 — after the RUNOFF_MODEL pin
from runoff_api.engine.copilot import copilot_turn  # noqa: E402
from runoff_api.engine.distill import distill_run  # noqa: E402
from runoff_api.engine.draft import draft_section  # noqa: E402
from runoff_api.engine.propose_plan import propose_parse_plan  # noqa: E402
from runoff_api.engine.unify_golden import unify_golden_report  # noqa: E402
from runoff_api.services.golden_binding import boundness_line, render_golden_for_prompt  # noqa: E402
from runoff_api.services.goldens import scaffold_digest_for  # noqa: E402
from tests.fake_client import make_fake_client  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures" / "prompts"


def _sort_keys(v):
    """Recursively sort object keys; lists keep their order (mirrors diff-api.ts)."""
    if isinstance(v, list):
        return [_sort_keys(x) for x in v]
    if isinstance(v, dict):
        return {k: _sort_keys(v[k]) for k in sorted(v)}
    return v


def _canon(v) -> str:
    return json.dumps(_sort_keys(v), indent=2, ensure_ascii=False, sort_keys=True)


def _assert_params(stage: str, actual: list[dict]) -> None:
    expected = json.loads((FIXTURES / f"{stage}.json").read_text(encoding="utf-8"))
    exp_text = _canon(expected)
    act_text = _canon(actual)
    if exp_text != act_text:
        diff = "\n".join(
            difflib.unified_diff(
                exp_text.splitlines(), act_text.splitlines(),
                fromfile=f"{stage}.json (TS)", tofile=f"{stage} (PY)", lineterm="",
            )
        )
        raise AssertionError(f"{stage} prompt payload diverged:\n{diff}")


def _recording(script):
    """A fake client that records every create(**params) verbatim."""
    base = make_fake_client(script)
    inner = base.chat.completions.create
    captured: list[dict] = []

    def create(**params):
        captured.append(params)
        return inner(**params)

    base.chat.completions.create = create
    return base, captured


class _Cb:
    def on_delta(self, text): ...
    def on_flag(self, f): ...
    def on_question(self, q): ...


# ===========================================================================
# CANNED INPUTS — transcribed byte-for-byte from scripts/dump-prompt-fixtures.ts
# ===========================================================================

CONTENT = {
    "title": "Quarterly Performance Review",
    "clientName": "Northwind Trading Co.",
    "eyebrow": "Confidential",
    "dateline": "Q2 2026",
    "delivery": {"recipient": "cfo@northwind.example", "autoDeliverOnClear": False},
    "globalRules": ["Round all currency to whole dollars.", "Write in the past tense."],
    "sections": [
        {
            "key": "exec",
            "number": 1,
            "heading": "Executive Summary",
            "mode": "auto",
            "instruction": "Summarize the quarter's headline results in three sentences.",
            "familyIds": ["fam_marketing_spend"],
            "queries": [],
            "rules": [],
        },
        {
            "key": "revenue",
            "number": 2,
            "heading": "Revenue Analysis",
            "mode": "auto",
            "instruction": "Analyze revenue by channel and call out the largest mover.",
            "familyIds": ["fam_marketing_spend"],
            "queries": [],
            "rules": [
                {"kind": "style", "text": "Lead with the total before the breakdown."},
                {
                    "kind": "assert",
                    "text": "Total spend equals the sum of channel spend.",
                    "sql": "SELECT sum(amount)\n  FROM fam_marketing_spend\n  WHERE _period = :period",
                },
            ],
        },
    ],
}

MEMORIES = [
    {"id": "mem_p1", "body": "Northwind's fiscal year starts in April.", "scope": "project"},
    {"id": "mem_b1", "body": "Always express spend deltas in percentages.", "scope": "blueprint"},
]

COMPLETED = [
    {
        "key": "exec",
        "heading": "Executive Summary",
        "blocks": [
            {"type": "paragraph", "spans": [{"text": "Revenue rose across every paid channel this quarter."}]}
        ],
    }
]

DRAFT_SECTION = CONTENT["sections"][1]
DATA_BLOCK = (
    "fam_marketing_spend (periodic, quarter 2026-Q2)\n"
    "schema: date TEXT, channel TEXT, amount REAL\n"
    "sum(amount)=190900 across 12 rows"
)
STEERS = ["Lead with the revenue headline."]
ANSWERS = [{"question": "Which channels count as paid?", "answer": "Search and social only."}]
RETRY_FEEDBACK = "assert failed: total spend 190900 did not match the sum of the cited channel figures."
PREVIOUS_SECTION_TEXT = "Last quarter total spend was 175000, led by paid search."

CLASSIFY_FAMILIES = [
    {"key": "marketing_spend", "label": "Marketing spend", "kind": "periodic", "granularity": "quarter"},
    {"key": "ga4_analytics", "label": "GA4 analytics", "kind": "periodic", "granularity": "quarter"},
    {"key": "brand_guidelines", "label": "Brand guidelines", "kind": "constant", "granularity": None},
]
CLASSIFY_FILENAME = "ga4_export_q3.csv"
CLASSIFY_SAMPLE = (
    "channel,sessions,conversions\npaid_search,48200,1240\npaid_social,31500,720\ndisplay,22800,410\n"
)

PROPOSE_FILENAME = "spend_june.csv"
PROPOSE_GRID_SAMPLE = (
    "## sheet: spend_june (13×3)\n"
    "R1: date | channel | amount\n"
    "R2: 2026-06-02 | search | 42000\n"
    "R3: 2026-06-05 | social | 28500\n\n"
    "## detector hints\nsingle table; header row 1"
)
EXISTING_PLAN = {
    "version": 1,
    "tables": [
        {
            "name": "spend",
            "anchor": {"headerSignature": ["date", "channel", "amount"], "minMatch": 2},
            "headerRows": 1,
            "exclude": [],
            "columns": [
                {"from": "date", "name": "date", "type": "TEXT", "parse": "date"},
                {"from": "channel", "name": "channel", "type": "TEXT"},
                {"from": "amount", "name": "amount", "type": "REAL", "parse": "currency"},
            ],
            "periodColumn": "date",
            "onPeriodMismatch": "keep",
        }
    ],
}
FIT_DETAIL = ["unknown column: notes"]
EXEC_REPORT = {
    "tables": [
        {
            "name": "spend",
            "anchor": {"sheet": "spend_june", "row": 0},
            "problems": [],
            "rowsKept": 11,
            "rowsExcluded": [],
            "coercionFailures": [{"column": "amount", "count": 1, "samples": ["n/a"]}],
            "periodMismatches": {"count": 0, "samples": []},
            "unknownColumns": ["notes"],
        }
    ]
}
PROPOSE_FEEDBACK = "Treat the notes column as free text; keep it out of the numeric tables."

DISTILL_TITLE = "Quarterly Performance Review"
DISTILL_HEADINGS = ["Executive Summary", "Revenue Analysis"]
DISTILL_INTERACTIONS = {
    "steers": ["Lead with the revenue headline."],
    "answers": [{"question": "Which channels count as paid?", "answer": "Search and social only."}],
    "flagResolutions": [
        {"question": "Include the disputed invoice?", "resolution": "Exclude disputed invoices from totals."}
    ],
}
DISTILL_EXISTING = [{"body": "Northwind's fiscal year starts in April.", "scope": "project"}]

VALID_PLAN_JSON = (
    '{"version":1,"tables":[{"name":"t","anchor":{"headerSignature":["a"],"minMatch":1},'
    '"headerRows":1,"exclude":[],"columns":[{"from":"a","name":"a","type":"TEXT"}]}]}'
)


def test_draft_prompt_payload():
    captured: list[dict] = []
    base, cap = _recording([[{"text": "Drafted section body.", "stopReason": "end_turn"}]])
    draft_section(
        client=base, content=CONTENT, section=DRAFT_SECTION, data_block=DATA_BLOCK,
        completed=COMPLETED, steers=STEERS, answers=ANSWERS, memories=MEMORIES, cb=_Cb(),
    )
    captured.extend(cap)
    base, cap = _recording([[{"text": "Redrafted section body.", "stopReason": "end_turn"}]])
    draft_section(
        client=base, content=CONTENT, section=DRAFT_SECTION, data_block=DATA_BLOCK,
        completed=COMPLETED, steers=STEERS, answers=ANSWERS, retry_feedback=RETRY_FEEDBACK,
        previous_section_text=PREVIOUS_SECTION_TEXT, memories=MEMORIES, cb=_Cb(),
    )
    captured.extend(cap)
    _assert_params("draft", captured)


def test_classify_prompt_payload():
    resp = '{"familyKey":"ga4_analytics","period":"2026-Q3","confidence":"high"}'
    base, cap = _recording([[{"text": resp}]])
    classify_source(
        client=base, filename=CLASSIFY_FILENAME, content_sample=CLASSIFY_SAMPLE,
        families=CLASSIFY_FAMILIES,
    )
    _assert_params("classify", cap)


def test_propose_prompt_payload():
    captured: list[dict] = []
    base, cap = _recording([[{"text": VALID_PLAN_JSON}]])
    propose_parse_plan(client=base, filename=PROPOSE_FILENAME, grid_sample=PROPOSE_GRID_SAMPLE)
    captured.extend(cap)
    base, cap = _recording([[{"text": VALID_PLAN_JSON}]])
    propose_parse_plan(
        client=base, filename=PROPOSE_FILENAME, grid_sample=PROPOSE_GRID_SAMPLE,
        existing_plan=EXISTING_PLAN, fit_detail=FIT_DETAIL, exec_report=EXEC_REPORT,
        feedback=PROPOSE_FEEDBACK,
    )
    captured.extend(cap)
    _assert_params("propose", captured)


def test_distill_prompt_payload():
    base, cap = _recording([[{"text": '{"memories":[]}'}]])
    distill_run(
        client=base, title=DISTILL_TITLE, section_headings=DISTILL_HEADINGS,
        interactions=DISTILL_INTERACTIONS, existing=DISTILL_EXISTING,
    )
    _assert_params("distill", cap)


# ===========================================================================
# copilot / bind / unify canned inputs — transcribed byte-for-byte from
# scripts/dump-prompt-fixtures.ts (insertion order matters where a dict is
# embedded via JSON.stringify / to_json).
# ===========================================================================

COPILOT_DRAFT = {
    "title": "Monthly Marketing Report",
    "clientName": "Meridian Retail",
    "eyebrow": "Marketing Performance",
    "dateline": "June 2026",
    "delivery": {"recipient": "ops@meridian.example", "autoDeliverOnClear": False},
    "globalRules": ["Cite every figure.", "Use GBP for all amounts."],
    "sections": [
        {
            "key": "summary",
            "number": 1,
            "heading": "Executive Summary",
            "mode": "fixed",
            "instruction": "Summarize the month in two sentences.",
            "fixedText": "Marketing delivered steady growth in June.",
            "familyIds": [],
            "queries": [],
            "rules": [],
        },
        {
            "key": "spend",
            "number": 2,
            "heading": "Spend Breakdown",
            "mode": "auto",
            "instruction": "Break spend down by channel.",
            "familyIds": ["fam_spend"],
            "queries": [{"name": "total_spend", "sql": "SELECT sum(amount) FROM fam_spend WHERE _period = :period"}],  # noqa: E501
            "rules": [{"kind": "style", "text": "Lead with the total."}],
        },
    ],
}
COPILOT_SELECTED_KEY = "spend"
COPILOT_MESSAGE = "Bake a query that totals spend for the month."
COPILOT_THREAD = [
    {"role": "user", "body": "Can you tighten the summary?"},
    {"role": "assistant", "body": "Sure — I made it more concise."},
]
COPILOT_MEMORIES = [
    {"id": "mem_pr1", "body": "Meridian reports in GBP.", "scope": "project"},
    {"id": "mem_bp1", "body": "Keep the executive summary to two sentences.", "scope": "blueprint"},
]
COPILOT_CATALOG = [
    {
        "id": "fam_spend", "key": "spend", "label": "Ad spend", "kind": "periodic", "granularity": "month",
        "queryable": True,
        "tables": [{"name": "fam_spend", "columns": [{"name": "channel", "type": "TEXT"}, {"name": "amount", "type": "REAL"}], "rowCounts": {"2026-05": 3, "2026-06": 4}}],  # noqa: E501
        "filedPeriods": ["2026-05", "2026-06"],
    },
    {
        "id": "fam_brand", "key": "brand", "label": "Brand guidelines", "kind": "constant", "granularity": None,  # noqa: E501
        "queryable": False, "tables": [], "filedPeriods": [],
    },
]
COPILOT_FAMILIES = [
    {"id": "fam_spend", "key": "spend", "label": "Ad spend", "kind": "periodic", "granularity": "month", "filedPeriods": ["2026-06"], "hasLiveFile": False, "bound": True},  # noqa: E501
    {"id": "fam_brand", "key": "brand", "label": "Brand guidelines", "kind": "constant", "granularity": None, "filedPeriods": [], "hasLiveFile": False, "bound": False},  # noqa: E501
]
COPILOT_RESOLVED_GOLDEN = {
    "id": "gold_q2",
    "kind": "run",
    "label": "run run_42",
    "note": "Strong Q2 exemplar",
    "period": "2026-Q2",
    "document": {
        "title": "Quarterly Revenue Report",
        "eyebrow": "",
        "dateline": "",
        "sections": [
            {
                "key": "revenue",
                "heading": "Revenue",
                "blocks": [
                    {"type": "paragraph", "spans": [{"text": "Revenue reached "}, {"text": "$4.2M"}, {"text": " this quarter."}]},  # noqa: E501
                    {
                        "type": "table",
                        "columns": ["channel", "amount"],
                        "rows": [
                            {"cells": [[{"text": "search"}], [{"text": "2.5M"}]]},
                            {"cells": [[{"text": "social"}], [{"text": "1.7M"}]]},
                        ],
                    },
                ],
            }
        ],
    },
    "inventory": {
        "version": 1,
        "items": [
            {
                "id": "revenue_total", "kind": "value", "anchor": {"sectionKey": "revenue", "blockIndex": 0, "spanIndex": 1},  # noqa: E501
                "raw": "$4.2M", "parsed": 4200000,
                "binding": {"familyId": "fam_rev", "sql": "SELECT sum(amount) FROM fam_rev WHERE _period = :period", "verifiedValue": 4200000, "status": "bound"},  # noqa: E501
                "reason": None,
            },
            {
                "id": "revenue_table", "kind": "table", "anchor": {"sectionKey": "revenue", "blockIndex": 1, "spanIndex": None},  # noqa: E501
                "raw": "table: channel, amount", "parsed": None,
                "binding": {"familyId": "fam_rev", "sql": "SELECT channel, amount FROM fam_rev WHERE _period = :period", "verifiedValue": 3, "status": "mismatch"},  # noqa: E501
                "reason": "row count 3 ≠ 2",
            },
        ],
    },
    "unifyError": None,
}


class _CopilotIo:
    def emit(self, e): ...


BIND_TABLE_ROWS = [
    {"cells": [[{"text": f"channel_{i + 1}"}], [{"text": str((i + 1) * 1000)}]]}
    for i in range(15)
]
BIND_DOCUMENT = {
    "title": "Q2 Revenue Report",
    "eyebrow": "",
    "dateline": "",
    "sections": [
        {
            "key": "overview",
            "heading": "Overview",
            "blocks": [
                {
                    "type": "paragraph",
                    "spans": [
                        {"text": "Revenue climbed sharply this quarter, driven primarily by paid search and a resurgent social channel that together accounted for the overwhelming majority of net new bookings across every region we serve and every product line we track."},  # noqa: E501
                        {"text": 'The CFO called it "solid" — up 12% ✓ over last year.'},
                    ],
                },
                {"type": "table", "columns": ["channel", "amount"], "rows": BIND_TABLE_ROWS},
            ],
        }
    ],
}
BIND_CATALOG = [
    {
        "id": "fam_rev", "key": "revenue", "label": "Revenue", "kind": "periodic", "granularity": "quarter",
        "queryable": True,
        "tables": [{"name": "fam_rev", "columns": [{"name": "channel", "type": "TEXT"}, {"name": "amount", "type": "REAL"}], "rowCounts": {"2026-Q1": 10, "2026-Q2": 15}}],  # noqa: E501
        "filedPeriods": ["2026-Q1", "2026-Q2"],
    }
]
BIND_PERIOD = "2026-Q2"
BIND_SIBLINGS = [
    {
        "period": "2026-Q1",
        "inventory": {
            "version": 1,
            "items": [
                {
                    "id": "rev_total", "kind": "value", "anchor": {"sectionKey": "overview", "blockIndex": 0, "spanIndex": 0},  # noqa: E501
                    "raw": "$3.8M", "parsed": 3800000,
                    "binding": {"familyId": "fam_rev", "sql": "SELECT sum(amount) FROM fam_rev WHERE _period = :period", "verifiedValue": 3800000, "status": "bound"},  # noqa: E501
                    "reason": None,
                },
                {
                    "id": "rev_growth", "kind": "value", "anchor": {"sectionKey": "overview", "blockIndex": 0, "spanIndex": 1},  # noqa: E501
                    "raw": "12%", "parsed": 0.12, "binding": None, "reason": "styling number",
                },
            ],
        },
    }
]
BIND_PRIOR = {
    "version": 1,
    "items": [
        {
            "id": "rev_total", "kind": "value", "anchor": {"sectionKey": "overview", "blockIndex": 0, "spanIndex": 0},  # noqa: E501
            "raw": "$4.2M", "parsed": 4200000,
            "binding": {"familyId": "fam_rev", "sql": "SELECT sum(amount) FROM fam_rev WHERE _period = :period"}, "reason": None,  # noqa: E501
        },
        {
            "id": "rev_table", "kind": "table", "anchor": {"sectionKey": "overview", "blockIndex": 2, "spanIndex": None},  # noqa: E501
            "raw": "table: channel, amount", "parsed": None, "binding": None, "reason": "no query covers this table",  # noqa: E501
        },
    ],
}
BIND_FEEDBACK = "The revenue total should exclude refunds; rebind rev_total accordingly."

UNIFY_FILENAME = "q2_report.txt"
UNIFY_PARAGRAPH = "Revenue grew steadily across every paid channel this quarter, and the team reported strong performance. "  # noqa: E501
UNIFY_TEXT = UNIFY_PARAGRAPH * 300
UNIFY_DOC_JSON = (
    '{"document":{"title":"Q2 Report","eyebrow":"","dateline":"","sections":[{"key":"overview",'
    '"heading":"Overview","blocks":[{"type":"paragraph","spans":[{"text":"Revenue grew."}]}]}]},'
    '"period":"2026-Q2"}'
)


def test_copilot_prompt_payload():
    # Build the golden + scaffold caches through the REAL renderers (mirrors the
    # copilot route). Not part of the captured payload — a construction-time smoke
    # test that both stacks run the annotation + digest paths without diverging.
    g = COPILOT_RESOLVED_GOLDEN
    golden_cache = {
        g["id"]: {
            "description": f'{g["label"]} — {boundness_line(g["inventory"])}',
            "text": render_golden_for_prompt(g),
        }
    }
    scaffold_cache = {g["id"]: scaffold_digest_for(g)}
    ctx = {
        "families": COPILOT_FAMILIES,
        "defaultFiles": [],
        "periodFiles": [],
        "catalog": COPILOT_CATALOG,
        "runSql": lambda sql: (_ for _ in ()).throw(Exception("no data ingested yet")),
        "listRuns": lambda: [],
        "getRunSection": lambda run_id, key: None,
        "listGoldens": lambda: [],
        "getGolden": lambda i: golden_cache.get(i),
        "scaffoldDigest": lambda i: scaffold_cache.get(i, "golden not found"),
        "saveMemory": lambda body, scope: "mem_1",
    }
    base, cap = _recording([[{"text": "I baked a total-spend query for the Spend section."}]])
    copilot_turn(
        client=base, draft=COPILOT_DRAFT, selected_key=COPILOT_SELECTED_KEY, message=COPILOT_MESSAGE,
        thread=COPILOT_THREAD, memories=COPILOT_MEMORIES, ctx=ctx, io=_CopilotIo(),
    )
    _assert_params("copilot", cap)


def test_bind_prompt_payload():
    base, cap_initial = _recording([[{"text": "ok"}]])
    bind_golden(
        client=base, catalog=BIND_CATALOG, run_sql=lambda s: "",
        document=BIND_DOCUMENT, period=BIND_PERIOD, siblings=BIND_SIBLINGS,
    )
    base, cap_rebind = _recording([[{"text": "ok"}]])
    bind_golden(
        client=base, catalog=BIND_CATALOG, run_sql=lambda s: "",
        document=BIND_DOCUMENT, period=BIND_PERIOD, siblings=BIND_SIBLINGS,
        prior_inventory=BIND_PRIOR, feedback=BIND_FEEDBACK,
    )
    _assert_params("bind", {"initial": cap_initial[0], "rebind": cap_rebind[0]})


def test_unify_prompt_payload():
    base, cap = _recording([[{"text": UNIFY_DOC_JSON}]])
    unify_golden_report(client=base, filename=UNIFY_FILENAME, text=UNIFY_TEXT)
    _assert_params("unify", cap)
