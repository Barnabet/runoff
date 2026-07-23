"""Port of the NON-LLM functions of packages/engine/src/goldenBinding.ts —
`parseSpanNumber`, `verifyInventory`, `boundnessLine`, `inventoryFromCitations` —
plus `compileLocator` from packages/engine/src/checks.ts.

`renderGoldenForPrompt`, `bindGolden`/`unifyGoldenReport` (LLM), and the rest of
checks.ts (evaluateAssert/auditCitations/countCitations) are R3 / out of scope.

Everything flows as plain dicts with camelCase keys (the TS runtime shape).
"""

import math
import re

from runoff_api.core.bindings import boundness_counts

# ── compileLocator (checks.ts) ──────────────────────────────────────────────

# Left side of the locator grammar: how citation locators reference a source
# column, optionally row-filtered: sum(src.amount where channel=search).
_AGG_REF = re.compile(
    r"^(sum|avg|min|max|count)\((\w+)\.(\w+)(?:\s+where\s+(\w+)\s*=\s*([^)]+?))?\)$",
    re.IGNORECASE,
)

_AGG_SQL = {"sum": "SUM", "avg": "AVG", "min": "MIN", "max": "MAX", "count": "COUNT"}


def _q(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


def _js_number(v: str) -> float | None:
    """Mirror JS Number(v) for the finite-numeric cases the filter uses; None for NaN."""
    t = v.strip()
    if t == "":
        return 0.0
    try:
        n = float(t)
    except ValueError:
        return None
    return n


def _num_str(n: float) -> str:
    """Mirror JS number→string in a template literal (integers print without a decimal)."""
    if n == int(n):
        return str(int(n))
    return repr(n)


def _filter_clause(col: str, raw_value: str) -> str:
    """Old pack semantics: case-insensitive string compare, plus numeric equality for numbers."""
    v = raw_value.strip()
    esc = v.replace("'", "''")
    text_eq = f"lower(CAST({_q(col)} AS TEXT)) = lower('{esc}')"
    n = _js_number(v)
    if v != "" and n is not None and math.isfinite(n):
        return f"({_q(col)} = {_num_str(n)} OR {text_eq})"
    return text_eq


def compile_locator(expression: str, catalog: list[dict]) -> dict:
    """Compile an aggregate locator to warehouse SQL. Non-count aggregates COALESCE
    to 0 so an empty match set computes 0 (the old pack semantics), not NULL.
    Raises ValueError when the expression is not locator grammar or the table is unknown.
    """
    ref = _AGG_REF.match(expression.strip())
    if not ref:
        raise ValueError(f"unparseable expression: {expression}")
    agg, table, column, filter_col, filter_val = ref.groups()
    family = next((f for f in catalog if any(t["name"] == table for t in f["tables"])), None)
    if family is None:
        raise ValueError(f"unknown table {table}")
    select = f"COUNT({_q(column)})" if agg == "count" else f"COALESCE({_AGG_SQL[agg]}({_q(column)}), 0)"
    where: list[str] = []
    if family["kind"] == "periodic":
        where.append("_period = :period")
    if filter_col:
        where.append(_filter_clause(filter_col, filter_val))
    sql = f"SELECT {select} FROM {_q(table)}" + (f" WHERE {' AND '.join(where)}" if where else "")
    return {"sql": sql, "family": family}


# ── parseSpanNumber (goldenBinding.ts) ──────────────────────────────────────

_SPAN_NUM = re.compile(r"^[$€£]?\s*(-?\d[\d,\s]*(?:\.\d+)?)\s*([KMB])?\s*(%)?$", re.IGNORECASE)


def parse_span_number(text: str) -> float | None:
    '''"$4,215,332" → 4215332 · "$4.2M" → 4200000 · "12.5%" → 0.125 · non-numeric → null.'''
    t = re.sub(r"^[~≈]", "", text.strip())
    m = _SPAN_NUM.match(t)
    if not m:
        return None
    n = _js_number(re.sub(r"[,\s]", "", m.group(1)))
    if n is None or not math.isfinite(n):
        return None
    if m.group(2):
        n *= {"K": 1e3, "M": 1e6, "B": 1e9}[m.group(2).upper()]
    if m.group(3):
        n /= 100
    # JS has one number type: an integral result serialises unsuffixed (JSON "4200000").
    # Return int when integral so to_json framing matches JS JSON.stringify byte-for-byte.
    if math.isfinite(n) and n == int(n):
        return int(n)
    return n


# ── verifyInventory (goldenBinding.ts) ──────────────────────────────────────


def _numbers_match(verified: float, parsed: float) -> bool:
    return abs(verified - parsed) <= max(0.005, 0.01 * abs(parsed))


def _is_number(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def verify_inventory(inv: dict, exec_fn, period: str | None, doc: dict | None = None) -> dict:
    """Execute every submitted binding and stamp verifiedValue + status (spec §6).

    `doc` is required to verify table col/row counts; value-only inventories may omit it.
    Re-verifying a stored inventory re-derives every stamp from scratch.
    """
    items: list[dict] = []
    for it in inv["items"]:
        if not it.get("binding"):
            reason = it["reason"] if it.get("reason") is not None else "unbound"
            items.append({**it, "binding": None, "reason": reason})
            continue
        family_id = it["binding"]["familyId"]
        sql = it["binding"]["sql"]

        def fail(status, reason, verified_value=None, _fid=family_id, _sql=sql, _it=it):
            return {
                **_it,
                "binding": {"familyId": _fid, "sql": _sql, "verifiedValue": verified_value, "status": status},
                "reason": reason,
            }

        if period is None and re.search(r":period\b", sql):
            items.append(fail("error", "golden has no period"))
            continue
        try:
            result = exec_fn(sql)
        except Exception as e:  # noqa: BLE001 — mirrors the TS catch-all
            reason = f"sql error: {str(e).split(chr(10))[0][:200]}"
            items.append(fail("error", reason))
            continue
        if it["kind"] == "table":
            block = _block_at(doc, it["anchor"]["sectionKey"], it["anchor"]["blockIndex"])
            want = (
                {"cols": len(block["columns"]), "rows": len(block["rows"])}
                if block and block.get("type") == "table"
                else None
            )
            n_rows = len(result["rows"])
            n_cols = len(result["columns"])
            if want and n_cols != want["cols"]:
                items.append(fail("mismatch", f"column count {n_cols} ≠ {want['cols']}", n_rows))
                continue
            if want and n_rows != want["rows"]:
                items.append(fail("mismatch", f"row count {n_rows} ≠ {want['rows']}", n_rows))
                continue
            items.append({
                **it,
                "binding": {"familyId": family_id, "sql": sql, "verifiedValue": n_rows, "status": "bound"},
                "reason": None,
            })
            continue
        if len(result["rows"]) != 1 or len(result["columns"]) != 1:
            items.append(fail("error", "sql did not return a single value"))
            continue
        cell = result["rows"][0][0]
        if _is_number(cell) or isinstance(cell, str):
            verified = cell
        elif cell is None:
            verified = None
        else:
            verified = str(cell)
        parsed = it["parsed"]
        if parsed is None:
            if verified is None:
                items.append(fail("error", "sql did not return a single value"))
            else:
                bound = {"familyId": family_id, "sql": sql, "verifiedValue": verified, "status": "bound"}
                items.append({**it, "binding": bound, "reason": None})
            continue
        if _is_number(parsed):
            ok = _is_number(verified) and _numbers_match(verified, parsed)
        else:
            ok = isinstance(verified, str) and verified.strip().lower() == parsed.strip().lower()
        if ok:
            bound = {"familyId": family_id, "sql": sql, "verifiedValue": verified, "status": "bound"}
            items.append({**it, "binding": bound, "reason": None})
        else:
            items.append(fail("mismatch", "value mismatch", verified))
    return {"version": 1, "items": items}


def _block_at(doc: dict | None, section_key: str, block_index: int) -> dict | None:
    """doc?.sections.find(s => s.key === key)?.blocks[blockIndex] — undefined on any miss."""
    if not doc:
        return None
    section = next((s for s in doc["sections"] if s["key"] == section_key), None)
    if section is None:
        return None
    blocks = section["blocks"]
    if block_index < 0 or block_index >= len(blocks):
        return None
    return blocks[block_index]


# ── boundnessLine (goldenBinding.ts) ────────────────────────────────────────


def boundness_line(inv: dict | None) -> str:
    c = boundness_counts(inv)
    if not c:
        return "not yet bound"
    if c["total"] == 0:
        return "nothing to bind"
    unbound = c["total"] - c["bound"] - c["mismatch"]
    return f"{c['bound']}/{c['total']} bound, {c['mismatch']} mismatch, {unbound} unbound"


# ── inventoryFromCitations (goldenBinding.ts) ───────────────────────────────


def inventory_from_citations(document: dict, catalog: list[dict], queries_for) -> dict:
    """Deterministic inventory for run/section goldens (spec §4): spans with
    citations → value items via compile_locator; table blocks → the section's
    first covering query (SQL references exactly one catalog table name).
    Item ids are anchor-derived and therefore stable across rebuilds.
    """
    items: list[dict] = []
    all_tables = [{"name": t["name"], "familyId": f["id"]} for f in catalog for t in f["tables"]]
    for section in document["sections"]:
        for block_index, block in enumerate(section["blocks"]):
            if block["type"] == "paragraph":
                for span_index, span in enumerate(block["spans"]):
                    if not span.get("citation"):
                        continue
                    anchor = {
                        "sectionKey": section["key"],
                        "blockIndex": block_index,
                        "spanIndex": span_index,
                    }
                    base = {
                        "id": f"{section['key']}_b{block_index}_s{span_index}",
                        "kind": "value",
                        "anchor": anchor,
                        "raw": span["text"][:200],
                        "parsed": parse_span_number(span["text"]),
                    }
                    try:
                        compiled = compile_locator(span["citation"]["locator"], catalog)
                        binding = {"familyId": compiled["family"]["id"], "sql": compiled["sql"]}
                        items.append({**base, "binding": binding, "reason": None})
                    except Exception as e:  # noqa: BLE001 — mirrors the TS catch-all
                        items.append({**base, "binding": None, "reason": str(e)})
            else:
                base = {
                    "id": f"{section['key']}_b{block_index}",
                    "kind": "table",
                    "anchor": {"sectionKey": section["key"], "blockIndex": block_index, "spanIndex": None},
                    "raw": f"table: {', '.join(block['columns'])}"[:200],
                    "parsed": None,
                }
                covering = None
                for query in queries_for(section["key"]):
                    hits = [t for t in all_tables if re.search(rf"\b{t['name']}\b", query["sql"])]
                    if len(hits) >= 1 and len({h["familyId"] for h in hits}) == 1:
                        covering = query
                        break
                if covering:
                    hit = next(t for t in all_tables if re.search(rf"\b{t['name']}\b", covering["sql"]))
                    binding = {"familyId": hit["familyId"], "sql": covering["sql"]}
                    items.append({**base, "binding": binding, "reason": None})
                else:
                    items.append({**base, "binding": None, "reason": "no query covers this table"})
    return {"version": 1, "items": items[:60]}
