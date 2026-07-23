"""Ports packages/engine/test/tabular.test.ts case-by-case (snake_cased).

The TS suite builds .xlsx fixtures on the fly with ExcelJS; here we reproduce the
same cell layout with openpyxl. CSV fixtures are written inline exactly as the TS
tests do. No mocks — every case exercises a real file on disk.
"""

from openpyxl import Workbook

from runoff_api.engine.tabular import (
    detect_islands,
    is_tabular,
    read_tabular,
    scan_sample,
    scan_tabular,
    slugify,
)

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

E = None


def _write_xlsx(path, build):
    """Mirror the TS writeXlsx helper: first sheet named 'Report Data', `build`
    populates it (and may add more sheets on the workbook)."""
    wb = Workbook()
    ws = wb.active
    ws.title = "Report Data"
    build(ws, wb)
    wb.save(path)
    return str(path)


# --- slugify ---------------------------------------------------------------


def test_slugify_lowercases_collapses_prefixes_digits():
    assert slugify("Report Data") == "report_data"
    assert slugify("Q1 — Sales!!") == "q1_sales"
    assert slugify("2026 Summary") == "t_2026_summary"


# --- detect_islands --------------------------------------------------------


def test_splits_two_tables_separated_by_blank_row_keeps_note_fragment():
    grid = [
        ["campaign", "spend"],
        ["brand", 100],
        ["search", 200],
        [E, E],
        ["Note: Q2 excludes agency fees"],
        [E, E],
        ["region", "revenue"],
        ["emea", 900],
    ]
    out = detect_islands(grid, "sheet1")
    assert [t["slug"] for t in out["tables"]] == ["sheet1", "sheet1_2"]
    assert out["tables"][0]["header"] == ["campaign", "spend"]
    assert out["tables"][0]["rows"] == [["brand", 100], ["search", 200]]
    assert out["tables"][1]["rows"] == [["emea", 900]]
    assert out["skipped"] == ["Note: Q2 excludes agency fees"]


def test_splits_side_by_side_tables_on_blank_column():
    grid = [
        ["a", "b", E, "c", "d"],
        [1, 2, E, 3, 4],
        [5, 6, E, 7, 8],
    ]
    out = detect_islands(grid, "s")
    assert len(out["tables"]) == 2
    assert out["tables"][0]["header"] == ["a", "b"]
    assert out["tables"][1]["header"] == ["c", "d"]
    assert out["tables"][1]["rows"] == [[3, 4], [7, 8]]


def test_skips_one_col_and_one_row_blocks_names_empty_headers_column_n():
    grid = [
        ["just a title"],
        [E],
        ["h1", E, "h3"],  # island cols 0..2 with a hole in the header
        [1, 2, 3],
    ]
    out = detect_islands(grid, "s")
    assert out["skipped"] == ["just a title"]
    assert out["tables"][0]["header"] == ["h1", "column_2", "h3"]


def test_renames_source_column_that_slugs_to_reserved_period():
    grid = [
        ["_period", "amount"],
        ["x", 1],
    ]
    assert detect_islands(grid, "s")["tables"][0]["header"] == ["_period_2", "amount"]


def test_returns_nothing_for_empty_grid():
    assert detect_islands([], "s") == {"tables": [], "skipped": []}


# --- scan_tabular + read_tabular -------------------------------------------


def test_scans_csv_header_types_count_sample_single_table_slugged(tmp_path):
    path = tmp_path / "ar.csv"
    path.write_text("invoice,amount,paid\nI-1,100,true\nI-2,250.5,false\nI-3,90,true\n")
    scan = scan_tabular(str(path), "text/csv", "ar.csv")
    assert len(scan["tables"]) == 1
    assert scan["tables"][0]["columns"] == [
        {"name": "invoice", "type": "TEXT"},
        {"name": "amount", "type": "REAL"},
        {"name": "paid", "type": "TEXT"},
    ]
    assert scan["tables"][0]["rowCount"] == 3
    row0 = scan["tables"][0]["sample"][0]
    assert row0 == ["I-1", 100, True]
    # Pin the exact runtime types: 100 must be int (not 100.0), True bool (not 1).
    assert isinstance(row0[1], int) and not isinstance(row0[1], bool)
    assert isinstance(row0[2], bool)
    assert scan["skipped"] == []


def test_integer_only_columns_infer_integer_empty_cells_dont_affect(tmp_path):
    path = tmp_path / "n.csv"
    path.write_text("id,qty\n1,5\n2,\n3,7\n")
    scan = scan_tabular(str(path), "text/csv", "n.csv")
    assert scan["tables"][0]["columns"] == [
        {"name": "id", "type": "INTEGER"},
        {"name": "qty", "type": "INTEGER"},
    ]


def test_read_tabular_streams_csv_rows_in_batches_matching_scan(tmp_path):
    path = tmp_path / "big.csv"
    rows = [f"r{i},{i}" for i in range(25_000)]
    path.write_text("name,n\n" + "\n".join(rows) + "\n")
    batches = []
    cols = []

    def on_table(table):
        cols.extend(c["name"] for c in table["columns"])
        return lambda batch: batches.append(len(batch))

    read_tabular(str(path), "text/csv", "big.csv", on_table)
    assert cols == ["name", "n"]
    assert sum(batches) == 25_000
    assert max(batches) <= 10_000


def test_delivers_empty_csv_cells_as_null_in_read_tabular_batches(tmp_path):
    path = tmp_path / "nulls.csv"
    path.write_text("a,b\n1,\n,x\n2,y\n")
    batches = []
    read_tabular(str(path), "text/csv", "nulls.csv", lambda _t: lambda b: batches.append(b))
    rows = [r for b in batches for r in b]
    assert rows == [[1, None], [None, "x"], [2, "y"]]


def test_delivers_whitespace_only_csv_cells_as_null(tmp_path):
    path = tmp_path / "ws.csv"
    path.write_text('a,b\n1,"   "\n2,y\n')
    batches = []
    read_tabular(str(path), "text/csv", "ws.csv", lambda _t: lambda b: batches.append(b))
    rows = [r for b in batches for r in b]
    assert rows == [[1, None], [2, "y"]]


def test_scans_messy_xlsx_two_islands_plus_note(tmp_path):
    def build(ws, wb):
        ws.append(["campaign", "spend"])
        ws.append(["brand", 100])
        ws.append([])
        ws.append(["Note: excludes fees"])
        ws.append([])
        ws.append(["region", "revenue"])
        ws.append(["emea", 900])

    path = _write_xlsx(tmp_path / "messy.xlsx", build)
    scan = scan_tabular(path, XLSX_MIME, "messy.xlsx")
    assert [t["slug"] for t in scan["tables"]] == ["report_data", "report_data_2"]
    assert scan["tables"][1]["columns"] == [
        {"name": "region", "type": "TEXT"},
        {"name": "revenue", "type": "INTEGER"},
    ]
    assert scan["skipped"] == ["Note: excludes fees"]
    # read_tabular agrees with the scan
    seen = []
    read_tabular(path, XLSX_MIME, "messy.xlsx", lambda t: seen.append(t["slug"]) or (lambda _b: None))
    assert seen == ["report_data", "report_data_2"]


def test_dedupes_table_slugs_across_sheets(tmp_path):
    # sheet "Data" yields data + data_2 (two islands); sibling "Data (2)" slugs to
    # data_2 at the sheet level, whose single island must not collide.
    def build(ws, wb):
        ws.title = "Data"
        ws.append(["campaign", "spend"])
        ws.append(["brand", 100])
        ws.append([])
        ws.append(["region", "revenue"])
        ws.append(["emea", 900])
        ws2 = wb.create_sheet("Data (2)")
        ws2.append(["metric", "value"])
        ws2.append(["clicks", 5])

    path = _write_xlsx(tmp_path / "dup.xlsx", build)
    scan = scan_tabular(path, XLSX_MIME, "dup.xlsx")
    slugs = [t["slug"] for t in scan["tables"]]
    assert slugs == ["data", "data_2", "data_2_2"]
    assert len(set(slugs)) == len(slugs)  # all distinct
    seen = []
    read_tabular(path, XLSX_MIME, "dup.xlsx", lambda t: seen.append(t["slug"]) or (lambda _b: None))
    assert seen == slugs


def test_scan_sample_serializes_compactly_and_caps(tmp_path):
    path = tmp_path / "s.csv"
    path.write_text("a,b\n1,x\n2,y\n")
    scan = scan_tabular(str(path), "text/csv", "s.csv")
    sample = scan_sample(scan)
    assert "### s — 2 rows" in sample
    assert "columns: a (INTEGER), b (TEXT)" in sample
    assert "1 | x" in sample


def test_header_row_is_dynamically_typed_like_papaparse(tmp_path):
    # papaparse (header:false) types the header row too: node probe of
    # Papa.parse("01,100.50,,x\n...") header row → [1, 100.5, null, "x"]. Those
    # typed values then slugify: 1 → "t_1", 100.5 → "100_5" → digit-prefixed
    # "t_100_5", null → "column_3", "x" → "x".
    path = tmp_path / "h.csv"
    path.write_text("01,100.50,,x\nfoo,bar,baz,qux\n")
    scan = scan_tabular(str(path), "text/csv", "h.csv")
    names = [c["name"] for c in scan["tables"][0]["columns"]]
    assert names == ["t_1", "t_100_5", "column_3", "x"]


def test_calendar_invalid_timestamp_falls_back_to_raw_string(tmp_path):
    # "2026-06-31T10:00:00Z" matches papaparse's ISO_DATE regex (day [0-3]\d) but
    # is calendar-invalid; JS new Date rolls it to 2026-07-01, Python fromisoformat
    # raises. Port must not crash: fall back to the raw string (stays TEXT).
    path = tmp_path / "bad_ts.csv"
    path.write_text("d,n\n2026-06-31T10:00:00Z,1\n2026-07-02T09:00:00Z,2\n")
    scan = scan_tabular(str(path), "text/csv", "bad_ts.csv")
    cols = scan["tables"][0]["columns"]
    assert cols[0]["type"] == "TEXT"
    assert scan["tables"][0]["sample"][0][0] == "2026-06-31T10:00:00Z"
    # the valid sibling still parses to a datetime (also TEXT), proving no crash
    import datetime as dt

    assert isinstance(scan["tables"][0]["sample"][1][0], dt.datetime)


def test_auto_detects_semicolon_tab_and_pipe_delimiters(tmp_path):
    # Expected values pinned against Papa.parse({dynamicTyping:true}) node probes:
    #   "a;b;c\n1;2;3\n4;5;6\n"  → [["a","b","c"],[1,2,3],[4,5,6]]
    #   "a\tb\n1\t2\n3\t4\n"       → [["a","b"],[1,2],[3,4]]
    #   "a|b|c\nx|y|z\n"          → [["a","b","c"],["x","y","z"]]
    semi = tmp_path / "semi.csv"
    semi.write_text("a;b;c\n1;2;3\n4;5;6\n")
    scan = scan_tabular(str(semi), "text/csv", "semi.csv")
    assert [c["name"] for c in scan["tables"][0]["columns"]] == ["a", "b", "c"]
    assert scan["tables"][0]["rowCount"] == 2
    assert scan["tables"][0]["sample"][0] == [1, 2, 3]

    tab = tmp_path / "tab.csv"
    tab.write_text("a\tb\n1\t2\n3\t4\n")
    scan = scan_tabular(str(tab), "text/csv", "tab.csv")
    assert [c["name"] for c in scan["tables"][0]["columns"]] == ["a", "b"]
    assert scan["tables"][0]["sample"] == [[1, 2], [3, 4]]

    pipe = tmp_path / "pipe.csv"
    pipe.write_text("a|b|c\nx|y|z\n")
    scan = scan_tabular(str(pipe), "text/csv", "pipe.csv")
    assert [c["name"] for c in scan["tables"][0]["columns"]] == ["a", "b", "c"]
    assert scan["tables"][0]["sample"][0] == ["x", "y", "z"]

    # comma still wins for a plain comma file
    comma = tmp_path / "comma.csv"
    comma.write_text("a,b\n1,2\n")
    scan = scan_tabular(str(comma), "text/csv", "comma.csv")
    assert [c["name"] for c in scan["tables"][0]["columns"]] == ["a", "b"]


def test_is_tabular_accepts_csv_xlsx_rejects_pdf_txt():
    assert is_tabular("text/csv", "a.csv") is True
    assert is_tabular("application/octet-stream", "a.xlsx") is True
    assert is_tabular("application/pdf", "a.pdf") is False
    assert is_tabular("text/plain", "a.txt") is False
