"""Port of apps/worker/test/resolveSources.test.ts."""

import tempfile
from pathlib import Path

from runoff_api.core.db import RunoffDb, open_db
from runoff_api.worker.resolve_sources import resolve_run_sources


def temp_db() -> RunoffDb:
    d = tempfile.mkdtemp(prefix="runoff-resolve-")
    return open_db(str(Path(d) / "t.db"))


def add_family(db: RunoffDb, *, id, key, label, kind, granularity=None) -> None:
    db.execute(
        "INSERT INTO source_families (id, project_id, key, label, kind, granularity) "
        "VALUES (?, 'proj_1', ?, ?, ?, ?)",
        (id, key, label, kind, granularity),
    )


def add_source(
    db: RunoffDb, *, id, family_id, period, name, stored_filename, mime="text/csv", status
) -> None:
    db.execute(
        "INSERT INTO sources (id, project_id, family_id, period, name, stored_filename, mime, size, status) "
        "VALUES (?, 'proj_1', ?, ?, ?, ?, ?, 0, ?)",
        (id, family_id, period, name, stored_filename, mime, status),
    )


def bind(db: RunoffDb, blueprint_id, family_id) -> None:
    db.execute(
        "INSERT INTO blueprint_families (blueprint_id, family_id) VALUES (?, ?)",
        (blueprint_id, family_id),
    )


def test_resolves_periodic_and_constant_ids_are_family_ids_gaps_empty():
    db = temp_db()
    add_family(db, id="fam_spend", key="spend", label="Spend Data", kind="periodic", granularity="quarter")
    add_family(db, id="fam_rates", key="rates", label="Rate Card", kind="constant")
    add_source(
        db,
        id="src_q1",
        family_id="fam_spend",
        period="2026-Q1",
        name="spend-q1.csv",
        stored_filename="src_q1.csv",
        status="filed",
    )
    add_source(
        db,
        id="src_rate",
        family_id="fam_rates",
        period=None,
        name="rates.csv",
        stored_filename="src_rate.csv",
        status="filed",
    )
    bind(db, "bp_1", "fam_spend")
    bind(db, "bp_1", "fam_rates")

    result = resolve_run_sources(db, "bp_1", "2026-Q1")
    assert result["gaps"] == []
    by_id = {f["id"]: f for f in result["files"]}
    assert {f["id"] for f in result["files"]} == {"fam_spend", "fam_rates"}
    assert by_id["fam_spend"]["name"] == "Spend Data"
    assert by_id["fam_rates"]["name"] == "Rate Card"
    assert by_id["fam_spend"]["path"].endswith("src_q1.csv")
    assert by_id["fam_rates"]["path"].endswith("src_rate.csv")


def test_bound_family_with_no_file_for_period_is_gap_replaced_rows_never_resolve():
    db = temp_db()
    add_family(db, id="fam_spend", key="spend", label="Spend Data", kind="periodic", granularity="quarter")
    # A replaced (superseded) row for the exact slot must not resolve.
    add_source(
        db,
        id="src_old",
        family_id="fam_spend",
        period="2026-Q1",
        name="old.csv",
        stored_filename="old.csv",
        status="replaced",
    )
    bind(db, "bp_1", "fam_spend")

    result = resolve_run_sources(db, "bp_1", "2026-Q1")
    assert result["files"] == []
    assert result["gaps"] == ["spend"]


def test_resolves_constants_under_null_period_periodic_with_no_null_slot_is_gap():
    db = temp_db()
    add_family(db, id="fam_rates", key="rates", label="Rate Card", kind="constant")
    add_family(db, id="fam_spend", key="spend", label="Spend Data", kind="periodic", granularity="quarter")
    add_source(
        db,
        id="src_rate",
        family_id="fam_rates",
        period=None,
        name="rates.csv",
        stored_filename="src_rate.csv",
        status="filed",
    )
    # Periodic family has a Q1 file, but the run period is null → no match for its slot.
    add_source(
        db,
        id="src_q1",
        family_id="fam_spend",
        period="2026-Q1",
        name="spend.csv",
        stored_filename="src_q1.csv",
        status="filed",
    )
    bind(db, "bp_1", "fam_rates")
    bind(db, "bp_1", "fam_spend")

    result = resolve_run_sources(db, "bp_1", None)
    assert [f["id"] for f in result["files"]] == ["fam_rates"]
    assert result["gaps"] == ["spend"]
