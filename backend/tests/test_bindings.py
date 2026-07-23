"""Ports packages/core/test/bindings.test.ts."""

import json

from runoff_api.core.bindings import boundness_counts, parse_bindings

INV = {
    "version": 1,
    "items": [
        {"id": "a", "kind": "value", "anchor": {"sectionKey": "s", "blockIndex": 0, "spanIndex": 0},
         "raw": "1", "parsed": 1, "reason": None,
         "binding": {"familyId": "f", "sql": "SELECT 1", "verifiedValue": 1, "status": "bound"}},
        {"id": "b", "kind": "value", "anchor": {"sectionKey": "s", "blockIndex": 0, "spanIndex": 1},
         "raw": "2", "parsed": 2, "reason": "value mismatch",
         "binding": {"familyId": "f", "sql": "SELECT 2", "verifiedValue": 3, "status": "mismatch"}},
        {"id": "c", "kind": "value", "anchor": {"sectionKey": "s", "blockIndex": 0, "spanIndex": 2},
         "raw": "3", "parsed": 3, "binding": None, "reason": "no family"},
    ],
}


def test_parses_a_valid_stored_inventory():
    parsed = parse_bindings(json.dumps(INV))
    assert parsed is not None
    assert len(parsed["items"]) == 3


def test_degrades_null_corrupt_json_and_schema_drift_to_null():
    assert parse_bindings(None) is None
    assert parse_bindings("{not json") is None
    assert parse_bindings(json.dumps({"version": 1, "items": [{"garbage": True}]})) is None


def test_boundness_counts_null_inventory_to_null():
    assert boundness_counts(None) is None


def test_boundness_counts_counts_bound_mismatch_total():
    assert boundness_counts(INV) == {"bound": 1, "mismatch": 1, "total": 3}


def test_boundness_counts_empty_inventory_zero_counts_not_null():
    assert boundness_counts({"version": 1, "items": []}) == {"bound": 0, "mismatch": 0, "total": 0}
