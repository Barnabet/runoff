"""Deterministic ParsePlan executor — statement-for-statement port of
packages/engine/src/parsePlan.ts.

TOTAL: never throws — anchoring/mapping failures become byte-exact `problems`
lines and the table yields no rows. Ingest callers throw the first problem;
preview callers render them.

Runtime shapes are plain dicts with camelCase keys:
  SheetGrid  {"sheet", "grid"}
  ExecTable  {"logical", "columns", "rows"}
  WhColumn   {"name", "type"}
  report     mirrors core.types.parse_plan.ExecReport (camelCase)

Numeric parity: TS coerce_cell uses JS ``Number(s)`` (NOT ``parseFloat`` — so
core.diff._parse_float does not apply here); ``_js_number`` below replicates
``Number`` and, like engine.tabular._js_number, collapses integral floats to int
so the coerced values stringify identically to JS for the warehouse byte-compare.
Date handling reuses engine.tabular._to_iso_string for JS ``Date.toISOString``.
"""

from __future__ import annotations

import datetime as _dt
import math
import os
import re
from typing import Any

from ..core.types.parse_plan import plan_pattern
from .tabular import _to_iso_string, csv_grid, slugify, xlsx_grids


def _js_string(v: Any) -> str:
    """String(v) for the value kinds a grid holds — JS number/bool/Date semantics.

    Integral floats collapse to their int form (JS has one Number type, so
    String(20)=="20", never "20.0"); datetimes emit stable ISO (see tabular)."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        if math.isfinite(v) and v.is_integer():
            return str(int(v))
        return str(v)
    if isinstance(v, _dt.datetime):
        return _to_iso_string(v)
    return str(v)


def norm_cell(v: Any) -> str:
    if v is None:
        return ""
    return re.sub(r"\s+", " ", _js_string(v).strip().lower())


def raw_cell(v: Any) -> str:
    if v is None:
        return ""
    return _js_string(v).strip()


def load_grids(path: str, mime: str, name: str) -> list[dict]:
    is_csv = "csv" in mime.lower() or os.path.splitext(name)[1].lower() == ".csv"
    if is_csv:
        return [{"sheet": slugify(re.sub(r"\.[^.]+$", "", name)), "grid": csv_grid(path)}]
    return [{"sheet": s["slug"], "grid": s["grid"]} for s in xlsx_grids(path)]


def _at(row: list, c: int) -> Any:
    """row[c] with JS out-of-bounds semantics (undefined -> None here)."""
    return row[c] if 0 <= c < len(row) else None


def _row_matches_anchor(row: list, t: dict) -> bool:
    cells = {s for s in (norm_cell(c) for c in row) if s != ""}
    sig = list(dict.fromkeys(norm_cell(s) for s in t["anchor"]["headerSignature"]))
    hits = 0
    for s in sig:
        if s in cells:
            hits += 1
    return hits >= min(t["anchor"]["minMatch"], len(sig))


def _resolve_anchors(grids: list[dict], plan: dict) -> dict:
    """Resolve every table's anchor. Plan order; sheet hint reorders the scan; a
    row anchors at most one table. Returns {table_name: {"sheetIdx","row"} | None}."""
    out: dict[str, dict | None] = {}
    used: set[str] = set()  # `${sheetIdx}:${row}`
    for t in plan["tables"]:
        hint_sheet = t["anchor"].get("sheet")

        def hint(i: int, _h: Any = hint_sheet) -> int:
            return 0 if _h is not None and grids[i]["sheet"] == _h else 1

        order = sorted(range(len(grids)), key=lambda i: (hint(i), i))
        found: dict | None = None
        for si in order:
            grid = grids[si]["grid"]
            for r in range(len(grid)):
                if f"{si}:{r}" in used:
                    continue
                if _row_matches_anchor(grid[r] if grid[r] is not None else [], t):
                    found = {"sheetIdx": si, "row": r}
                    break
            if found is not None:
                break
        if found is not None:
            used.add(f"{found['sheetIdx']}:{found['row']}")
        out[t["name"]] = found
    return out


def _extract_region(grids: list[dict], plan: dict, t: dict, at: dict) -> dict:
    grid = grids[at["sheetIdx"]]["grid"]
    header_rows = grid[at["row"]: at["row"] + t["headerRows"]]
    max_col = max([len(r if r is not None else []) for r in header_rows] + [0])
    merged_norm: dict[int, str] = {}
    merged_raw: dict[int, str] = {}
    matched_cols: list[int] = []
    for c in range(max_col):
        hcells = [r if r is not None else [] for r in header_rows]
        norm = " ".join(s for s in (norm_cell(_at(r, c)) for r in hcells) if s != "")
        raw = " ".join(s for s in (raw_cell(_at(r, c)) for r in hcells) if s != "")
        if norm == "":
            continue
        merged_norm[c] = norm
        merged_raw[c] = raw
        matched_cols.append(c)

    problems: list[str] = []
    col_for: dict[str, int] = {}
    claimed: set[int] = set()
    for cp in t["columns"]:
        want = norm_cell(cp["from"])
        col = next((c for c in matched_cols if merged_norm[c] == want and c not in claimed), None)
        if col is None:
            problems.append(f"missing column: {t['name']}.{cp['from']}")
            continue
        claimed.add(col)
        col_for[cp["name"]] = col

    unpivot = t.get("unpivot")
    value_re = plan_pattern(unpivot["valuePattern"]) if unpivot else None
    value_cols: list[int] = []
    unknown: list[str] = []
    for c in matched_cols:
        if c in claimed:
            continue
        if value_re is not None and value_re.search(merged_norm[c]):
            value_cols.append(c)
            continue
        unknown.append(merged_raw[c])

    # Data rows: below the header until 2 consecutive rows blank across matched
    # columns, a row that anchors ANOTHER plan table, or sheet end.
    others = [o for o in plan["tables"] if o["name"] != t["name"]]
    data_rows: list[list] = []
    blanks = 0
    for r in range(at["row"] + t["headerRows"], len(grid)):
        row = grid[r] if grid[r] is not None else []
        blank = all(norm_cell(_at(row, c)) == "" for c in matched_cols)
        if blank:
            blanks += 1
            if blanks >= 2:
                break
            continue
        blanks = 0
        if any(_row_matches_anchor(row, o) for o in others):
            break
        data_rows.append(row)
    return {
        "matchedCols": matched_cols,
        "mergedNorm": merged_norm,
        "mergedRaw": merged_raw,
        "colFor": col_for,
        "unknown": unknown,
        "valueCols": value_cols,
        "dataRows": data_rows,
        "problems": problems,
    }


def _output_columns(t: dict) -> list[dict]:
    """Output schema for one table plan (unpivot-aware)."""
    unpivot = t.get("unpivot")
    if not unpivot:
        return [{"name": c["name"], "type": c["type"]} for c in t["columns"]]
    keep = [c for c in t["columns"] if c["name"] in unpivot["keep"]]
    return [
        *({"name": c["name"], "type": c["type"]} for c in keep),
        {"name": unpivot["keyColumn"], "type": "TEXT"},
        {"name": unpivot["valueColumn"], "type": unpivot["valueType"]},
    ]


def execute_parse_plan(
    grids: list[dict], plan: dict, slot_period: str | None, granularity: str | None,
) -> dict:
    anchors = _resolve_anchors(grids, plan)
    tables: list[dict] = []
    report: dict = {"tables": []}
    for t in plan["tables"]:
        at = anchors.get(t["name"])
        rep: dict = {
            "name": t["name"],
            "anchor": {"sheet": grids[at["sheetIdx"]]["sheet"], "row": at["row"]} if at else None,
            "problems": [],
            "rowsKept": 0,
            "rowsExcluded": [],
            "coercionFailures": [],
            "periodMismatches": None,
            "unknownColumns": [],
        }
        out_cols = _output_columns(t)
        if not at:
            rep["problems"].append(f"unanchored table: {t['name']}")
            tables.append({"logical": t["name"], "columns": out_cols, "rows": []})
            report["tables"].append(rep)
            continue
        ex = _extract_region(grids, plan, t, at)
        rep["unknownColumns"] = ex["unknown"]
        if ex["problems"]:
            rep["problems"].extend(ex["problems"])
            tables.append({"logical": t["name"], "columns": out_cols, "rows": []})
            report["tables"].append(rep)
            continue
        rows = _process_rows(t, ex, rep, slot_period, granularity)
        rep["rowsKept"] = len(rows)
        tables.append({"logical": t["name"], "columns": out_cols, "rows": rows})
        report["tables"].append(rep)
    return {"tables": tables, "report": report}


# --- coercion --------------------------------------------------------------

_MONTHS_3 = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
             "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}


def _month_no(s: str) -> int | None:
    return _MONTHS_3.get(s[:3].lower())


def _iso_date(y: int, m: int, d: int) -> str | None:
    return f"{y}-{m:02d}-{d:02d}" if 1 <= m <= 12 and 1 <= d <= 31 else None


_JS_DEC_RE = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")


def _js_number(s: str) -> int | float:
    """JS ``Number(s)`` — returns NaN for JS-invalid input; integral finite values
    collapse to int so they stringify like a JS Number (see tabular._js_number)."""
    if s == "":
        return 0
    if re.match(r"^0[xX][0-9a-fA-F]+$", s):
        return int(s, 16)
    if re.match(r"^0[oO][0-7]+$", s):
        return int(s, 8)
    if re.match(r"^0[bB][01]+$", s):
        return int(s, 2)
    if s in ("Infinity", "+Infinity"):
        return math.inf
    if s == "-Infinity":
        return -math.inf
    if _JS_DEC_RE.match(s):
        v = float(s)
        return int(v) if math.isfinite(v) and v.is_integer() else v
    return math.nan


def _collapse(x: int | float) -> int | float:
    return int(x) if isinstance(x, float) and math.isfinite(x) and x.is_integer() else x


def _iso_from_datetime(v: _dt.datetime) -> str:
    return _to_iso_string(v)[:10]


def coerce_cell(v: Any, parse: str | None) -> dict:
    """Coerce one non-empty cell. `failed: True` ⇒ out is None and it is counted."""
    if parse is None:
        return {"out": v, "failed": False}
    if parse == "date":
        # TOTAL guarantee: an invalid date must fail coercion, never throw.
        if isinstance(v, _dt.datetime):
            return {"out": _iso_from_datetime(v), "failed": False}
        # Excel serial dates: a genuine date-typed cell can arrive as a raw serial
        # number. Convert finite serials in a sane range (≈1954–2119) so ordinary
        # small integers like 7 still fail.
        is_num = isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
        if is_num and 20000 <= v <= 80000:
            epoch = _dt.datetime(1899, 12, 30, tzinfo=_dt.UTC)
            d = epoch + _dt.timedelta(milliseconds=v * 86400000)
            return {"out": _iso_from_datetime(d), "failed": False}
        s = raw_cell(v)
        # ISO datetime (a real Date cell stringifies to a full ISO string).
        if re.match(r"^\d{4}-\d{2}-\d{2}T", s):
            return {"out": s[:10], "failed": False}
        m = re.match(r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$", s)
        if m:
            iso = _iso_date(int(m[1]), int(m[2]), int(m[3]))
            return {"out": iso, "failed": False} if iso else {"out": None, "failed": True}
        m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", s)  # US month-first
        if m:
            iso = _iso_date(int(m[3]), int(m[1]), int(m[2]))
            return {"out": iso, "failed": False} if iso else {"out": None, "failed": True}
        m = re.match(r"^(\d{1,2})[ -]([A-Za-z]{3,9}),?[ -](\d{4})$", s)
        if m:
            mo = _month_no(m[2])
            iso = _iso_date(int(m[3]), mo, int(m[1])) if mo else None
            return {"out": iso, "failed": False} if iso else {"out": None, "failed": True}
        m = re.match(r"^([A-Za-z]{3,9}) (\d{1,2}),? (\d{4})$", s)
        if m:
            mo = _month_no(m[1])
            iso = _iso_date(int(m[3]), mo, int(m[2])) if mo else None
            return {"out": iso, "failed": False} if iso else {"out": None, "failed": True}
        return {"out": None, "failed": True}
    if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
        return {"out": v, "failed": False}
    s = raw_cell(v)
    if parse == "percent":
        s = re.sub(r"%$", "", s).strip()
        n = _js_number(re.sub(r"[,\s]", "", s))
        if math.isfinite(n) and s != "":
            return {"out": _collapse(n / 100), "failed": False}
        return {"out": None, "failed": True}
    if parse == "currency":
        s = re.sub(r"^[$€£]\s*", "", s)
        s = re.sub(r"\s*[$€£]$", "", s)
    s = re.sub(r"[,\s]", "", s)
    n = _js_number(s)
    if math.isfinite(n) and s != "":
        return {"out": n, "failed": False}
    return {"out": None, "failed": True}


def derive_period(iso: str, granularity: str) -> str:
    y = iso[0:4]
    m = int(iso[5:7])
    if granularity == "quarter":
        return f"{y}-Q{math.ceil(m / 3)}"
    if granularity == "month":
        return f"{y}-{m:02d}"
    return y


def _process_rows(
    t: dict, ex: dict, rep: dict, slot_period: str | None, granularity: str | None,
) -> list[list]:
    """Row filtering + output building: coercions, unpivot fan-out, period validation."""
    header_norm_by_col = ex["mergedNorm"]
    matched_cols = ex["matchedCols"]
    col_for = ex["colFor"]
    exclude_counters: dict[str, dict] = {}

    def row_sample(row: list) -> str:
        return " | ".join(raw_cell(_at(row, c)) for c in matched_cols)[:80]

    rows: list[list] = []

    def is_empty_cell(v: Any) -> bool:
        return v is None or (isinstance(v, str) and v.strip() == "")

    coercion_counters: dict[str, dict] = {}

    def note_failure(column: str, raw: Any) -> None:
        c = coercion_counters.setdefault(column, {"count": 0, "samples": []})
        c["count"] += 1
        if len(c["samples"]) < 3:
            c["samples"].append(raw_cell(raw)[:40])

    def coerced(cp: dict, raw: Any) -> Any:
        if is_empty_cell(raw):
            return None
        res = coerce_cell(raw, cp.get("parse"))
        if res["failed"]:
            note_failure(cp["name"], raw)
        return res["out"]

    mismatch_count = 0
    mismatch_samples: list[str] = []
    unpivot = t.get("unpivot")
    keep_cols = [c for c in t["columns"] if c["name"] in unpivot["keep"]] if unpivot else t["columns"]
    period_column = t.get("periodColumn")

    for row in ex["dataRows"]:
        # repeated page header: matched cells equal the (first) header row
        if all(norm_cell(_at(row, c)) == header_norm_by_col.get(c) for c in matched_cols):
            continue
        dropped = False
        for rule in t["exclude"]:
            re_ = plan_pattern(rule["pattern"])
            if rule["column"] is None:
                hit = any(re_.search(raw_cell(_at(row, c))) for c in matched_cols)
            else:
                hit = bool(re_.search(raw_cell(_at(row, col_for[rule["column"]]))))
            if hit:
                c = exclude_counters.setdefault(rule["pattern"], {"count": 0, "samples": []})
                c["count"] += 1
                if len(c["samples"]) < 3:
                    c["samples"].append(row_sample(row))
                dropped = True
                break
        if dropped:
            continue

        base = [coerced(cp, _at(row, col_for[cp["name"]])) for cp in keep_cols]

        # Period validation (plain and unpivot rows alike; the source row decides).
        period_ok = True
        if period_column and slot_period and granularity:
            cp = next(c for c in t["columns"] if c["name"] == period_column)
            raw = _at(row, col_for[cp["name"]])
            out = None if is_empty_cell(raw) else coerce_cell(raw, "date")["out"]
            derived = derive_period(out, granularity) if isinstance(out, str) else None
            if derived != slot_period:
                mismatch_count += 1
                if len(mismatch_samples) < 3:
                    mismatch_samples.append(row_sample(row))
                if t.get("onPeriodMismatch") == "exclude":
                    period_ok = False
        if not period_ok:
            continue

        if not unpivot:
            rows.append(base)
            continue
        for c in ex["valueCols"]:
            raw = _at(row, c)
            if is_empty_cell(raw):
                continue
            res = coerce_cell(raw, unpivot.get("valueParse"))
            if res["failed"]:
                note_failure(unpivot["valueColumn"], raw)
            rows.append([*base, ex["mergedRaw"][c], res["out"]])

    rep["rowsExcluded"] = [{"pattern": pattern, **c} for pattern, c in exclude_counters.items()]
    rep["coercionFailures"] = [{"column": column, **c} for column, c in coercion_counters.items()]
    if period_column and slot_period and granularity:
        rep["periodMismatches"] = {"count": mismatch_count, "samples": mismatch_samples}
    else:
        rep["periodMismatches"] = None
    return rows


def fit_parse_plan(grids: list[dict], plan: dict) -> dict:
    anchors = _resolve_anchors(grids, plan)
    detail: list[str] = []
    anchored = 0
    clean = 0
    for t in plan["tables"]:
        at = anchors.get(t["name"])
        if not at:
            detail.append(f"unanchored table: {t['name']}")
            continue
        anchored += 1
        ex = _extract_region(grids, plan, t, at)
        detail.extend(ex["problems"])
        for u in ex["unknown"]:
            detail.append(f"unknown column: {u}")
        if not ex["problems"]:
            clean += 1
    verdict = "no_fit" if anchored == 0 else "fit" if clean == len(plan["tables"]) else "partial"
    return {"verdict": verdict, "detail": detail}
