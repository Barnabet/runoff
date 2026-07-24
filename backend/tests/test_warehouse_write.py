"""Ports the WRITE-SIDE cases of packages/core/test/warehouse.test.ts.

The read-side describe blocks (runWarehouseSql + formatSqlResult + readWarehouse
Tables) were ported in R1 as tests/test_warehouse.py and are NOT duplicated here.
This file carries the "schema + ingest" and "computeDrift" describe blocks that
R1 skipped. Test warehouses are built by attaching an in-memory app connection to
a tmp warehouse file, mirroring the TS setup (attachWarehouse into a temp dir).
"""

import sqlite3

import pytest

from runoff_api.core.warehouse import (
    apply_schema,
    attach_warehouse,
    compute_drift,
    delete_rows,
    detach_warehouse,
    insert_rows,
    wh_family_tables,
)

PROJECT = "proj_test"

SPEND = {
    "name": "fam_spend",
    "columns": [{"name": "campaign", "type": "TEXT"}, {"name": "amount", "type": "INTEGER"}],
}


@pytest.fixture()
def app(tmp_path, monkeypatch):
    monkeypatch.setenv("RUNOFF_WAREHOUSE_DIR", str(tmp_path / "warehouses"))
    conn = sqlite3.connect(":memory:", isolation_level=None)
    conn.row_factory = sqlite3.Row
    attach_warehouse(conn, PROJECT)
    yield conn
    try:
        detach_warehouse(conn)
    except Exception:
        pass
    conn.close()


# --- schema + ingest -------------------------------------------------------


def test_creates_periodic_tables_and_swaps_one_period_on_reingest(app):
    apply_schema(app, True, [SPEND])
    insert_rows(app, "fam_spend", ["campaign", "amount"], [["a", 10], ["b", 20]], "2026-Q1")
    insert_rows(app, "fam_spend", ["campaign", "amount"], [["c", 30]], "2026-Q2")
    delete_rows(app, ["fam_spend"], "2026-Q1")
    insert_rows(app, "fam_spend", ["campaign", "amount"], [["a2", 11]], "2026-Q1")
    rows = app.execute(
        "SELECT campaign, amount, _period FROM wh.fam_spend ORDER BY _period, campaign"
    ).fetchall()
    assert [tuple(r) for r in rows] == [("a2", 11, "2026-Q1"), ("c", 30, "2026-Q2")]


def test_constant_tables_have_no_period_and_delete_null_clears_all(app):
    apply_schema(app, False, [{"name": "fam_guide", "columns": [{"name": "note", "type": "TEXT"}]}])
    insert_rows(app, "fam_guide", ["note"], [["x"]], None)
    assert app.execute("SELECT COUNT(*) AS n FROM wh.fam_guide").fetchone()["n"] == 1
    with pytest.raises(sqlite3.OperationalError):
        app.execute("SELECT _period FROM wh.fam_guide").fetchone()
    delete_rows(app, ["fam_guide"], None)
    assert app.execute("SELECT COUNT(*) AS n FROM wh.fam_guide").fetchone()["n"] == 0


def test_adds_new_columns_and_widens_int_real_text_preserving_values(app):
    apply_schema(app, True, [SPEND])
    insert_rows(app, "fam_spend", ["campaign", "amount"], [["a", 10]], "2026-Q1")
    apply_schema(
        app,
        True,
        [
            {
                "name": "fam_spend",
                "columns": [
                    {"name": "campaign", "type": "TEXT"},
                    {"name": "amount", "type": "REAL"},
                    {"name": "region", "type": "TEXT"},
                ],
            }
        ],
    )
    schema = wh_family_tables(app, "spend")
    assert schema[0]["columns"] == [
        {"name": "campaign", "type": "TEXT"},
        {"name": "amount", "type": "REAL"},
        {"name": "region", "type": "TEXT"},
    ]
    row = app.execute("SELECT campaign, amount, region FROM wh.fam_spend").fetchone()
    assert dict(row) == {"campaign": "a", "amount": 10, "region": None}
    # narrowing attempt is a no-op
    apply_schema(
        app,
        True,
        [
            {
                "name": "fam_spend",
                "columns": [
                    {"name": "campaign", "type": "TEXT"},
                    {"name": "amount", "type": "INTEGER"},
                    {"name": "region", "type": "TEXT"},
                ],
            }
        ],
    )
    amount = next(c for c in wh_family_tables(app, "spend")[0]["columns"] if c["name"] == "amount")
    assert amount["type"] == "REAL"


def test_wh_family_tables_scopes_by_key_without_prefix_collisions(app):
    apply_schema(app, True, [{"name": "fam_a", "columns": [{"name": "x", "type": "TEXT"}]}])
    apply_schema(app, True, [{"name": "fam_a_b", "columns": [{"name": "y", "type": "TEXT"}]}])
    apply_schema(app, True, [{"name": "fam_a__part", "columns": [{"name": "z", "type": "TEXT"}]}])
    assert sorted(t["name"] for t in wh_family_tables(app, "a")) == ["fam_a", "fam_a__part"]
    assert [t["name"] for t in wh_family_tables(app, "a_b")] == ["fam_a_b"]


# --- computeDrift ----------------------------------------------------------


def test_compute_drift_returns_empty_for_brand_new_family():
    assert compute_drift([], [SPEND]) == []


def test_compute_drift_reports_all_five_drift_cases():
    incoming = [
        {
            "name": "fam_spend",
            "columns": [
                {"name": "campaign", "type": "TEXT"},
                {"name": "amount", "type": "REAL"},
                {"name": "refund_flag", "type": "REAL"},
            ],
        },
        {
            "name": "fam_spend__extra",
            "columns": [{"name": "k", "type": "TEXT"}, {"name": "v", "type": "TEXT"}],
        },
    ]
    existing = [SPEND, {"name": "fam_spend__old", "columns": [{"name": "k", "type": "TEXT"}]}]
    assert compute_drift(existing, incoming) == [
        "new table: fam_spend__extra",
        "missing table: fam_spend__old",
        "new column: fam_spend.refund_flag (REAL)",
        "type change: fam_spend.amount INTEGER → REAL",
    ]
    # missing column case
    assert compute_drift(
        [SPEND], [{"name": "fam_spend", "columns": [{"name": "campaign", "type": "TEXT"}]}]
    ) == ["missing column: fam_spend.amount"]
