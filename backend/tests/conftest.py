import sqlite3

import pytest

from runoff_api.core.db import open_db


@pytest.fixture()
def db(tmp_path) -> sqlite3.Connection:
    conn = open_db(str(tmp_path / "test.db"))
    yield conn
    conn.close()
