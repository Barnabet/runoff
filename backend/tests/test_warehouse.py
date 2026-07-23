"""Ports the read-side cases of packages/core/test/warehouse.test.ts.

Ingestion-path cases (schema + ingest describe block, computeDrift describe
block, and the write-path assertions of "rejects writes") are R2 and skipped;
the read-only rejection is still asserted here via the mandatory guard tests.
Test warehouses are built directly with sqlite3 into tmp_path with
RUNOFF_WAREHOUSE_DIR pointed at that dir via monkeypatch.
"""

import sqlite3

import pytest

from runoff_api.core.warehouse import (
    format_sql_result,
    read_warehouse_tables,
    run_warehouse_sql,
    warehouse_path,
)

PROJECT = "proj_test"


def _build_warehouse(path: str) -> None:
    conn = sqlite3.connect(path)
    conn.execute('CREATE TABLE fam_spend (campaign TEXT, amount INTEGER, "_period" TEXT NOT NULL)')
    conn.executemany(
        'INSERT INTO fam_spend (campaign, amount, "_period") VALUES (?, ?, ?)',
        [("a", 10, "2026-Q1"), ("b", 20, "2026-Q1")],
    )
    conn.commit()
    conn.close()


@pytest.fixture()
def wh_project(tmp_path, monkeypatch):
    wh_dir = tmp_path / "warehouses"
    wh_dir.mkdir()
    monkeypatch.setenv("RUNOFF_WAREHOUSE_DIR", str(wh_dir))
    _build_warehouse(str(wh_dir / f"{PROJECT}.db"))
    return PROJECT


# --- mandatory Python-side guard tests (from the brief, verbatim) ---


def test_run_warehouse_sql_rejects_multi_statement(wh_project):
    with pytest.raises(Exception):  # noqa: B017 — mandatory guard, verbatim from the brief
        run_warehouse_sql(wh_project, "SELECT 1; SELECT 2")


def test_run_warehouse_sql_requires_period_when_referenced(wh_project):
    with pytest.raises(RuntimeError, match="query references :period"):
        run_warehouse_sql(wh_project, 'SELECT * FROM fam_ar WHERE "_period" = :period')


def test_run_warehouse_sql_rejects_writes(wh_project):
    with pytest.raises(sqlite3.OperationalError):
        run_warehouse_sql(wh_project, "DELETE FROM fam_ar")


# --- ported read-side cases of warehouse.test.ts ---


def test_runs_selects_read_only_against_the_warehouse_file(wh_project):
    res = run_warehouse_sql(wh_project, "SELECT campaign, amount FROM fam_spend ORDER BY campaign")
    assert res["columns"] == ["campaign", "amount"]
    assert res["rows"] == [["a", 10], ["b", 20]]


def test_rejects_writes_and_multi_statement_strings(wh_project):
    with pytest.raises(sqlite3.OperationalError):
        run_warehouse_sql(wh_project, "INSERT INTO fam_spend (campaign) VALUES ('x')")
    with pytest.raises(sqlite3.OperationalError):
        run_warehouse_sql(wh_project, "DROP TABLE fam_spend")
    with pytest.raises(sqlite3.ProgrammingError):
        run_warehouse_sql(wh_project, "SELECT 1; SELECT 2")


def test_throws_no_data_ingested_yet_when_warehouse_file_does_not_exist(wh_project):
    with pytest.raises(RuntimeError, match="no data ingested yet"):
        run_warehouse_sql("proj_none", "SELECT 1")


def test_formats_caps_at_200_rows_and_reports_truncation_byte_exactly():
    assert format_sql_result({"columns": ["a"], "rows": []}) == "(0 rows)"
    assert (
        format_sql_result({"columns": ["a", "b"], "rows": [[1, "x"], [2, None]]}) == "a | b\n1 | x\n2 | "
    )
    big = {"columns": ["n"], "rows": [[i] for i in range(250)]}
    out = format_sql_result(big)
    assert len(out.split("\n")) == 202  # header + 200 rows + truncation line
    assert out.endswith("… truncated at 200 of 250 rows")


def test_caps_serialized_output_at_10k_chars_with_the_same_line():
    wide = {"columns": ["t"], "rows": [["y" * 200] for _ in range(150)]}
    out = format_sql_result(wide)
    assert len(out) <= 10_000 + len("… truncated at 49 of 150 rows") + 1
    assert out.rstrip().endswith("rows")
    import re

    assert re.search(r"… truncated at \d+ of 150 rows$", out)


def test_binds_period_when_the_sql_references_it(wh_project):
    res = run_warehouse_sql(
        wh_project, "SELECT COUNT(*) FROM fam_spend WHERE _period = :period", period="2026-Q1"
    )
    assert res["rows"][0][0] > 0


def test_throws_byte_exact_when_period_referenced_but_not_provided(wh_project):
    with pytest.raises(RuntimeError, match="query references :period but no period was provided"):
        run_warehouse_sql(wh_project, "SELECT COUNT(*) FROM fam_spend WHERE _period = :period")
    with pytest.raises(RuntimeError, match="query references :period but no period was provided"):
        run_warehouse_sql(
            wh_project, "SELECT COUNT(*) FROM fam_spend WHERE _period = :period", period=None
        )


def test_ignores_params_when_the_sql_does_not_reference_period(wh_project):
    res = run_warehouse_sql(wh_project, "SELECT COUNT(*) FROM fam_spend", period="2026-Q1")
    assert res["columns"] == ["COUNT(*)"]


def test_read_warehouse_tables_returns_schema_and_per_period_counts(wh_project):
    conn = sqlite3.connect(warehouse_path(wh_project))
    conn.execute('INSERT INTO fam_spend (campaign, amount, "_period") VALUES (?, ?, ?)', ("c", 5, "2026-Q2"))
    conn.commit()
    conn.close()
    tables = read_warehouse_tables(wh_project, "spend")
    assert tables == [
        {
            "name": "fam_spend",
            "columns": [{"name": "campaign", "type": "TEXT"}, {"name": "amount", "type": "INTEGER"}],
            "rowCounts": {"2026-Q1": 2, "2026-Q2": 1},
        }
    ]


# --- Python-side coverage for branches warehouse.test.ts exercised only via
# the ingestion path (constant tables, missing warehouse) ---


def test_read_warehouse_tables_missing_warehouse_returns_empty(tmp_path, monkeypatch):
    monkeypatch.setenv("RUNOFF_WAREHOUSE_DIR", str(tmp_path))
    assert read_warehouse_tables("proj_none", "spend") == []


def test_read_warehouse_tables_constant_table_uses_empty_period_key(tmp_path, monkeypatch):
    monkeypatch.setenv("RUNOFF_WAREHOUSE_DIR", str(tmp_path))
    conn = sqlite3.connect(str(tmp_path / "proj_c.db"))
    conn.execute("CREATE TABLE fam_guide (note TEXT)")
    conn.execute("INSERT INTO fam_guide (note) VALUES ('x')")
    conn.commit()
    conn.close()
    tables = read_warehouse_tables("proj_c", "guide")
    assert tables == [
        {"name": "fam_guide", "columns": [{"name": "note", "type": "TEXT"}], "rowCounts": {"": 1}}
    ]
