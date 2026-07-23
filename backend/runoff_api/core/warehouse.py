"""Port of the READ SIDE of packages/core/src/warehouse.ts.

Per-project analytical warehouse: a separate SQLite file holding the ingested
rows of tabular sources. The app DB stays the system of record; everything
here is rebuildable from the stored files. Ingestion (attach/applySchema/
deleteRows/insertRows/computeDrift) is R2 and lives elsewhere; this module
carries only the read-only path used by the catalog and the copilot.
"""

import os
import re
import sqlite3

MAX_RESULT_ROWS = 200
MAX_RESULT_CHARS = 10_000


def warehouse_dir() -> str:
    return os.environ.get("RUNOFF_WAREHOUSE_DIR", "data/warehouses")


def warehouse_path(project_id: str) -> str:
    return os.path.join(warehouse_dir(), f"{project_id}.db")


def _q(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


def _open_readonly(project_id: str) -> sqlite3.Connection | None:
    """Read-only direct open (no attach) for catalog building — None if no warehouse yet.

    Default tuple row factory on this connection: rows come back as tuples/lists.
    """
    path = warehouse_path(project_id)
    if not os.path.exists(path):
        return None
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.execute("PRAGMA query_only = ON")
    return conn


def read_warehouse_tables(project_id: str, family_key: str) -> list[dict]:
    """Schema + per-period row counts for one family, for the catalog."""
    db = _open_readonly(project_id)
    if db is None:
        return []
    try:
        base = f"fam_{family_key}"
        names = [
            r[0]
            for r in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            ).fetchall()
            if r[0] == base or r[0].startswith(f"{base}__")
        ]
        tables: list[dict] = []
        for name in names:
            cols = db.execute("SELECT name, type FROM pragma_table_info(?)", (name,)).fetchall()
            periodic = any(c[0] == "_period" for c in cols)
            row_counts: dict[str, int] = {}
            if periodic:
                for r in db.execute(
                    f'SELECT "_period" AS p, COUNT(*) AS n FROM {_q(name)} '
                    'GROUP BY "_period" ORDER BY "_period"'
                ).fetchall():
                    row_counts[r[0]] = r[1]
            else:
                row_counts[""] = db.execute(f"SELECT COUNT(*) AS n FROM {_q(name)}").fetchone()[0]
            tables.append(
                {
                    "name": name,
                    "columns": [
                        {"name": c[0], "type": c[1] if c[1] in ("INTEGER", "REAL", "TEXT") else "TEXT"}
                        for c in cols
                        if c[0] != "_period"
                    ],
                    "rowCounts": row_counts,
                }
            )
        return tables
    finally:
        db.close()


def run_warehouse_sql(project_id: str, sql: str, period: str | None = None) -> dict:
    """One read-only statement against the project warehouse. Raises on any error.

    `:period` is the only supported named parameter, bound iff the SQL references it.
    """
    db = _open_readonly(project_id)
    if db is None:
        raise RuntimeError("no data ingested yet")
    try:
        wants_period = re.search(r":period\b", sql) is not None
        if wants_period and period is None:
            raise RuntimeError("query references :period but no period was provided")
        params = {"period": period} if wants_period else {}
        # Multi-statement strings raise here (ProgrammingError); writes raise
        # OperationalError under query_only.
        cur = db.execute(sql, params)
        if cur.description is None:
            return {"columns": [], "rows": []}
        columns = [d[0] for d in cur.description]
        rows = [list(r) for r in cur.fetchall()]
        return {"columns": columns, "rows": rows}
    finally:
        db.close()


def _stringify(v: object) -> str:
    """Mirror JS String(v): an integral float prints without a trailing .0."""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def format_sql_result(res: dict) -> str:
    """Serialize a result for the copilot: header, pipe-separated rows, hard caps."""
    rows = res["rows"]
    if not rows:
        return "(0 rows)"
    header = " | ".join(res["columns"])
    lines = [header]
    chars = len(header)
    shown = 0
    for row in rows:
        if shown >= MAX_RESULT_ROWS:
            break
        line = " | ".join("" if v is None else _stringify(v) for v in row)
        if chars + 1 + len(line) > MAX_RESULT_CHARS:
            break
        lines.append(line)
        chars += 1 + len(line)
        shown += 1
    if shown < len(rows):
        lines.append(f"… truncated at {shown} of {len(rows)} rows")
    return "\n".join(lines)
