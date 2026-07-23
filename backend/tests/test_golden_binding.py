"""Ports packages/engine/test/goldenBinding.test.ts (the four ported functions'
cases) and the compileLocator cases from packages/engine/test/checks.test.ts.

Skipped (exercise unported code): renderGoldenForPrompt; checks.test.ts's
evaluateAssert / auditCitations / countCitations suites.
"""

from runoff_api.services.golden_binding import (
    boundness_line,
    compile_locator,
    inventory_from_citations,
    parse_span_number,
    verify_inventory,
)


def exec_of(mapping):
    def run(sql):
        hit = mapping.get(sql)
        if hit is None:
            raise Exception(f"no such table: {sql}")
        if isinstance(hit, Exception):
            raise hit
        return hit

    return run


def val(**over):
    base = {
        "id": "total",
        "kind": "value",
        "anchor": {"sectionKey": "s", "blockIndex": 0, "spanIndex": 0},
        "raw": "$4.2M",
        "parsed": 4200000,
        "binding": {"familyId": "fam_1", "sql": "Q1"},
        "reason": None,
    }
    base.update(over)
    return base


def inv(items):
    return {"version": 1, "items": items}


# ── parseSpanNumber ─────────────────────────────────────────────────────────


def test_parse_span_number_currency_commas_suffixes_percents():
    assert parse_span_number("$4,215,332") == 4215332
    assert parse_span_number("$4.2M") == 4200000
    assert parse_span_number("3.1K") == 3100
    assert parse_span_number("12.5%") == 0.125
    assert parse_span_number("EMEA") is None


# ── verifyInventory ─────────────────────────────────────────────────────────


def test_verify_stamps_bound_within_1pct_mismatch_outside():
    out = verify_inventory(
        inv([
            val(),
            val(id="count", raw="6", parsed=6, binding={"familyId": "fam_1", "sql": "Q2"}),
        ]),
        exec_of({"Q1": {"columns": ["v"], "rows": [[4215332]]}, "Q2": {"columns": ["v"], "rows": [[7]]}}),
        "2026-Q1",
    )
    assert out["items"][0]["binding"]["status"] == "bound"
    assert out["items"][0]["binding"]["verifiedValue"] == 4215332
    assert out["items"][1]["binding"]["status"] == "mismatch"
    assert out["items"][1]["reason"] == "value mismatch"


def test_verify_single_value_rule_sql_errors_no_period_rule():
    out = verify_inventory(
        inv([
            val(id="wide", binding={"familyId": "fam_1", "sql": "WIDE"}),
            val(id="boom", binding={"familyId": "fam_1", "sql": "BOOM"}),
            val(id="np", binding={"familyId": "fam_1", "sql": "SELECT SUM(x) WHERE _period = :period"}),
        ]),
        exec_of({"WIDE": {"columns": ["a", "b"], "rows": [[1, 2]]}, "BOOM": Exception("no such column: x")}),
        None,
    )
    assert out["items"][0]["binding"]["status"] == "error"
    assert out["items"][0]["reason"] == "sql did not return a single value"
    assert out["items"][1]["binding"]["status"] == "error"
    assert out["items"][1]["reason"] == "sql error: no such column: x"
    assert out["items"][2]["binding"]["status"] == "error"
    assert out["items"][2]["reason"] == "golden has no period"


def test_verify_string_equality_and_existence_binding():
    out = verify_inventory(
        inv([
            val(id="top", raw="EMEA", parsed="EMEA", binding={"familyId": "fam_1", "sql": "TOP"}),
            val(id="exists", raw="shown", parsed=None, binding={"familyId": "fam_1", "sql": "TOP"}),
        ]),
        exec_of({"TOP": {"columns": ["r"], "rows": [["emea "]]}}),
        "2026-Q1",
    )
    assert out["items"][0]["binding"]["status"] == "bound"
    assert out["items"][1]["binding"]["status"] == "bound"


def test_verify_table_rule_col_row_counts_byte_exact_reasons():
    def tbl(id, sql):
        return {
            "id": id,
            "kind": "table",
            "anchor": {"sectionKey": "s", "blockIndex": 1, "spanIndex": None},
            "raw": "status table",
            "parsed": None,
            "binding": {"familyId": "fam_1", "sql": sql},
            "reason": None,
        }

    doc = {
        "title": "",
        "eyebrow": "",
        "dateline": "",
        "sections": [
            {
                "key": "s",
                "heading": "S",
                "blocks": [
                    {"type": "paragraph", "spans": [{"text": "x"}]},
                    {
                        "type": "table",
                        "columns": ["status", "total"],
                        "rows": [{"cells": [[], []]}, {"cells": [[], []]}],
                    },
                ],
            }
        ],
    }
    out = verify_inventory(
        inv([tbl("t1", "T_OK"), tbl("t2", "T_COLS"), tbl("t3", "T_ROWS")]),
        exec_of({
            "T_OK": {"columns": ["a", "b"], "rows": [[1, 1], [2, 2]]},
            "T_COLS": {"columns": ["a", "b", "c"], "rows": [[1, 1, 1]]},
            "T_ROWS": {"columns": ["a", "b"], "rows": [[1, 1]]},
        }),
        "2026-Q1",
        doc,
    )
    assert out["items"][0]["binding"]["status"] == "bound"
    assert out["items"][0]["binding"]["verifiedValue"] == 2
    assert out["items"][1]["binding"]["status"] == "mismatch"
    assert out["items"][1]["reason"] == "column count 3 ≠ 2"
    assert out["items"][2]["binding"]["status"] == "mismatch"
    assert out["items"][2]["reason"] == "row count 1 ≠ 2"


def test_verify_unbound_items_pass_through_boundness_line_derives():
    out = verify_inventory(
        inv([val(), val(id="u", binding=None, reason="no candidate")]),
        exec_of({"Q1": {"columns": ["v"], "rows": [[4200000]]}}),
        "2026-Q1",
    )
    assert out["items"][1]["binding"] is None
    assert boundness_line(out) == "1/2 bound, 0 mismatch, 1 unbound"
    assert boundness_line({"version": 1, "items": []}) == "nothing to bind"
    assert boundness_line(None) == "not yet bound"


# ── inventoryFromCitations ──────────────────────────────────────────────────

CATALOG = [
    {
        "id": "fam_ar",
        "key": "ar_transactions",
        "label": "AR",
        "kind": "periodic",
        "granularity": "quarter",
        "tables": [
            {"name": "fam_ar_transactions", "columns": [{"name": "amount", "type": "REAL"}], "rowCount": 10}
        ],
        "periods": ["2026-Q1"],
    }
]

DOC = {
    "title": "t",
    "eyebrow": "",
    "dateline": "",
    "sections": [
        {
            "key": "summary",
            "heading": "S",
            "blocks": [
                {
                    "type": "paragraph",
                    "spans": [
                        {"text": "Total "},
                        {
                            "text": "50,855,755",
                            "citation": {"sourceId": "fam_ar", "locator": "sum(fam_ar_transactions.amount)"},
                        },
                    ],
                },
                {"type": "table", "columns": ["status", "total"], "rows": [{"cells": [[], []]}]},
            ],
        }
    ],
}


def test_inventory_spans_become_value_items_tables_use_covering_queries():
    by_status_sql = (
        "SELECT status, SUM(amount) FROM fam_ar_transactions WHERE _period = :period GROUP BY status"
    )
    out = inventory_from_citations(
        DOC,
        CATALOG,
        lambda key: [{"name": "by_status", "sql": by_status_sql}] if key == "summary" else [],
    )
    v = next(i for i in out["items"] if i["kind"] == "value")
    assert v["id"] == "summary_b0_s1"
    assert v["parsed"] == 50855755
    assert v["binding"]["familyId"] == "fam_ar"
    assert "SUM" in v["binding"]["sql"]
    t = next(i for i in out["items"] if i["kind"] == "table")
    assert t["id"] == "summary_b1"
    assert "GROUP BY status" in t["binding"]["sql"]


def test_inventory_uncovered_tables_and_unparseable_locators_are_unbound():
    import copy

    bad = copy.deepcopy(DOC)
    bad["sections"][0]["blocks"][0]["spans"][1]["citation"] = {"sourceId": "fam_ar", "locator": "garbage!!"}
    out = inventory_from_citations(bad, CATALOG, lambda key: [])
    assert out["items"][0]["binding"] is None
    assert "unparseable expression" in out["items"][0]["reason"]
    assert out["items"][1]["binding"] is None
    assert out["items"][1]["reason"] == "no query covers this table"


# ── compileLocator (checks.test.ts) ─────────────────────────────────────────

COMPILE_CATALOG = [
    {
        "id": "famA",
        "key": "ar",
        "label": "AR",
        "kind": "periodic",
        "granularity": "quarter",
        "queryable": True,
        "filedPeriods": ["2026-Q1"],
        "tables": [{
            "name": "fam_ar",
            "columns": [{"name": "amount", "type": "REAL"}, {"name": "status", "type": "TEXT"}],
            "rowCounts": {"2026-Q1": 3},
        }],
    },
    {
        "id": "famC",
        "key": "ref",
        "label": "Ref",
        "kind": "constant",
        "granularity": None,
        "queryable": True,
        "filedPeriods": [],
        "tables": [{"name": "fam_ref", "columns": [{"name": "share", "type": "REAL"}], "rowCounts": {"": 2}}],
    },
]


def test_compile_periodic_sum_with_string_filter():
    out = compile_locator("sum(fam_ar.amount where status=paid)", COMPILE_CATALOG)
    assert out["family"]["id"] == "famA"
    expected = (
        'SELECT COALESCE(SUM("amount"), 0) FROM "fam_ar" '
        "WHERE _period = :period AND lower(CAST(\"status\" AS TEXT)) = lower('paid')"
    )
    assert out["sql"] == expected


def test_compile_numeric_filter_values_get_numeric_or_branch():
    out = compile_locator("count(fam_ar.amount where status=42)", COMPILE_CATALOG)
    expected = (
        'SELECT COUNT("amount") FROM "fam_ar" '
        "WHERE _period = :period AND (\"status\" = 42 OR lower(CAST(\"status\" AS TEXT)) = lower('42'))"
    )
    assert out["sql"] == expected


def test_compile_constant_tables_no_period_count_no_coalesce():
    out = compile_locator("count(fam_ref.share)", COMPILE_CATALOG)
    assert out["sql"] == 'SELECT COUNT("share") FROM "fam_ref"'


def test_compile_escapes_single_quotes_in_filter_values():
    out = compile_locator("sum(fam_ar.amount where status=o'brien)", COMPILE_CATALOG)
    assert "lower('o''brien')" in out["sql"]


def test_compile_throws_on_table_not_in_catalog():
    import pytest

    with pytest.raises(ValueError):
        compile_locator("sum(fam_nope.amount)", COMPILE_CATALOG)
