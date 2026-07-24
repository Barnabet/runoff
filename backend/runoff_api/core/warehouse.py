"""Port of packages/core/src/warehouse.ts.

Per-project analytical warehouse: a separate SQLite file holding the ingested
rows of tabular sources. The app DB stays the system of record; everything
here is rebuildable from the stored files. The read-only path (runWarehouseSql /
readWarehouseTables / formatSqlResult) landed in R1; the write side (attach/
detach/whFamilyTables/computeDrift/applySchema/deleteRows/insertRows) is R2 and
is appended below.
"""

import datetime as _dt
import os
import re
import sqlite3

# _coerce stringifies datetimes exactly like JS Date.toISOString(); reuse the
# engine's implementation so warehouse bytes match across the CSV/XLSX and plan
# paths (imported lazily inside _coerce to keep the read-side import graph light).
MAX_RESULT_ROWS = 200
MAX_RESULT_CHARS = 10_000

# INTEGER -> REAL -> TEXT is a one-way widening order.
TYPE_RANK = {"INTEGER": 0, "REAL": 1, "TEXT": 2}


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


# --- WRITE SIDE (R2 ingestion) --------------------------------------------


def attach_warehouse(conn: sqlite3.Connection, project_id: str) -> None:
    """ATTACH the project's warehouse as `wh`. Must be called OUTSIDE any transaction."""
    os.makedirs(warehouse_dir(), exist_ok=True)
    conn.execute("ATTACH DATABASE ? AS wh", (warehouse_path(project_id),))


def detach_warehouse(conn: sqlite3.Connection) -> None:
    conn.execute("DETACH DATABASE wh")


def _schema_of(conn: sqlite3.Connection, table: str) -> list[dict]:
    cols = conn.execute("SELECT name, type FROM wh.pragma_table_info(?)", (table,)).fetchall()
    return [
        {"name": c["name"], "type": c["type"] if c["type"] in ("INTEGER", "REAL", "TEXT") else "TEXT"}
        for c in cols
        if c["name"] != "_period"
    ]


def wh_family_tables(conn: sqlite3.Connection, family_key: str) -> list[dict]:
    """Every warehouse table of one family: `fam_<key>` plus `fam_<key>__*`."""
    base = f"fam_{family_key}"
    names = [
        r["name"]
        for r in conn.execute(
            "SELECT name FROM wh.sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
        if r["name"] == base or r["name"].startswith(f"{base}__")
    ]
    return [{"name": name, "columns": _schema_of(conn, name)} for name in names]


def compute_drift(existing: list[dict], incoming: list[dict]) -> list[str]:
    """Human-readable drift lines for the confirm UI. A brand-new family (no
    existing tables) has no drift. Order: new tables, missing tables, then
    per-common-table column drift."""
    if not existing:
        return []
    lines: list[str] = []
    ex_by_name = {t["name"]: t for t in existing}
    in_by_name = {t["name"]: t for t in incoming}
    for t in incoming:
        if t["name"] not in ex_by_name:
            lines.append(f"new table: {t['name']}")
    for t in existing:
        if t["name"] not in in_by_name:
            lines.append(f"missing table: {t['name']}")
    for t in incoming:
        ex = ex_by_name.get(t["name"])
        if not ex:
            continue
        ex_cols = {c["name"]: c for c in ex["columns"]}
        in_cols = {c["name"]: c for c in t["columns"]}
        for c in t["columns"]:
            if c["name"] not in ex_cols:
                lines.append(f"new column: {t['name']}.{c['name']} ({c['type']})")
        for c in t["columns"]:
            prev = ex_cols.get(c["name"])
            if prev and TYPE_RANK[c["type"]] > TYPE_RANK[prev["type"]]:
                lines.append(f"type change: {t['name']}.{c['name']} {prev['type']} → {c['type']}")
        for c in ex["columns"]:
            if c["name"] not in in_cols:
                lines.append(f"missing column: {t['name']}.{c['name']}")
    return lines


def apply_schema(conn: sqlite3.Connection, periodic: bool, incoming: list[dict]) -> None:
    """Create/extend warehouse tables to accept `incoming`. New columns are ADDed;
    type widening (INTEGER -> REAL -> TEXT, one-way) rebuilds the table preserving
    rows. Narrowing is ignored. Caller wraps this in its transaction."""
    for t in incoming:
        existing = _schema_of(conn, t["name"])
        exists = (
            conn.execute(
                "SELECT 1 FROM wh.sqlite_master WHERE type='table' AND name = ?", (t["name"],)
            ).fetchone()
            is not None
        )
        if not exists:
            cols = [f'{_q(c["name"])} {c["type"]}' for c in t["columns"]]
            if periodic:
                cols.append('"_period" TEXT NOT NULL')
            conn.execute(f'CREATE TABLE wh.{_q(t["name"])} ({", ".join(cols)})')
            continue
        ex_by_name = {c["name"]: c for c in existing}
        widened = any(
            ex_by_name.get(c["name"]) is not None
            and TYPE_RANK[c["type"]] > TYPE_RANK[ex_by_name[c["name"]]["type"]]
            for c in t["columns"]
        )
        if not widened:
            for c in t["columns"]:
                if c["name"] not in ex_by_name:
                    conn.execute(
                        f'ALTER TABLE wh.{_q(t["name"])} ADD COLUMN {_q(c["name"])} {c["type"]}'
                    )
            continue
        # Rebuild with the union schema at widened types (SQLite can't ALTER a column type).
        merged: list[dict] = []
        for prev in existing:
            inc = next((c for c in t["columns"] if c["name"] == prev["name"]), None)
            if inc and TYPE_RANK[inc["type"]] > TYPE_RANK[prev["type"]]:
                merged.append({"name": prev["name"], "type": inc["type"]})
            else:
                merged.append(prev)
        for c in t["columns"]:
            if not any(m["name"] == c["name"] for m in merged):
                merged.append(c)
        tmp = f'{t["name"]}__rebuild'
        conn.execute(f'ALTER TABLE wh.{_q(t["name"])} RENAME TO {_q(tmp)}')
        cols = [f'{_q(c["name"])} {c["type"]}' for c in merged]
        if periodic:
            cols.append('"_period" TEXT NOT NULL')
        conn.execute(f'CREATE TABLE wh.{_q(t["name"])} ({", ".join(cols)})')
        copy_cols = ", ".join(
            [_q(c["name"]) for c in existing] + (['"_period"'] if periodic else [])
        )
        conn.execute(
            f'INSERT INTO wh.{_q(t["name"])} ({copy_cols}) SELECT {copy_cols} FROM wh.{_q(tmp)}'
        )
        conn.execute(f'DROP TABLE wh.{_q(tmp)}')


def delete_rows(conn: sqlite3.Connection, tables: list[str], period: str | None) -> None:
    """Clear one period's rows (periodic) or all rows (constant, period=None)."""
    for t in tables:
        if period is None:
            conn.execute(f"DELETE FROM wh.{_q(t)}")
        else:
            conn.execute(f'DELETE FROM wh.{_q(t)} WHERE "_period" = ?', (period,))


def _coerce(v: object) -> object:
    """Bulk-insert cell coercion. None -> NULL; Dates/booleans -> String."""
    if v is None:
        return None
    # A Python bool is an int subclass, but JS `typeof true === "boolean"` (not
    # "number"), so a boolean falls to String(v) — check it before int/float.
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        return v
    if isinstance(v, _dt.datetime):
        from runoff_api.engine.tabular import _to_iso_string

        return _to_iso_string(v)
    return str(v)


def insert_rows(
    conn: sqlite3.Connection,
    table: str,
    columns: list[str],
    rows: list[list],
    period: str | None,
) -> None:
    """Bulk-insert one batch. Values: None -> NULL; Dates/booleans -> String."""
    if not rows:
        return
    cols = [_q(c) for c in columns] + (['"_period"'] if period is not None else [])
    placeholders = ", ".join("?" for _ in cols)
    sql = f'INSERT INTO wh.{_q(table)} ({", ".join(cols)}) VALUES ({placeholders})'
    for row in rows:
        # TS coerce(row[i]) maps a JS out-of-bounds `undefined` to NULL; a ragged
        # row shorter than `columns` must pad with None, not raise IndexError.
        vals = [_coerce(row[i]) if i < len(row) else None for i in range(len(columns))]
        conn.execute(sql, ([*vals, period] if period is not None else vals))
