import re
import sqlite3

from runoff_api.core.db import open_db
from runoff_api.core.ids import new_id


def test_creates_tables_and_accepts_inserts(db):
    # Ports packages/core/test/db.test.ts "creates tables and accepts inserts".
    id = new_id("bp")
    db.execute(
        "INSERT INTO blueprints (id, name, client_name) VALUES (?, ?, ?)",
        (id, "Monthly Performance Report", "Meridian Retail"),
    )
    rows = db.execute("SELECT * FROM blueprints").fetchall()
    assert len(rows) == 1
    assert rows[0]["status"] == "draft"
    assert re.fullmatch(r"bp_[0-9a-f]{12}", id)


def test_open_db_rejects_pre_v12b_database(tmp_path):
    # Ports "throws the reseed guard when opening a pre-v1.2b database".
    path = tmp_path / "old.db"
    legacy = sqlite3.connect(str(path))
    legacy.execute("CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL)")
    legacy.commit()
    legacy.close()
    try:
        open_db(str(path))
        raise AssertionError("expected RuntimeError")
    except RuntimeError as e:
        assert "predates v1.2b" in str(e)


def test_open_db_creates_all_tables(db):
    names = {r["name"] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {
        "projects", "source_families", "blueprint_families", "blueprints",
        "blueprint_revisions", "sources", "runs", "run_events", "run_inputs",
        "flags", "notes", "copilot_messages", "memories", "goldens",
    } <= names


def test_sqlite3_module_is_serialized():
    # Sync endpoints run in a threadpool sharing one connection (same model as
    # better-sqlite3's single handle); requires a serialized sqlite3 build.
    assert sqlite3.threadsafety == 3


def test_enforces_one_live_file_per_periodic_slot(db):
    # Ports packages/core/test/sourcesModel.test.ts "v1.2b tables >
    # enforces one live file per periodic slot via the partial index".
    db.execute("INSERT INTO projects (id, name) VALUES ('proj_1', 'P')")
    db.execute(
        "INSERT INTO source_families (id, project_id, key, label, kind, granularity) "
        "VALUES ('fam_1','proj_1','trade_data','Trade data','periodic','quarter')"
    )
    ins = (
        "INSERT INTO sources (id, project_id, family_id, period, name, stored_filename, mime, size, status) "
        "VALUES (?, 'proj_1', 'fam_1', '2026-Q1', 'f.csv', 'sf', 'text/csv', 1, ?)"
    )
    db.execute(ins, ("src_1", "filed"))
    try:
        db.execute(ins, ("src_2", "filed"))
        raise AssertionError("expected UNIQUE violation for a second filed source in the same slot")
    except sqlite3.IntegrityError as e:
        assert "UNIQUE" in str(e)
    # Non-'filed' rows are outside the partial index and never collide.
    db.execute(ins, ("src_3", "replaced"))


def test_memories_status_and_created_at_defaults(db):
    # Ports packages/core/test/copilotTables.test.ts "v1.2a tables > boot DDL ...":
    # status/timestamp default columns land without being supplied.
    db.execute(
        "INSERT INTO memories (id, blueprint_id, body, source) "
        "VALUES ('m1','bp1','Always use percentages','copilot')"
    )
    m = db.execute("SELECT status, created_at AS createdAt FROM memories WHERE id='m1'").fetchone()
    assert m["status"] == "active"
    assert m["createdAt"]
