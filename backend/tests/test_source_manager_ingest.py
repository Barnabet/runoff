"""Ports apps/web/test/sourceManager.test.ts — the Task 9 (ingest-path) cases.

Ported describe blocks:
  - withIngestLock          (serialization behind an in-flight ingest)
  - fileSource              (slot/family handling + listProjectSources)
  - fileSource — warehouse ingestion  (CSV -> warehouse rows, refile swaps,
                                        rejections, mid-txn rollback, catalog)

The "source manager routes" describe block (upload/classify/confirm/DELETE/PATCH
route handlers) is deferred to Task 10 (FastAPI routes + python-multipart) and is
NOT ported here. sourceManager.ui.test.tsx is UI and is skipped per the brief.

Each test runs against a real temp app DB (open_db) plus temp RUNOFF_FILES_DIR /
RUNOFF_WAREHOUSE_DIR via monkeypatched env, mirroring the TS freshDb() + env setup.
"""

import threading
import time

import pytest

from runoff_api.core.db import open_db
from runoff_api.core.warehouse import (
    attach_warehouse,
    detach_warehouse,
    run_warehouse_sql,
    warehouse_path,
)
from runoff_api.services import source_manager
from runoff_api.services.source_manager import (
    file_source,
    list_project_sources,
    with_ingest_lock,
)

PROJECT = "proj_1"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    files = tmp_path / "files"
    files.mkdir()
    wh = tmp_path / "warehouses"
    wh.mkdir()
    monkeypatch.setenv("RUNOFF_FILES_DIR", str(files))
    monkeypatch.setenv("RUNOFF_WAREHOUSE_DIR", str(wh))
    return {"files": files, "wh": wh}


@pytest.fixture()
def db(tmp_path, env):
    conn = open_db(str(tmp_path / "app.db"))
    yield conn
    conn.close()


def _write(env, name, content):
    (env["files"] / name).write_text(content)


def _add_source(db, sid, name, stored_filename, mime="text/csv"):
    db.execute(
        "INSERT INTO sources (id, project_id, name, stored_filename, mime, size) VALUES (?, ?, ?, ?, ?, 1)",
        (sid, PROJECT, name, stored_filename, mime),
    )


def _seed_project(db, env):
    db.execute("INSERT INTO projects (id, name) VALUES ('proj_1','P')")
    db.execute(
        "INSERT INTO source_families (id, project_id, key, label, kind, granularity) "
        "VALUES ('fam_q','proj_1','trade_data','Trade data','periodic','quarter')"
    )
    db.execute(
        "INSERT INTO source_families (id, project_id, key, label, kind, granularity) "
        "VALUES ('fam_c','proj_1','brand','Brand','constant',NULL)"
    )
    _write(env, "sf_a", "a,b\n1,2\n")
    _write(env, "sf_b", "a,b\n3,4\n")
    _write(env, "sf_c", "a,b\n5,6\n")
    _add_source(db, "src_a", "a.csv", "sf_a")
    _add_source(db, "src_b", "b.csv", "sf_b")
    _add_source(db, "src_c", "c.pdf", "sf_c")


# --- withIngestLock --------------------------------------------------------


def test_with_ingest_lock_serializes_behind_an_in_flight_ingest():
    order: list[str] = []
    gate = threading.Event()

    def slow():
        order.append("ingest-start")
        gate.wait()
        order.append("ingest-end")

    def other():
        order.append("delete")

    t1 = threading.Thread(target=lambda: with_ingest_lock(slow))
    t1.start()
    time.sleep(0.05)  # let the slow ingest acquire the lock and start
    t2 = threading.Thread(target=lambda: with_ingest_lock(other))
    t2.start()
    time.sleep(0.05)
    assert order == ["ingest-start"]  # second job queued, not started
    gate.set()
    t1.join()
    t2.join()
    assert order == ["ingest-start", "ingest-end", "delete"]


# --- fileSource ------------------------------------------------------------


def test_files_into_existing_periodic_family_and_replaces_occupant(db, env):
    _seed_project(db, env)
    assert file_source(
        db, {"projectId": "proj_1", "sourceId": "src_a", "familyId": "fam_q", "period": "2026-Q1"}
    ) == {"ok": True}
    assert file_source(
        db, {"projectId": "proj_1", "sourceId": "src_b", "familyId": "fam_q", "period": "2026-Q1"}
    ) == {"ok": True}
    rows = db.execute("SELECT id, status FROM sources WHERE family_id='fam_q' ORDER BY id").fetchall()
    assert [dict(r) for r in rows] == [
        {"id": "src_a", "status": "replaced"},
        {"id": "src_b", "status": "filed"},
    ]


def test_rejects_a_period_that_fails_the_familys_granularity(db, env):
    _seed_project(db, env)
    assert (
        file_source(
            db, {"projectId": "proj_1", "sourceId": "src_a", "familyId": "fam_q", "period": "2026-06"}
        )["status"]
        == 400
    )
    assert (
        file_source(db, {"projectId": "proj_1", "sourceId": "src_a", "familyId": "fam_q", "period": None})[
            "status"
        ]
        == 400
    )


def test_enforces_constant_rules_null_period_single_live_replaced(db, env):
    _seed_project(db, env)
    assert (
        file_source(
            db, {"projectId": "proj_1", "sourceId": "src_c", "familyId": "fam_c", "period": "2026-Q1"}
        )["status"]
        == 400
    )
    assert file_source(
        db, {"projectId": "proj_1", "sourceId": "src_c", "familyId": "fam_c", "period": None}
    ) == {"ok": True}
    assert file_source(
        db, {"projectId": "proj_1", "sourceId": "src_a", "familyId": "fam_c", "period": None}
    ) == {"ok": True}
    live = db.execute("SELECT id FROM sources WHERE family_id='fam_c' AND status='filed'").fetchall()
    assert [dict(r) for r in live] == [{"id": "src_a"}]


def test_creates_new_family_transactionally_and_rejects_duplicate_keys(db, env):
    _seed_project(db, env)
    assert file_source(
        db,
        {
            "projectId": "proj_1",
            "sourceId": "src_a",
            "newFamily": {"key": "ga4", "label": "GA4", "kind": "periodic", "granularity": "month"},
            "period": "2026-06",
        },
    ) == {"ok": True}
    assert (
        file_source(
            db,
            {
                "projectId": "proj_1",
                "sourceId": "src_b",
                "newFamily": {"key": "ga4", "label": "GA4 again", "kind": "periodic", "granularity": "month"},
                "period": "2026-07",
            },
        )["status"]
        == 400
    )


def test_new_family_not_created_when_period_fails_then_succeeds_on_retry(db, env):
    _seed_project(db, env)
    assert (
        file_source(
            db,
            {
                "projectId": "proj_1",
                "sourceId": "src_a",
                "newFamily": {"key": "ga4", "label": "GA4", "kind": "periodic", "granularity": "month"},
                "period": "bad",
            },
        )["status"]
        == 400
    )
    assert (
        db.execute("SELECT id FROM source_families WHERE project_id='proj_1' AND key='ga4'").fetchone()
        is None
    )
    assert file_source(
        db,
        {
            "projectId": "proj_1",
            "sourceId": "src_a",
            "newFamily": {"key": "ga4", "label": "GA4", "kind": "periodic", "granularity": "month"},
            "period": "2026-06",
        },
    ) == {"ok": True}
    assert (
        db.execute(
            "SELECT COUNT(*) AS n FROM source_families WHERE project_id='proj_1' AND key='ga4'"
        ).fetchone()["n"]
        == 1
    )


def test_list_project_sources_groups_by_family_and_surfaces_unfiled(db, env):
    _seed_project(db, env)
    file_source(db, {"projectId": "proj_1", "sourceId": "src_b", "familyId": "fam_q", "period": "2026-Q2"})
    file_source(db, {"projectId": "proj_1", "sourceId": "src_a", "familyId": "fam_q", "period": "2026-Q1"})
    result = list_project_sources(db, "proj_1")
    q = next(f for f in result["families"] if f["key"] == "trade_data")
    assert q["filedPeriods"] == ["2026-Q1", "2026-Q2"]
    assert q["filedEntries"] == [
        {"period": "2026-Q1", "sourceId": "src_a", "name": "a.csv"},
        {"period": "2026-Q2", "sourceId": "src_b", "name": "b.csv"},
    ]
    assert [u["id"] for u in result["unfiled"]] == ["src_c"]


def test_surfaces_live_file_of_constant_family_and_null_otherwise(db, env):
    _seed_project(db, env)
    file_source(db, {"projectId": "proj_1", "sourceId": "src_c", "familyId": "fam_c", "period": None})
    families = list_project_sources(db, "proj_1")["families"]
    brand = next(f for f in families if f["key"] == "brand")
    assert brand["liveFile"] == {"sourceId": "src_c", "name": "c.pdf"}
    assert brand["filedEntries"] == []
    assert next(f for f in families if f["key"] == "trade_data")["liveFile"] is None


# --- fileSource — warehouse ingestion --------------------------------------


@pytest.fixture()
def wh_db(tmp_path, env):
    conn = open_db(str(tmp_path / "app.db"))
    conn.execute("INSERT INTO projects (id, name) VALUES (?, 'P')", (PROJECT,))
    yield conn
    conn.close()


def test_confirm_of_a_csv_ingests_rows_under_fam_key(wh_db, env):
    _write(env, "s1.csv", "campaign,spend\nbrand,100\nsearch,200\n")
    _add_source(wh_db, "s1", "s1.csv", "s1.csv")
    res = file_source(
        wh_db,
        {
            "projectId": PROJECT,
            "sourceId": "s1",
            "newFamily": {"key": "spend", "label": "Spend", "kind": "periodic", "granularity": "quarter"},
            "period": "2026-Q1",
        },
    )
    assert res == {"ok": True}
    attach_warehouse(wh_db, PROJECT)
    rows = wh_db.execute("SELECT campaign, spend, _period FROM wh.fam_spend ORDER BY campaign").fetchall()
    detach_warehouse(wh_db)
    assert [tuple(r) for r in rows] == [("brand", 100, "2026-Q1"), ("search", 200, "2026-Q1")]


def test_csv_empty_cells_land_as_sql_null(wh_db, env):
    _write(env, "nulls.csv", "customer,amount\nAcme,100\nBeta,\nGamma,50\n")
    _add_source(wh_db, "nulls", "nulls.csv", "nulls.csv")
    res = file_source(
        wh_db,
        {
            "projectId": PROJECT,
            "sourceId": "nulls",
            "newFamily": {
                "key": "nulltest",
                "label": "Null test",
                "kind": "periodic",
                "granularity": "quarter",
            },
            "period": "2026-Q1",
        },
    )
    assert res == {"ok": True}
    out = run_warehouse_sql(
        PROJECT,
        "SELECT COUNT(amount) AS c, COUNT(*) AS n FROM fam_nulltest WHERE _period = :period",
        period="2026-Q1",
    )
    assert out["rows"][0] == [2, 3]


def test_refiling_a_period_swaps_only_that_periods_rows(wh_db, env):
    _write(env, "q1.csv", "campaign,spend\nbrand,100\n")
    _write(env, "q2.csv", "campaign,spend\nsearch,200\n")
    _write(env, "q1b.csv", "campaign,spend\nvideo,999\n")
    _add_source(wh_db, "q1", "q1.csv", "q1.csv")
    _add_source(wh_db, "q2", "q2.csv", "q2.csv")
    _add_source(wh_db, "q1b", "q1b.csv", "q1b.csv")
    file_source(
        wh_db,
        {
            "projectId": PROJECT,
            "sourceId": "q1",
            "newFamily": {"key": "sp", "label": "Sp", "kind": "periodic", "granularity": "quarter"},
            "period": "2026-Q1",
        },
    )
    fam_id = wh_db.execute("SELECT id FROM source_families WHERE key='sp'").fetchone()["id"]
    file_source(wh_db, {"projectId": PROJECT, "sourceId": "q2", "familyId": fam_id, "period": "2026-Q2"})
    file_source(wh_db, {"projectId": PROJECT, "sourceId": "q1b", "familyId": fam_id, "period": "2026-Q1"})
    attach_warehouse(wh_db, PROJECT)
    rows = wh_db.execute("SELECT campaign, _period FROM wh.fam_sp ORDER BY _period").fetchall()
    detach_warehouse(wh_db)
    assert [tuple(r) for r in rows] == [("video", "2026-Q1"), ("search", "2026-Q2")]
    assert dict(wh_db.execute("SELECT status FROM sources WHERE id = ?", ("q1",)).fetchone()) == {
        "status": "replaced"
    }


def test_tabular_file_with_no_detectable_tables_rejected_400_without_writes(wh_db, env):
    _write(env, "empty.csv", "\n")
    _add_source(wh_db, "empty", "empty.csv", "empty.csv")
    res = file_source(
        wh_db,
        {
            "projectId": PROJECT,
            "sourceId": "empty",
            "newFamily": {"key": "e", "label": "E", "kind": "periodic", "granularity": "quarter"},
            "period": "2026-Q1",
        },
    )
    assert res == {"error": "no tables detected in file", "status": 400}
    assert dict(wh_db.execute("SELECT status FROM sources WHERE id = ?", ("empty",)).fetchone()) == {
        "status": "unfiled"
    }
    assert wh_db.execute("SELECT COUNT(*) AS n FROM source_families WHERE key = 'e'").fetchone()["n"] == 0


def test_corrupt_file_whose_scan_rejects_returns_ingest_failed_500(wh_db, env):
    _write(env, "bad.xlsx", "not a real xlsx zip")
    _add_source(
        wh_db,
        "bad",
        "bad.xlsx",
        "bad.xlsx",
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    res = file_source(
        wh_db,
        {
            "projectId": PROJECT,
            "sourceId": "bad",
            "newFamily": {"key": "corrupt", "label": "C", "kind": "periodic", "granularity": "quarter"},
            "period": "2026-Q1",
        },
    )
    assert res["status"] == 500
    assert res["error"].startswith("ingest failed: ")
    assert dict(wh_db.execute("SELECT status FROM sources WHERE id = ?", ("bad",)).fetchone()) == {
        "status": "unfiled"
    }
    assert (
        wh_db.execute("SELECT COUNT(*) AS n FROM source_families WHERE key = 'corrupt'").fetchone()["n"] == 0
    )


def test_ingest_failure_mid_transaction_rolls_back_app_db_writes(wh_db, env, monkeypatch):
    def boom(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(source_manager, "read_tabular", boom)
    _write(env, "ok.csv", "a,b\n1,2\n")
    _add_source(wh_db, "ok", "ok.csv", "ok.csv")
    res = file_source(
        wh_db,
        {
            "projectId": PROJECT,
            "sourceId": "ok",
            "newFamily": {"key": "roll", "label": "R", "kind": "periodic", "granularity": "quarter"},
            "period": "2026-Q1",
        },
    )
    assert res == {"error": "ingest failed: boom", "status": 500}
    assert dict(wh_db.execute("SELECT status FROM sources WHERE id = ?", ("ok",)).fetchone()) == {
        "status": "unfiled"
    }
    assert wh_db.execute("SELECT COUNT(*) AS n FROM source_families WHERE key = 'roll'").fetchone()["n"] == 0


def test_list_project_sources_reports_warehouse_tables_with_counts(wh_db, env):
    wh_db.execute(
        "INSERT INTO source_families (id, project_id, key, label, kind, granularity) "
        "VALUES ('fam_brand', ?, 'brand', 'Brand', 'constant', NULL)",
        (PROJECT,),
    )
    _write(env, "q1.csv", "campaign,spend\nbrand,100\nsearch,200\n")
    _write(env, "doc.pdf", "just prose, no table")
    _add_source(wh_db, "q1", "q1.csv", "q1.csv")
    _add_source(wh_db, "doc", "doc.pdf", "doc.pdf", mime="application/pdf")
    file_source(
        wh_db,
        {
            "projectId": PROJECT,
            "sourceId": "q1",
            "newFamily": {"key": "spend", "label": "Spend", "kind": "periodic", "granularity": "quarter"},
            "period": "2026-Q1",
        },
    )
    file_source(wh_db, {"projectId": PROJECT, "sourceId": "doc", "familyId": "fam_brand", "period": None})
    families = list_project_sources(wh_db, PROJECT)["families"]
    spend = next(f for f in families if f["key"] == "spend")
    assert spend["tables"] == [{"name": "fam_spend", "rowCount": 2}]
    brand = next(f for f in families if f["key"] == "brand")
    assert brand["tables"] == []


def test_non_tabular_files_file_without_touching_the_warehouse(wh_db, env):
    import os

    wh_db.execute(
        "INSERT INTO source_families (id, project_id, key, label, kind, granularity) "
        "VALUES ('fam_brand', ?, 'brand', 'Brand', 'constant', NULL)",
        (PROJECT,),
    )
    _write(env, "doc.pdf", "just prose, no table")
    _add_source(wh_db, "doc", "doc.pdf", "doc.pdf", mime="application/pdf")
    res = file_source(
        wh_db, {"projectId": PROJECT, "sourceId": "doc", "familyId": "fam_brand", "period": None}
    )
    assert res == {"ok": True}
    assert not os.path.exists(warehouse_path(PROJECT))
