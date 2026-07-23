"""Cross-language parity: replay the TS-recorded fixtures through the Python port.

Fixtures are produced by `scripts/dump-parity-fixtures.ts` (pnpm backend:fixtures)
from a freshly seeded DB. Each fixture records a pure @runoff/core function's
real inputs plus its TS output; here we feed the same inputs to the Python port
and assert byte-equal output (numbers via pytest.approx rel=1e-12, else exact).

Gated: skipped unless RUNOFF_PARITY is set and the fixtures dir exists — run via
`pnpm backend:parity` from a seeded repo root.
"""

import json
import math
import os
from pathlib import Path

import pytest

from runoff_api.core.bindings import boundness_counts, parse_bindings
from runoff_api.core.db import open_db
from runoff_api.core.diff import diff_runs
from runoff_api.core.reducer import reduce_run
from runoff_api.core.warehouse_catalog import build_warehouse_catalog

FIXTURES = Path(__file__).parent / "fixtures"
REPO_ROOT = Path(__file__).parents[2]

pytestmark = pytest.mark.skipif(
    not os.environ.get("RUNOFF_PARITY") or not FIXTURES.is_dir(),
    reason="parity fixtures only run with RUNOFF_PARITY=1 and a seeded fixtures dir",
)


def load(name: str):
    with open(FIXTURES / name, encoding="utf-8") as f:
        return json.load(f)


def assert_parity(actual, expected, path: str = "$") -> None:
    """Deep equality with numeric tolerance — mirrors the TS diff comparator.

    bool is compared exactly (it is an int subclass in Python); floats/ints use
    pytest.approx(rel=1e-12); dicts/lists recurse; everything else is exact.
    """
    if isinstance(actual, bool) or isinstance(expected, bool):
        assert actual is expected, f"{path}: {actual!r} != {expected!r}"
    elif isinstance(actual, (int, float)) and isinstance(expected, (int, float)):
        if isinstance(actual, float) and math.isnan(actual):
            assert isinstance(expected, float) and math.isnan(expected), f"{path}: NaN mismatch"
        else:
            assert actual == pytest.approx(expected, rel=1e-12), f"{path}: {actual!r} != {expected!r}"
    elif isinstance(actual, dict) and isinstance(expected, dict):
        assert set(actual) == set(expected), f"{path}: keys {set(actual)} != {set(expected)}"
        for k in actual:
            assert_parity(actual[k], expected[k], f"{path}.{k}")
    elif isinstance(actual, list) and isinstance(expected, list):
        assert len(actual) == len(expected), f"{path}: len {len(actual)} != {len(expected)}"
        for i, (a, e) in enumerate(zip(actual, expected, strict=True)):
            assert_parity(a, e, f"{path}[{i}]")
    else:
        assert actual == expected, f"{path}: {actual!r} != {expected!r}"


def test_parity_bindings():
    fx = load("bindings.json")
    assert fx is not None, "bindings.json should always be present after seeding"
    assert_parity(parse_bindings(fx["raw"]), fx["parsed"])
    assert_parity(boundness_counts(fx["parsed"]), fx["counts"])


def test_parity_reducer():
    fx = load("reducer.json")
    if fx is None:
        pytest.skip("reducer.json is null — no completed run in the seeded DB")
    assert_parity(reduce_run(fx["events"], fx["sectionMeta"]), fx["projection"])


def test_parity_diff():
    fx = load("diff.json")
    if fx is None:
        pytest.skip("diff.json is null — no completed-run predecessor pair in the seeded DB")
    assert_parity(diff_runs(fx["current"], fx["previous"]), fx["diff"])


def test_parity_catalog():
    fx = load("catalog.json")
    assert fx is not None, "catalog.json should always be present after seeding"
    db_path = os.environ.get("RUNOFF_DB", str(REPO_ROOT / "data" / "runoff.db"))
    if not Path(db_path).exists():
        pytest.skip(f"seeded DB not found at {db_path}")
    conn = open_db(db_path)
    try:
        catalog = build_warehouse_catalog(conn, fx["projectId"])
    finally:
        conn.close()
    assert_parity(catalog, fx["catalog"])
