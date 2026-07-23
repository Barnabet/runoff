"""Catalog serialization — statement-for-statement port of
packages/engine/src/catalogFormat.ts.

The catalog SHAPE lives in core (runoff_api.core.types.catalog); this module owns
the ~2-lines-per-table text rendering the run prompt consumes. Catalogs flow as
plain dicts with camelCase keys at runtime:
  CatalogFamily {"id","key","label","kind","granularity","queryable","tables","filedPeriods"}
  CatalogTable  {"name","columns","rowCounts"}
"""

from __future__ import annotations


def _family_head(f: dict) -> str:
    gran = f"periodic, {f['granularity']}" if f["kind"] == "periodic" else "constant"
    filed = f"; filed: {', '.join(f['filedPeriods'])}" if f["filedPeriods"] else ""
    return f"{f['key']} — \"{f['label']}\" ({gran}{filed})"


def _table_line(t: dict) -> str:
    cols = ", ".join(f"{c['name']} {c['type']}" for c in t["columns"])
    counts = list(t["rowCounts"].items())
    total = sum(n for _, n in counts)
    per_period = (
        f" ({', '.join(f'{p}: {n}' for p, n in counts)})"
        if len(counts) > 1 or (len(counts) == 1 and counts[0][0] != "")
        else ""
    )
    return f"  {t['name']}({cols}) — {total:,} rows{per_period}"


def serialize_catalog(families: list[dict]) -> str:
    """~2 lines per table; document families collapse to one annotated line."""
    return "\n".join(
        "\n".join([_family_head(f)] + [_table_line(t) for t in f["tables"]])
        if f["queryable"]
        else f"{_family_head(f)} — document, not queryable"
        for f in families
    )
