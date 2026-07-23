"""Ports packages/core/test/diff.test.ts."""

import math

from runoff_api.core.diff import diff_runs, parse_figure


def _doc(sections):
    return {
        "title": "T", "eyebrow": "E", "dateline": "D",
        "sections": [{**s, "heading": s["key"]} for s in sections],
    }


def _cite(text, source_id, locator):
    return {"text": text, "citation": {"sourceId": source_id, "locator": locator}}


def test_parse_figure_strips_dollar_comma_percent_before_parsing():
    assert parse_figure("$220,500") == 220500
    assert parse_figure("3.5%") == 3.5
    assert math.isnan(parse_figure("figure"))


def test_emits_a_delta_when_a_cited_figure_changes_keyed_by_source_locator():
    prev = _doc([{"key": "kpi", "blocks": [
        {"type": "paragraph", "spans": [{"text": "Spend "}, _cite("$208,200", "src_a", "sum(src_a.amount)")]},
    ]}])
    cur = _doc([{"key": "kpi", "blocks": [
        {"type": "paragraph", "spans": [{"text": "Spend "}, _cite("$220,500", "src_a", "sum(src_a.amount)")]},
    ]}])
    diff = diff_runs(cur, prev)
    assert diff["deltas"] == [
        {"sectionKey": "kpi", "sourceId": "src_a", "locator": "sum(src_a.amount)",
         "before": 208200, "after": 220500},
    ]
    assert diff["sections"] == {"kpi": "changed"}


def test_drops_equal_values_and_non_numeric_pairs_first_parseable_wins():
    prev = _doc([{"key": "kpi", "blocks": [
        {"type": "paragraph", "spans": [
            _cite("100", "src_a", "sum"),
            _cite("999", "src_a", "sum"),
            _cite("same", "src_a", "max"),
        ]},
    ]}])
    cur = _doc([{"key": "kpi", "blocks": [
        {"type": "paragraph", "spans": [_cite("100", "src_a", "sum"), _cite("7", "src_a", "max")]},
    ]}])
    assert diff_runs(cur, prev)["deltas"] == []


def test_finds_cited_figures_inside_table_cells():
    loc = "sum(src_a.amount where channel=search)"
    prev = _doc([{"key": "ch", "blocks": [
        {"type": "table", "columns": ["Channel", "Spend"], "rows": [
            {"cells": [[{"text": "Search"}], [_cite("100,200", "src_a", loc)]]},
        ]},
    ]}])
    cur = _doc([{"key": "ch", "blocks": [
        {"type": "table", "columns": ["Channel", "Spend"], "rows": [
            {"cells": [[{"text": "Search"}], [_cite("110,000", "src_a", loc)]]},
        ]},
    ]}])
    diff = diff_runs(cur, prev)
    assert len(diff["deltas"]) == 1
    assert diff["deltas"][0]["before"] == 100200
    assert diff["deltas"][0]["after"] == 110000


def test_classifies_sections_new_removed_changed_unchanged():
    shared = [{"type": "paragraph", "spans": [{"text": "Same text."}]}]
    prev = _doc([
        {"key": "a", "blocks": shared},
        {"key": "gone", "blocks": [{"type": "paragraph", "spans": [{"text": "Old."}]}]},
        {"key": "b", "blocks": [{"type": "paragraph", "spans": [{"text": "Before."}]}]},
    ])
    cur = _doc([
        {"key": "a", "blocks": shared},
        {"key": "b", "blocks": [{"type": "paragraph", "spans": [{"text": "After."}]}]},
        {"key": "fresh", "blocks": [{"type": "paragraph", "spans": [{"text": "New."}]}]},
    ])
    assert diff_runs(cur, prev)["sections"] == {
        "a": "unchanged", "b": "changed", "gone": "removed", "fresh": "new",
    }
