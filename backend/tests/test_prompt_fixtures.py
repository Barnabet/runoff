"""Cross-language prompt-payload parity: replay the identical canned inputs
through the Python engine ports and assert the recorded
``chat.completions.create(**params)`` request bodies are byte-identical to the
TS-recorded fixtures in ``backend/tests/fixtures/prompts/``.

Fixtures are produced by ``scripts/dump-prompt-fixtures.ts``
(``pnpm backend:prompt-fixtures``). The canned inputs below are transcribed
byte-for-byte from that script — DO NOT edit one side without the other.

Covers: draft (first draft + retry-feedback variant), classify, propose (initial
proposal + amend/replan variant), distill.
"""

import difflib
import json
from pathlib import Path

from runoff_api.engine.classify import classify_source
from runoff_api.engine.distill import distill_run
from runoff_api.engine.draft import draft_section
from runoff_api.engine.propose_plan import propose_parse_plan
from tests.fake_client import make_fake_client

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
