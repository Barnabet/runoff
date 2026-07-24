"""Cross-language ingest parity: replay the four real fixture files through the
SAME canned ParsePlans (transcribed from scripts/dump-ingest-fixtures.ts) via the
Python engine + core.warehouse write path, and assert the produced warehouse
tables are byte-identical to the TS-recorded fixtures in
backend/tests/fixtures/ingest/.

Fixtures are produced by ``pnpm backend:ingest-fixtures``. The comparison is
EXACT (spec's byte bar): the only cross-language normalization applied is
collapsing an integer-valued float to an int, mirroring what better-sqlite3 does
implicitly when it reads a REAL column back into a JS number (JS has no int/float
distinction). A genuine fractional divergence survives that collapse and fails
the test — it is a port bug to fix, not a tolerance to loosen.
"""

import difflib
import json
import sqlite3
from pathlib import Path

from runoff_api.core.types.parse_plan import plan_table_name
from runoff_api.core.warehouse import apply_schema, insert_rows
from runoff_api.engine.parse_plan import execute_parse_plan, load_grids

REPO_ROOT = Path(__file__).parents[2]
FIXTURE_SRC = REPO_ROOT / "scripts" / "fixtures"
FIXTURES = Path(__file__).parent / "fixtures" / "ingest"


# ===========================================================================
# CANNED PLANS — transcribed byte-for-byte from scripts/dump-ingest-fixtures.ts
# ===========================================================================

CASES = [
    {
        "file": "spend_june.csv",
        "familyKey": "marketing_spend",
        "periodic": True,
        "period": "2026-06",
        "granularity": "month",
        "plan": {
            "version": 1,
            "tables": [
                {
                    "name": "spend",
                    "anchor": {
                        "sheet": "spend_june",
                        "headerSignature": ["date", "channel", "amount"],
                        "minMatch": 2,
                    },
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
        },
    },
    {
        "file": "ga4_export.csv",
        "familyKey": "ga4_analytics",
        "periodic": False,
        "period": None,
        "granularity": None,
        "plan": {
            "version": 1,
            "tables": [
                {
                    "name": "ga4",
                    "anchor": {
                        "sheet": "ga4_export",
                        "headerSignature": ["channel", "sessions", "conversions"],
                        "minMatch": 2,
                    },
                    "headerRows": 1,
                    "exclude": [],
                    "columns": [
                        {"from": "channel", "name": "channel", "type": "TEXT"},
                        {"from": "sessions", "name": "sessions", "type": "INTEGER"},
                        {"from": "conversions", "name": "conversions", "type": "INTEGER"},
                    ],
                    "onPeriodMismatch": "keep",
                }
            ],
        },
    },
    {
        "file": "ar_aging_q2_2026.xlsx",
        "familyKey": "ar_aging",
        "periodic": True,
        "period": "2026-Q2",
        "granularity": "quarter",
        "plan": {
            "version": 1,
            "tables": [
                {
                    "name": "ar_aging",
                    "anchor": {
                        "sheet": "ar_aging",
                        "headerSignature": ["customer", "status", "amount due ($)", "days outstanding"],
                        "minMatch": 3,
                    },
                    "headerRows": 1,
                    "exclude": [{"column": "customer", "pattern": "total"}],
                    "columns": [
                        {"from": "customer", "name": "customer", "type": "TEXT"},
                        {"from": "status", "name": "status", "type": "TEXT"},
                        {"from": "amount due ($)", "name": "amount_due", "type": "REAL", "parse": "currency"},
                        {"from": "days outstanding", "name": "days_outstanding", "type": "INTEGER"},
                    ],
                    "onPeriodMismatch": "keep",
                },
                {
                    "name": "monthly_totals",
                    "anchor": {
                        "sheet": "monthly_totals",
                        "headerSignature": ["region", "apr 2026", "may 2026", "jun 2026"],
                        "minMatch": 2,
                    },
                    "headerRows": 1,
                    "exclude": [],
                    "columns": [{"from": "region", "name": "region", "type": "TEXT"}],
                    "unpivot": {
                        "keep": ["region"],
                        "valuePattern": "\\d{4}$",
                        "keyColumn": "month",
                        "valueColumn": "amount",
                        "valueType": "REAL",
                        "valueParse": "currency",
                    },
                    "onPeriodMismatch": "keep",
                },
            ],
        },
    },
    {
        "file": "regional_summary.xlsx",
        "familyKey": "regional_summary",
        "periodic": False,
        "period": None,
        "granularity": None,
        "plan": {
            "version": 1,
            "tables": [
                {
                    "name": "regional",
                    "anchor": {
                        "sheet": "regional_summary",
                        "headerSignature": ["region", "revenue", "orders"],
                        "minMatch": 2,
                    },
                    "headerRows": 1,
                    "exclude": [{"column": "region", "pattern": "^note"}],
                    "columns": [
                        {"from": "region", "name": "region", "type": "TEXT"},
                        {"from": "revenue", "name": "revenue", "type": "INTEGER"},
                        {"from": "orders", "name": "orders", "type": "INTEGER"},
                    ],
                    "onPeriodMismatch": "keep",
                },
                {
                    "name": "channels",
                    "anchor": {
                        "sheet": "regional_summary",
                        "headerSignature": ["channel", "share"],
                        "minMatch": 2,
                    },
                    "headerRows": 1,
                    "exclude": [],
                    "columns": [
                        {"from": "channel", "name": "channel", "type": "TEXT"},
                        {"from": "share", "name": "share", "type": "REAL"},
                    ],
                    "onPeriodMismatch": "keep",
                },
            ],
        },
    },
]


def _collapse(v):
    """Mirror better-sqlite3 reading a REAL column back into a JS number: an
    integer-valued float carries no ``.0`` (JS has no int/float distinction)."""
    if isinstance(v, bool):
        return v
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def _sort_keys(v):
    if isinstance(v, list):
        return [_sort_keys(x) for x in v]
    if isinstance(v, dict):
        return {k: _sort_keys(v[k]) for k in sorted(v)}
    return v


def _canon(v) -> str:
    def norm(x):
        if isinstance(x, list):
            return [norm(e) for e in x]
        if isinstance(x, dict):
            return {k: norm(x[k]) for k in x}
        return _collapse(x)

    return json.dumps(_sort_keys(norm(v)), indent=2, ensure_ascii=False, sort_keys=True)


def _ingest(case: dict) -> dict:
    grids = load_grids(str(FIXTURE_SRC / case["file"]), "", case["file"])
    period = case["period"] if case["periodic"] else None
    result = execute_parse_plan(grids, case["plan"], period, case["granularity"])
    tables = result["tables"]

    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("ATTACH DATABASE ':memory:' AS wh")
    incoming = [
        {"name": plan_table_name(case["familyKey"], case["plan"], t["logical"]), "columns": t["columns"]}
        for t in tables
    ]
    apply_schema(conn, case["periodic"], incoming)
    for t in tables:
        tname = plan_table_name(case["familyKey"], case["plan"], t["logical"])
        cols = [c["name"] for c in t["columns"]]
        insert_rows(conn, tname, cols, t["rows"], period)

    dumped = []
    for t in incoming:
        cols = conn.execute("SELECT name, type FROM wh.pragma_table_info(?)", (t["name"],)).fetchall()
        columns = [{"name": c["name"], "type": c["type"]} for c in cols]
        quoted = '"' + t["name"].replace('"', '""') + '"'
        rows = [
            [_collapse(v) for v in row]
            for row in conn.execute(f"SELECT * FROM wh.{quoted} ORDER BY rowid").fetchall()
        ]
        dumped.append({"name": t["name"], "columns": columns, "rows": rows})
    conn.close()
    return {"tables": dumped}


def _assert_ingest(case: dict) -> None:
    base = case["file"].rsplit(".", 1)[0]
    expected = json.loads((FIXTURES / f"{base}.json").read_text(encoding="utf-8"))
    actual = _ingest(case)
    exp_text = _canon(expected)
    act_text = _canon(actual)
    if exp_text != act_text:
        diff = "\n".join(
            difflib.unified_diff(
                exp_text.splitlines(), act_text.splitlines(),
                fromfile=f"{base}.json (TS)", tofile=f"{base} (PY)", lineterm="",
            )
        )
        raise AssertionError(f"{case['file']} ingest diverged:\n{diff}")


def test_ingest_spend_june():
    _assert_ingest(CASES[0])


def test_ingest_ga4_export():
    _assert_ingest(CASES[1])


def test_ingest_ar_aging():
    _assert_ingest(CASES[2])


def test_ingest_regional_summary():
    _assert_ingest(CASES[3])
