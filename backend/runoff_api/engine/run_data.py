"""Engine run data block — statement-for-statement port of
packages/engine/src/runData.ts.

The RunData dict is the run's window onto the project warehouse, built by the
worker (or eval harness) and injected into the run engine — the engine never
opens the warehouse itself. Plain-dict runtime with camelCase keys:

  RunData {
    "catalog": list[CatalogFamily],   # bound families only; docs are queryable=False
    "exec": Callable[[str], SqlResult],  # read-only; binds :period; raises on SQL error
  }

  SqlResult {"columns": list[str], "rows": list[list]}

section_data_block renders the per-section data block: schema lines plus each
covering baked query (or synthesized defaults) with its result serialized by
core's format_sql_result; document families render through the pack unchanged.
"""

from __future__ import annotations

import re
from typing import Any

from ..core.warehouse import format_sql_result
from .source_pack import pack_for_prompt

DEFAULT_LIMIT = 40


def _default_queries(fam: dict) -> list[dict]:
    """`SELECT * … LIMIT 40` per table, used when no baked query covers the family."""
    out = []
    for t in fam["tables"]:
        if fam["kind"] == "periodic":
            sql = f'SELECT * FROM "{t["name"]}" WHERE _period = :period LIMIT {DEFAULT_LIMIT}'
        else:
            sql = f'SELECT * FROM "{t["name"]}" LIMIT {DEFAULT_LIMIT}'
        out.append({"name": f"default_{t['name']}", "sql": sql})
    return out


def _covers_family(sql: str, fam: dict) -> bool:
    """A query "covers" a family when any table name appears as a word in its SQL."""
    return any(re.search(rf"\b{t['name']}\b", sql) for t in fam["tables"])


_WS_RUN = re.compile(r"\s*\n\s*")


def _render_query(qy: dict, exec_fn: Any, lines: list[str]) -> None:
    flat_sql = _WS_RUN.sub(" ", qy["sql"]).strip()
    lines.append(f"-- {qy['name']}: {flat_sql}")
    try:
        lines.append(format_sql_result(exec_fn(qy["sql"])))
    except Exception as e:  # mirror TS: any thrown error becomes a `query failed` line
        lines.append(f"query failed: {e}")


def section_data_block(section: dict, data: dict, pack: dict) -> str:
    by_id = {f["id"]: f for f in data["catalog"]}
    exec_fn = data["exec"]
    parts: list[str] = []
    # SectionQuery dicts are unhashable; track coverage by object identity, the
    # semantics of TS's Set<SectionQuery>.
    covered: set[int] = set()
    for fam_id in section["familyIds"]:
        fam = by_id.get(fam_id)
        if not fam or not fam["queryable"]:
            packed = pack_for_prompt(pack, [fam_id])
            if packed:
                parts.append(packed)
            continue
        lines = [f"### {fam['label']} ({fam['id']})"]
        for t in fam["tables"]:
            cols = ", ".join(f"{c['name']} {c['type']}" for c in t["columns"])
            total = sum(t["rowCounts"].values())
            lines.append(f"{t['name']}({cols}) — {total:,} rows")
        baked = [qy for qy in section["queries"] if _covers_family(qy["sql"], fam)]
        for qy in baked:
            covered.add(id(qy))
        for qy in baked if baked else _default_queries(fam):
            _render_query(qy, exec_fn, lines)
        parts.append("\n".join(lines))

    # Baked queries that mention no bound family's table would otherwise never
    # execute (silent config rot). Run each once in a trailing block, same
    # rendering and error path as the per-family queries above.
    uncovered = [qy for qy in section["queries"] if id(qy) not in covered]
    if uncovered:
        lines = []
        for qy in uncovered:
            _render_query(qy, exec_fn, lines)
        parts.append("\n".join(lines))
    return "\n\n".join(parts)
