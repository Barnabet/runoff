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
