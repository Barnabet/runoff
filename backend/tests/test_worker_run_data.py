"""Port of apps/worker/test/runData.test.ts."""

import tempfile
from pathlib import Path

import pytest

from runoff_api.core.db import RunoffDb, open_db
from runoff_api.core.warehouse import apply_schema, attach_warehouse, detach_warehouse, insert_rows
from runoff_api.worker.run_data import build_run_data


@pytest.fixture()
def rundata_db(monkeypatch) -> RunoffDb:
    # project proj1 with families famA (key "ar", periodic/quarter, filed 2026-Q1)
    # and famB (key "brand", constant, no warehouse tables — a document family);
    # warehouse table fam_ar(amount REAL) with 2 rows in 2026-Q1.
    wh_dir = tempfile.mkdtemp(prefix="runoff-rundata-wh-")
    monkeypatch.setenv("RUNOFF_WAREHOUSE_DIR", wh_dir)
    db = open_db(str(Path(tempfile.mkdtemp(prefix="runoff-rundata-")) / "t.db"))
    db.execute("INSERT INTO projects (id, name) VALUES ('proj1', 'P')")
    db.execute(
        "INSERT INTO source_families (id, project_id, key, label, kind, granularity) "
        "VALUES ('famA','proj1','ar','Accounts Receivable','periodic','quarter')"
    )
    db.execute(
        "INSERT INTO source_families (id, project_id, key, label, kind, granularity) "
        "VALUES ('famB','proj1','brand','Brand Guide','constant',NULL)"
    )
    db.execute(
        "INSERT INTO sources (id, project_id, family_id, period, name, stored_filename, mime, size, status) "
        "VALUES ('src1','proj1','famA','2026-Q1','ar-q1.csv','src1.csv','text/csv',0,'filed')"
    )

    # Warehouse: fam_ar(amount REAL) with 2 rows filed for 2026-Q1. Written through
    # the app connection (attach must be outside a transaction), then detached so
    # build_run_data opens the committed file with its own read-only connection.
    attach_warehouse(db, "proj1")
    apply_schema(db, True, [{"name": "fam_ar", "columns": [{"name": "amount", "type": "REAL"}]}])
    insert_rows(db, "fam_ar", ["amount"], [[100], [200]], "2026-Q1")
    detach_warehouse(db)
    yield db
    db.close()


def test_builds_catalog_restricted_to_bound_families_with_queryability(rundata_db):
    data = build_run_data(rundata_db, "proj1", ["famA", "famB"], "2026-Q1")
    assert sorted(f["id"] for f in data["catalog"]) == ["famA", "famB"]
    ar = next(f for f in data["catalog"] if f["id"] == "famA")
    assert ar["queryable"] is True
    assert ar["tables"][0]["name"] == "fam_ar"
    assert next(f for f in data["catalog"] if f["id"] == "famB")["queryable"] is False


def test_exec_binds_the_run_period(rundata_db):
    data = build_run_data(rundata_db, "proj1", ["famA"], "2026-Q1")
    res = data["exec"]("SELECT COUNT(*) FROM fam_ar WHERE _period = :period")
    assert res["rows"][0][0] == 2


def test_exec_surfaces_missing_period_error_for_period_less_runs(rundata_db):
    data = build_run_data(rundata_db, "proj1", ["famA"], None)
    with pytest.raises(Exception, match="query references :period but no period was provided"):
        data["exec"]("SELECT COUNT(*) FROM fam_ar WHERE _period = :period")
