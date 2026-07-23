"""Port of packages/engine/test/parsePlan.test.ts — the ParsePlan executor.

Core-side cases (packages/core/test/parsePlan.test.ts) are already ported in
test_types_parse_plan.py and are NOT duplicated here.

Deliberate deviation from TS at the XLSX boundary: TS's streaming WorkbookReader
emits a genuine date-typed cell as a raw Excel serial number; openpyxl (Task 3's
xlsx_grids) resolves it to a datetime that _cell_value stringifies to a full ISO
timestamp. Both reach the SAME coerced value ("2026-05-07") via different
coerce_cell branches (serial vs ISO-datetime). The serial branch is exercised
directly with an integer grid cell, mirroring TS.
"""

import datetime as _dt
import os
import tempfile

from openpyxl import Workbook

from runoff_api.engine.parse_plan import (
    coerce_cell,
    derive_period,
    execute_parse_plan,
    fit_parse_plan,
    load_grids,
    norm_cell,
    raw_cell,
)


def g(sheet, grid):
    return {"sheet": sheet, "grid": grid}


AGING = {
    "version": 1,
    "tables": [{
        "name": "aging",
        "anchor": {"sheet": "ar_aging",
                   "headerSignature": ["customer", "status", "amount due ($)"], "minMatch": 2},
        "headerRows": 1,
        "exclude": [{"column": "customer", "pattern": "^grand total$"}],
        "columns": [
            {"from": "customer", "name": "customer", "type": "TEXT"},
            {"from": "status", "name": "status", "type": "TEXT"},
            {"from": "amount due ($)", "name": "amount_due", "type": "REAL"},
        ],
        "onPeriodMismatch": "keep",
    }],
}

MESSY_GRID = [
    ["AR Aging Report — Q2 2026"],                       # glued title, no blank row below
    ["Customer", "Status", "Amount Due ($)"],
    ["Acme", "open", 1200],
    ["Beta", "paid", 800],
    ["Customer", "Status", "Amount Due ($)"],            # repeated page header
    ["Gamma", "open", 400],
    ["Grand Total", "", 2400],
]


# --- anchoring + region ----------------------------------------------------


# Ports "anchors by signature past a glued title; title never corrupts the header".
def test_anchors_by_signature_past_glued_title():
    out = execute_parse_plan([g("ar_aging", MESSY_GRID)], AGING, None, None)
    tables, report = out["tables"], out["report"]
    assert report["tables"][0]["anchor"] == {"sheet": "ar_aging", "row": 1}
    assert [c["name"] for c in tables[0]["columns"]] == ["customer", "status", "amount_due"]
    assert report["tables"][0]["problems"] == []


# Ports "drops repeated headers and excluded totals, counting them with samples".
def test_drops_repeated_headers_and_excluded_totals():
    out = execute_parse_plan([g("ar_aging", MESSY_GRID)], AGING, None, None)
    tables, report = out["tables"], out["report"]
    assert [r[0] for r in tables[0]["rows"]] == ["Acme", "Beta", "Gamma"]
    assert report["tables"][0]["rowsKept"] == 3
    assert report["tables"][0]["rowsExcluded"] == [
        {"pattern": "^grand total$", "count": 1, "samples": ["Grand Total |  | 2400"]},
    ]


# Ports "anchors on a renamed sheet (hint mismatch is not a failure)".
def test_anchors_on_renamed_sheet():
    out = execute_parse_plan([g("totally_new_name", MESSY_GRID)], AGING, None, None)
    assert out["report"]["tables"][0]["anchor"] == {"sheet": "totally_new_name", "row": 1}


# Ports "region ends at 2 consecutive blank rows".
def test_region_ends_at_two_consecutive_blank_rows():
    grid = [
        ["Customer", "Status", "Amount Due ($)"],
        ["Acme", "open", 1],
        [None, None, None],
        [None, None, None],
        ["Footer note that is not data", "", ""],
    ]
    out = execute_parse_plan([g("s", grid)], AGING, None, None)
    assert len(out["tables"][0]["rows"]) == 1


# Ports "single blank row inside a table is skipped, not terminal".
def test_single_blank_row_inside_table_is_skipped():
    grid = [
        ["Customer", "Status", "Amount Due ($)"],
        ["Acme", "open", 1],
        [None, None, None],
        ["Beta", "paid", 2],
    ]
    out = execute_parse_plan([g("s", grid)], AGING, None, None)
    assert len(out["tables"][0]["rows"]) == 2


# Ports "merges 2-row headers before matching columns".
def test_merges_two_row_headers_before_matching_columns():
    plan = {
        "version": 1,
        "tables": [{
            "name": "t",
            "anchor": {"headerSignature": ["region"], "minMatch": 1},
            "headerRows": 2,
            "exclude": [],
            "columns": [
                {"from": "region", "name": "region", "type": "TEXT"},
                {"from": "2026 q1", "name": "q1", "type": "REAL"},
            ],
            "onPeriodMismatch": "keep",
        }],
    }
    grid = [
        ["Region", "2026", None],
        [None, "Q1", "Q2"],
        ["EMEA", 10, 20],
    ]
    out = execute_parse_plan([g("s", grid)], plan, None, None)
    assert out["tables"][0]["rows"] == [["EMEA", 10]]
    assert out["report"]["tables"][0]["unknownColumns"] == ["Q2"]


# Ports "region stops where another table's anchor begins".
def test_region_stops_where_another_anchor_begins():
    plan = {
        "version": 1,
        "tables": [
            {"name": "a", "anchor": {"headerSignature": ["region", "revenue"], "minMatch": 2},
             "headerRows": 1, "exclude": [], "onPeriodMismatch": "keep",
             "columns": [{"from": "region", "name": "region", "type": "TEXT"},
                         {"from": "revenue", "name": "revenue", "type": "REAL"}]},
            {"name": "b", "anchor": {"headerSignature": ["channel", "share"], "minMatch": 2},
             "headerRows": 1, "exclude": [], "onPeriodMismatch": "keep",
             "columns": [{"from": "channel", "name": "channel", "type": "TEXT"},
                         {"from": "share", "name": "share", "type": "REAL"}]},
        ],
    }
    grid = [
        ["Region", "Revenue"],
        ["EMEA", 10],
        ["Channel", "Share"],   # no blank row between the tables
        ["online", 0.6],
    ]
    out = execute_parse_plan([g("s", grid)], plan, None, None)
    assert out["tables"][0]["rows"] == [["EMEA", 10]]
    assert out["tables"][1]["rows"] == [["online", 0.6]]


# --- problems --------------------------------------------------------------


# Ports "unanchored table produces no rows and the byte-exact problem line".
def test_unanchored_table_produces_no_rows_and_problem_line():
    out = execute_parse_plan([g("s", [["nothing", "here"]])], AGING, None, None)
    assert out["report"]["tables"][0]["problems"] == ["unanchored table: aging"]
    assert out["tables"][0]["rows"] == []


# Ports "missing mapped column is a problem; table yields no rows".
def test_missing_mapped_column_is_a_problem():
    grid = [["Customer", "Status"], ["Acme", "open"]]
    out = execute_parse_plan([g("s", grid)], AGING, None, None)
    assert out["report"]["tables"][0]["problems"] == ["missing column: aging.amount due ($)"]
    assert out["tables"][0]["rows"] == []


# --- fitParsePlan ----------------------------------------------------------


# Ports "fit / partial / no_fit with byte-exact detail".
def test_fit_partial_no_fit_with_byte_exact_detail():
    assert fit_parse_plan([g("ar_aging", MESSY_GRID)], AGING)["verdict"] == "fit"
    partial = fit_parse_plan([g("s", [["Customer", "Status"], ["x", "y"]])], AGING)
    assert partial["verdict"] == "partial"
    assert "missing column: aging.amount due ($)" in partial["detail"]
    nofit = fit_parse_plan([g("s", [["a", "b"], ["c", "d"]])], AGING)
    assert nofit["verdict"] == "no_fit"
    assert "unanchored table: aging" in nofit["detail"]


# Ports "reports unknown columns as info without degrading fit".
def test_reports_unknown_columns_without_degrading_fit():
    grid = [["Customer", "Status", "Amount Due ($)", "Mystery"], ["a", "b", 1, 2]]
    fit = fit_parse_plan([g("s", grid)], AGING)
    assert fit["verdict"] == "fit"
    assert "unknown column: Mystery" in fit["detail"]


# --- coercions -------------------------------------------------------------


def _coerce_plan(parse, type_="REAL"):
    v_col = {"from": "v", "name": "v", "type": type_}
    if parse:
        v_col["parse"] = parse
    return {
        "version": 1,
        "tables": [{
            "name": "t",
            "anchor": {"headerSignature": ["k", "v"], "minMatch": 2},
            "headerRows": 1, "exclude": [],
            "columns": [{"from": "k", "name": "k", "type": "TEXT"}, v_col],
            "onPeriodMismatch": "keep",
        }],
    }


def _run(plan, v):
    return execute_parse_plan([g("s", [["k", "v"], ["a", v]])], plan, None, None)


def _val(plan, v):
    return _run(plan, v)["tables"][0]["rows"][0][1]


XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


# Ports "currency strips symbols and separators".
def test_currency_strips_symbols_and_separators():
    assert _val(_coerce_plan("currency"), "$1,234.56") == 1234.56
    # separators stripped; EU decimals out of scope
    assert _val(_coerce_plan("currency"), "1 234,56 €") == 123456


# Ports "number handles thousands separators; '007' maps to 7 only with parse".
def test_number_thousands_and_leading_zeros():
    assert _val(_coerce_plan("number"), "12,000") == 12000
    assert _val(_coerce_plan(None, "TEXT"), "007") == "007"
    assert _val(_coerce_plan("number"), "007") == 7


# Ports "percent: strings divide by 100, XLSX numerics pass through".
def test_percent_strings_divide_numerics_pass_through():
    assert _val(_coerce_plan("percent"), "12%") == 0.12
    assert _val(_coerce_plan("percent"), "12") == 0.12
    assert _val(_coerce_plan("percent"), 0.12) == 0.12


# Ports "date: Date instances and each pinned string format → YYYY-MM-DD".
def test_date_instances_and_string_formats():
    assert _val(_coerce_plan("date", "TEXT"), _dt.datetime(2026, 5, 7)) == "2026-05-07"
    assert _val(_coerce_plan("date", "TEXT"), "2026-05-07") == "2026-05-07"
    assert _val(_coerce_plan("date", "TEXT"), "2026/5/7") == "2026-05-07"
    assert _val(_coerce_plan("date", "TEXT"), "5/7/2026") == "2026-05-07"  # US month-first
    assert _val(_coerce_plan("date", "TEXT"), "7 May 2026") == "2026-05-07"
    assert _val(_coerce_plan("date", "TEXT"), "May 7, 2026") == "2026-05-07"


# Ports "date: Excel serials in range coerce; small integers still fail; ISO datetime truncates".
def test_date_serials_small_ints_and_iso_datetime():
    # 46149 = 2026-05-07 (Excel 1900 serial, Dec 30 1899 epoch).
    assert _val(_coerce_plan("date", "TEXT"), 46149) == "2026-05-07"
    assert _val(_coerce_plan("date", "TEXT"), "2026-05-07T00:00:00.000Z") == "2026-05-07"
    small_int = _run(_coerce_plan("date", "TEXT"), 7)
    assert small_int["tables"][0]["rows"][0][1] is None  # ordinary integer, not a serial date
    assert small_int["report"]["tables"][0]["coercionFailures"][0]["column"] == "v"


# Ports "failed coercions become NULL and are counted with samples".
def test_failed_coercions_become_null_and_counted():
    out = _run(_coerce_plan("number"), "n/a")
    assert out["tables"][0]["rows"][0][1] is None
    assert out["report"]["tables"][0]["coercionFailures"] == [{"column": "v", "count": 1, "samples": ["n/a"]}]


# Ports "empty cells are NULL and never counted as failures".
def test_empty_cells_are_null_and_never_counted():
    out = _run(_coerce_plan("number"), "   ")
    assert out["report"]["tables"][0]["coercionFailures"] == []


# --- unpivot ---------------------------------------------------------------


WIDE = {
    "version": 1,
    "tables": [{
        "name": "monthly",
        "anchor": {"headerSignature": ["region"], "minMatch": 1},
        "headerRows": 1, "exclude": [],
        "columns": [{"from": "region", "name": "region", "type": "TEXT"}],
        "unpivot": {"keep": ["region"], "valuePattern": r"^[a-z]{3} \d{4}$", "keyColumn": "month",
                    "valueColumn": "amount", "valueType": "REAL", "valueParse": "currency"},
        "onPeriodMismatch": "keep",
    }],
}


# Ports "melts matched columns into key/value rows; empty values skipped; key keeps raw casing".
def test_unpivot_melts_matched_columns():
    grid = [
        ["Region", "Apr 2026", "May 2026", "Note"],
        ["EMEA", "$10.00", "$20.00", "x"],
        ["AMER", "$5.00", None, "y"],
    ]
    out = execute_parse_plan([g("s", grid)], WIDE, None, None)
    tables, report = out["tables"], out["report"]
    assert [c["name"] for c in tables[0]["columns"]] == ["region", "month", "amount"]
    assert tables[0]["rows"] == [
        ["EMEA", "Apr 2026", 10],
        ["EMEA", "May 2026", 20],
        ["AMER", "Apr 2026", 5],
    ]
    assert report["tables"][0]["unknownColumns"] == ["Note"]
    assert report["tables"][0]["rowsKept"] == 3


# Ports "a NEW month column fits the pattern without any plan change".
def test_unpivot_new_month_column_fits_pattern():
    grid2 = [["Region", "Jun 2026"], ["EMEA", "$7.00"]]
    out = execute_parse_plan([g("s", grid2)], WIDE, None, None)
    assert out["tables"][0]["rows"] == [["EMEA", "Jun 2026", 7]]


# --- period validation -----------------------------------------------------


P = {
    "version": 1,
    "tables": [{
        "name": "tx",
        "anchor": {"headerSignature": ["id", "booked"], "minMatch": 2},
        "headerRows": 1, "exclude": [],
        "columns": [
            {"from": "id", "name": "id", "type": "TEXT"},
            {"from": "booked", "name": "booked", "type": "TEXT", "parse": "date"},
        ],
        "periodColumn": "booked",
        "onPeriodMismatch": "keep",
    }],
}
PERIOD_GRID = [
    ["Id", "Booked"],
    ["a", "2026-05-01"],   # Q2 — matches
    ["b", "2026-07-09"],   # Q3 — mismatch
    ["c", "bogus"],        # unparseable date — mismatch AND coercion failure
]


# Ports "derivePeriod covers all three granularities".
def test_derive_period_all_granularities():
    assert derive_period("2026-05-07", "quarter") == "2026-Q2"
    assert derive_period("2026-05-07", "month") == "2026-05"
    assert derive_period("2026-05-07", "year") == "2026"


# Ports "keep: mismatches counted with samples, rows kept".
def test_period_keep_mismatches_counted_rows_kept():
    out = execute_parse_plan([g("s", PERIOD_GRID)], P, "2026-Q2", "quarter")
    assert len(out["tables"][0]["rows"]) == 3
    assert out["report"]["tables"][0]["periodMismatches"] == {
        "count": 2, "samples": ["b | 2026-07-09", "c | bogus"]}


# Ports "exclude: mismatched rows dropped".
def test_period_exclude_mismatched_rows_dropped():
    t0 = dict(P["tables"][0])
    t0["onPeriodMismatch"] = "exclude"
    excl = {"version": 1, "tables": [t0]}
    out = execute_parse_plan([g("s", PERIOD_GRID)], excl, "2026-Q2", "quarter")
    assert [r[0] for r in out["tables"][0]["rows"]] == ["a"]
    assert out["report"]["tables"][0]["periodMismatches"]["count"] == 2


# Ports "no slot period (constant/preview without period) → validation skipped".
def test_period_no_slot_period_skips_validation():
    out = execute_parse_plan([g("s", PERIOD_GRID)], P, None, None)
    assert out["report"]["tables"][0]["periodMismatches"] is None


# --- date coercion through load_grids (genuine XLSX date cells) -------------


DATED = {
    "version": 1,
    "tables": [{
        "name": "tx",
        "anchor": {"headerSignature": ["when", "amt"], "minMatch": 2},
        "headerRows": 1, "exclude": [],
        "columns": [
            {"from": "when", "name": "when", "type": "TEXT", "parse": "date"},
            {"from": "amt", "name": "amt", "type": "REAL"},
        ],
        "periodColumn": "when",
        "onPeriodMismatch": "keep",
    }],
}


# Ports "a real date-typed cell (Excel serial) coerces to ISO and derives its period".
# Deviation: openpyxl yields a datetime that _cell_value stringifies to a full ISO
# timestamp, so coerce_cell's ISO-datetime branch (not the serial branch) handles it.
def test_real_xlsx_date_cell_coerces_and_derives_period():
    wb = Workbook()
    ws = wb.active
    ws.title = "Report Data"
    ws.append(["when", "amt"])
    ws.append([_dt.datetime(2026, 5, 7), 5])  # 2026-05-07 → Q2
    fd, path = tempfile.mkstemp(suffix=".xlsx")
    os.close(fd)
    try:
        wb.save(path)
        grids = load_grids(path, XLSX_MIME, "dated.xlsx")
        out = execute_parse_plan(grids, DATED, "2026-Q2", "quarter")
    finally:
        os.remove(path)
    assert out["tables"][0]["rows"] == [["2026-05-07", 5]]
    assert out["report"]["tables"][0]["coercionFailures"] == []
    assert out["report"]["tables"][0]["periodMismatches"] == {"count": 0, "samples": []}


# --- exported cell normalizers (norm_cell / raw_cell) ----------------------


def test_norm_cell_and_raw_cell():
    assert norm_cell(None) == ""
    assert norm_cell("  Amount  Due ") == "amount due"
    assert raw_cell(None) == ""
    assert raw_cell("  x  ") == "x"
    assert raw_cell(2400) == "2400"


# --- coerce_cell direct ----------------------------------------------------


def test_coerce_cell_direct():
    assert coerce_cell("$1,234.56", "currency") == {"out": 1234.56, "failed": False}
    assert coerce_cell("n/a", "number") == {"out": None, "failed": True}
    assert coerce_cell("stuff", None) == {"out": "stuff", "failed": False}
