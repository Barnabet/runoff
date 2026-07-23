"""Ports the run-side cases of packages/engine/test/checks.test.ts — evaluateAssert,
auditCitations, countCitations. compileLocator's cases live in test_golden_binding.py
(it was ported to services/golden_binding.py in R1), so they are not repeated here.
"""

from runoff_api.core.dialect import parse_section_text
from runoff_api.engine.checks import audit_citations, count_citations, evaluate_assert

CATALOG = [
    {
        "id": "famA", "key": "ar", "label": "AR", "kind": "periodic", "granularity": "quarter",
        "queryable": True, "filedPeriods": ["2026-Q1"],
        "tables": [{
            "name": "fam_ar",
            "columns": [{"name": "amount", "type": "REAL"}, {"name": "status", "type": "TEXT"}],
            "rowCounts": {"2026-Q1": 3},
        }],
    },
    {
        "id": "famC", "key": "ref", "label": "Ref", "kind": "constant", "granularity": None,
        "queryable": True, "filedPeriods": [],
        "tables": [{"name": "fam_ref", "columns": [{"name": "share", "type": "REAL"}], "rowCounts": {"": 2}}],
    },
]


def data_returning(value, capture=None):
    def exec_fn(sql):
        if capture is not None:
            capture.append(sql)
        return {"columns": ["v"], "rows": [[value]]}

    return {"catalog": CATALOG, "exec": exec_fn}


def rule(**over):
    base = {
        "kind": "assert", "text": "t",
        "sql": "SELECT SUM(amount) FROM fam_ar WHERE _period = :period", "op": ">", "value": 0,
    }
    base.update(over)
    return base


# ── evaluateAssert (SQL) ────────────────────────────────────────────────────


def test_passes_and_formats_the_detail_from_the_sql():
    out = evaluate_assert(rule(), data_returning(1204))
    assert out["pass"] is True
    assert out["detail"] == (
        "SELECT SUM(amount) FROM fam_ar WHERE _period = :period = 1,204 (expected > 0) — pass"
    )


def test_fails_with_within_pct_tolerance_semantics():
    out = evaluate_assert(rule(op="==", value=1000, withinPct=5), data_returning(1100))
    assert out["pass"] is False
    assert "within 5%" in out["detail"]


def test_missing_sql_op_value_fails_byte_exact():
    out = evaluate_assert({"kind": "assert", "text": "t"}, data_returning(1))
    assert out["detail"] == "assert rule is missing sql/op/value"


def test_non_scalar_results_fail_byte_exact():
    data = {"catalog": CATALOG, "exec": lambda sql: {"columns": ["a", "b"], "rows": [[1, 2]]}}
    assert evaluate_assert(rule(), data)["detail"] == "check query must return one numeric value"
    empty = {"catalog": CATALOG, "exec": lambda sql: {"columns": ["a"], "rows": []}}
    assert evaluate_assert(rule(), empty)["detail"] == "check query must return one numeric value"


def test_sql_errors_surface_as_the_detail():
    def exec_fn(sql):
        raise RuntimeError("query references :period but no period was provided")

    data = {"catalog": CATALOG, "exec": exec_fn}
    assert evaluate_assert(rule(), data)["detail"] == (
        "query references :period but no period was provided"
    )


# ── auditCitations (warehouse) ──────────────────────────────────────────────


def blocks_with(locator, fig="1,204", source_id="famA"):
    return parse_section_text(f"Total was [[{fig}|{source_id}|{locator}]] this quarter.")


def test_verifies_a_matching_aggregate_citation():
    calls = []
    audit = audit_citations(blocks_with("sum(fam_ar.amount)"), data_returning(1204, calls), ["famA"])
    assert audit["pass"] is True
    assert calls[0] == 'SELECT COALESCE(SUM("amount"), 0) FROM "fam_ar" WHERE _period = :period'


def test_flags_a_mismatch_beyond_half_percent():
    audit = audit_citations(blocks_with("sum(fam_ar.amount)"), data_returning(2000), ["famA"])
    assert audit["failures"] == ["citation mismatch: 1,204 vs computed 2000"]


def test_flags_locator_source_mismatch_when_table_belongs_to_another_family():
    audit = audit_citations(
        blocks_with("sum(fam_ref.share)", "0.62", "famA"), data_returning(0.62), ["famA", "famC"],
    )
    assert audit["failures"] == ["locator source mismatch: cites famA but locator references fam_ref"]


def test_flags_unknown_tables_and_exec_failures_as_unverifiable():
    bad = audit_citations(blocks_with("sum(fam_nope.amount)"), data_returning(1), ["famA"])
    assert bad["failures"] == ["unverifiable locator: sum(fam_nope.amount)"]

    def throwing_exec(sql):
        raise RuntimeError("no data ingested yet")

    throwing = {"catalog": CATALOG, "exec": throwing_exec}
    audit = audit_citations(blocks_with("sum(fam_ar.amount)"), throwing, ["famA"])
    assert audit["failures"] == ["unverifiable locator: sum(fam_ar.amount)"]


def test_leaves_quote_reference_locators_alone_and_keeps_unbound_uncited_failures():
    blocks = parse_section_text('The guide says [["plain voice"|famDoc|brand guide p.2]] and 500 units.')
    audit = audit_citations(blocks, data_returning(1), ["famDoc"])
    assert audit["failures"] == ["uncited figure: 500"]


def test_fails_a_cited_span_whose_text_carries_no_figure_with_a_pinned_prefix():
    blocks = [{"type": "paragraph", "spans": [
        {"text": "figure", "citation": {"sourceId": "famA", "locator": "max"}},
    ]}]
    r = audit_citations(blocks, data_returning(0), ["famA"])
    assert r["pass"] is False
    assert r["failures"][0].startswith("cited span has no figure: ")


def test_pins_the_unbound_source_failure_prefix():
    unbound = [{"type": "paragraph", "spans": [
        {"text": "$240,100", "citation": {"sourceId": "src_other", "locator": "x"}},
    ]}]
    r = audit_citations(unbound, data_returning(0), ["famA"])
    assert r["pass"] is False
    assert r["failures"][0].startswith("figure cites unbound source src_other: ")


def test_does_not_read_digits_embedded_in_identifiers_like_ga4_as_figures():
    blocks = [{"type": "paragraph", "spans": [
        {"text": "GA4 recorded strong Q2 growth across channels."},
    ]}]
    assert audit_citations(blocks, data_returning(1), ["famA"])["pass"] is True


def test_audits_citations_inside_table_cells_but_not_header_columns():
    cited = [{"type": "table", "columns": ["Metric", "Q2 Value"], "rows": [
        {"cells": [
            [{"text": "Total"}],
            [{"text": "$240,100", "citation": {"sourceId": "famA", "locator": "sum(fam_ar.amount)"}}],
        ]},
    ]}]
    assert audit_citations(cited, data_returning(240100), ["famA"])["pass"] is True
    assert count_citations(cited) == 1

    uncited = [{"type": "table", "columns": ["Metric", "Value"], "rows": [
        {"cells": [[{"text": "Total"}], [{"text": "$240,100"}]]},
    ]}]
    r = audit_citations(uncited, data_returning(240100), ["famA"])
    assert r["pass"] is False
    assert r["failures"][0].startswith("uncited figure: ")


def test_skips_recompute_for_a_figure_span_whose_locator_is_not_an_aggregate_reference():
    blocks = [{"type": "paragraph", "spans": [
        {"text": "$240,100", "citation": {"sourceId": "famA", "locator": "invoice footnote 3"}},
    ]}]
    assert audit_citations(blocks, data_returning(0), ["famA"])["pass"] is True


# ── countCitations ──────────────────────────────────────────────────────────


def test_counts_cited_spans_across_paragraphs_and_table_cells():
    para = parse_section_text("Total was [[1,204|famA|sum(fam_ar.amount)]] this quarter.")
    assert count_citations(para) == 1

    table = [{"type": "table", "columns": ["Metric", "Q2 Value"], "rows": [
        {"cells": [
            [{"text": "Total"}],
            [{"text": "$240,100", "citation": {"sourceId": "famA", "locator": "sum(fam_ar.amount)"}}],
        ]},
    ]}]
    assert count_citations(table) == 1

    none = [{"type": "paragraph", "spans": [{"text": "No citations here."}]}]
    assert count_citations(none) == 0
