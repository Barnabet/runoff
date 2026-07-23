"""Ports packages/engine/test/proposePlan.test.ts — grid-sample rendering, the
structured (or amending) ParsePlan proposal call with one retry, and the
degeneracy self-check trigger."""

import json
from types import SimpleNamespace

from runoff_api.engine.propose_plan import build_grid_sample, is_degenerate, propose_parse_plan

VALID = {
    "version": 1,
    "tables": [
        {
            "name": "aging",
            "anchor": {"headerSignature": ["customer", "amount"], "minMatch": 2},
            "headerRows": 1,
            "exclude": [],
            "columns": [
                {"from": "customer", "name": "customer", "type": "TEXT"},
                {"from": "amount", "name": "amount", "type": "REAL", "parse": "currency"},
            ],
            "onPeriodMismatch": "keep",
        }
    ],
}


def client_returning(*bodies):
    calls = {"n": 0}

    def create(**params):
        create.calls.append(params)
        body = bodies[calls["n"]]
        calls["n"] += 1
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=body))])

    create.calls = []
    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create))), create


# --- build_grid_sample ---


def test_renders_sheets_with_dimensions_numbered_rows_truncated_cells_and_hints_caps_at_6000():
    grids = [{"sheet": "ar_aging", "grid": [["a" * 50, "b"], ["c", 12]]}]
    s = build_grid_sample(grids, "### detector says hi")
    assert "## sheet: ar_aging (2×2)" in s
    assert f"R1: {'a' * 20} | b" in s
    assert "R2: c | 12" in s
    assert "## detector hints" in s
    assert len(s) <= 6000


# --- propose_parse_plan ---


def test_returns_a_validated_plan():
    client, _ = client_returning(json.dumps(VALID))
    p = propose_parse_plan(client=client, filename="f.xlsx", grid_sample="s")
    assert p == VALID


def test_retries_once_on_invalid_output_then_null():
    client, create = client_returning('{"nope":1}', "not json")
    p = propose_parse_plan(client=client, filename="f.xlsx", grid_sample="s")
    assert p is None
    assert len(create.calls) == 2


def test_zod_valid_but_structurally_invalid_plans_also_trigger_the_retry():
    dupe = {"version": 1, "tables": [VALID["tables"][0], VALID["tables"][0]]}
    client, create = client_returning(json.dumps(dupe), json.dumps(VALID))
    p = propose_parse_plan(client=client, filename="f.xlsx", grid_sample="s")
    assert p == VALID
    assert len(create.calls) == 2


def test_amendment_context_reaches_the_prompt():
    client, create = client_returning(json.dumps(VALID))
    propose_parse_plan(
        client=client,
        filename="f.xlsx",
        grid_sample="s",
        existing_plan=VALID,
        fit_detail=["missing column: aging.amount"],
        feedback="amount is now amount_usd",
    )
    messages = create.calls[0]["messages"]
    sys = messages[0]["content"]
    usr = messages[1]["content"]
    assert "MUST keep every existing logical table name and canonical column name" in sys
    assert "missing column: aging.amount" in usr
    assert "amount is now amount_usd" in usr


# --- is_degenerate ---

BASE_T = {
    "name": "t",
    "anchor": {"sheet": "s", "row": 0},
    "problems": [],
    "rowsKept": 5,
    "rowsExcluded": [],
    "coercionFailures": [],
    "periodMismatches": None,
    "unknownColumns": [],
}


def test_clean_report_is_not_degenerate():
    assert is_degenerate({"tables": [BASE_T]}) is False


def test_problems_zero_kept_rows_or_a_100pct_failure_column_are_degenerate():
    assert is_degenerate({"tables": [{**BASE_T, "problems": ["unanchored table: t"]}]}) is True
    assert is_degenerate({"tables": [{**BASE_T, "rowsKept": 0}]}) is True
    assert (
        is_degenerate(
            {
                "tables": [
                    {
                        **BASE_T,
                        "rowsKept": 3,
                        "coercionFailures": [{"column": "v", "count": 3, "samples": []}],
                    }
                ]
            }
        )
        is True
    )
    assert (
        is_degenerate(
            {
                "tables": [
                    {
                        **BASE_T,
                        "rowsKept": 4,
                        "coercionFailures": [{"column": "v", "count": 3, "samples": []}],
                    }
                ]
            }
        )
        is False
    )
