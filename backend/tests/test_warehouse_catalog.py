"""Ports packages/core/test/warehouseCatalog.test.ts.

The TS fixture builds the warehouse table via core's own writers
(attach/applySchema/insertRows), which are R2 and not ported here; the Python
fixture instead builds the fam_* table directly with sqlite3 — the resulting
warehouse file is byte-shaped identically for the read side.
"""

import sqlite3

from runoff_api.core.ids import new_id
from runoff_api.core.warehouse_catalog import build_warehouse_catalog


def test_families_in_key_order_queryable_iff_tables_filed_periods_only_periodic(
    db, tmp_path, monkeypatch
):
    wh_dir = tmp_path / "warehouses"
    wh_dir.mkdir()
    monkeypatch.setenv("RUNOFF_WAREHOUSE_DIR", str(wh_dir))

    project_id = new_id("proj")
    db.execute("INSERT INTO projects (id, name) VALUES (?, ?)", (project_id, "P"))

    # One periodic family with a filed source for 2026-Q1 and a real warehouse table.
    periodic_id = new_id("fam")
    db.execute(
        "INSERT INTO source_families (id, project_id, key, label, kind, granularity) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (periodic_id, project_id, "a_sales", "Sales", "periodic", "quarter"),
    )
    source_id = new_id("src")
    db.execute(
        "INSERT INTO sources (id, project_id, family_id, name, stored_filename, mime, size, period, status) "
        "VALUES (?, ?, ?, ?, ?, 'text/csv', 1, ?, 'filed')",
        (source_id, project_id, periodic_id, "sales.csv", "sales.csv", "2026-Q1"),
    )
    wh = sqlite3.connect(str(wh_dir / f"{project_id}.db"))
    wh.execute('CREATE TABLE fam_a_sales (amount INTEGER, "_period" TEXT NOT NULL)')
    wh.executemany(
        'INSERT INTO fam_a_sales (amount, "_period") VALUES (?, ?)', [(100, "2026-Q1"), (50, "2026-Q1")]
    )
    wh.commit()
    wh.close()

    # One constant family with no filed source and no warehouse table.
    constant_id = new_id("fam")
    db.execute(
        "INSERT INTO source_families (id, project_id, key, label, kind, granularity) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (constant_id, project_id, "b_notes", "Notes", "constant", None),
    )

    cat = build_warehouse_catalog(db, project_id)
    assert [f["key"] for f in cat] == sorted(f["key"] for f in cat)
    periodic = next(f for f in cat if f["kind"] == "periodic")
    assert periodic["queryable"] is True
    assert periodic["filedPeriods"] == ["2026-Q1"]
    assert periodic["tables"][0]["rowCounts"]["2026-Q1"] > 0
    constant = next(f for f in cat if f["kind"] == "constant")
    assert constant["queryable"] is False
    assert constant["filedPeriods"] == []
