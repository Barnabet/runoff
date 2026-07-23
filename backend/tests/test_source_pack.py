"""Ports packages/engine/test/sourcePack.test.ts case-by-case (snake_cased).

DOCX has no fixture; the TS suite mocks mammoth, so here we monkeypatch the
docx extractor the same way. The PDF branch is the ONE sanctioned near-parity
divergence (spec §6): rather than mock pdf-parse, it runs a real PDF through
pypdf and asserts Python-side behavior (non-empty text, caps, summary format).
"""

import os

import pytest

from runoff_api.engine import source_pack
from runoff_api.engine.source_pack import (
    build_source_pack,
    cell_text,
    cell_value,
    extract_file_text,
    pack_for_prompt,
)

HERE = os.path.dirname(__file__)
FIXTURES = os.path.join(HERE, "fixtures")
PDF_PATH = os.path.join(FIXTURES, "brand_guidelines.pdf")

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


@pytest.fixture(autouse=True)
def _mock_docx(monkeypatch):
    # Mirror vi.mock("mammoth"): docx extraction returns fixed text.
    monkeypatch.setattr(
        source_pack,
        "_extract_docx",
        lambda path: "Quarterly notes.\nGrowth held steady across channels.",
    )


# --- build_source_pack -----------------------------------------------------


def test_skips_tabular_files_the_warehouse_owns_them(tmp_path):
    md_path = tmp_path / "notes.md"
    md_path.write_text("# Notes\nQuarter over quarter growth held.")
    pack = build_source_pack(
        [
            {
                "id": "famT",
                "name": "spend.csv",
                "mime": "text/csv",
                "path": os.path.join(FIXTURES, "spend.csv"),
            },
            {"id": "famD", "name": "notes.md", "mime": "text/markdown", "path": str(md_path)},
        ]
    )
    assert [s["id"] for s in pack["sources"]] == ["famD"]


def test_skips_an_xlsx_file_by_mime_and_extension():
    pack = build_source_pack(
        [
            {
                "id": "famX",
                "name": "kpi.xlsx",
                "mime": XLSX_MIME,
                "path": "/does/not/matter.xlsx",
            }
        ]
    )
    assert pack["sources"] == []


def test_extracts_docx_text_via_mammoth_dispatch_by_mime():
    pack = build_source_pack(
        [
            {
                "id": "src_notes",
                "name": "notes.docx",
                "mime": DOCX_MIME,
                "path": "/does/not/matter.docx",
            }
        ]
    )
    s = pack["sources"][0]
    assert s["kind"] == "document"
    assert "Quarterly notes." in s["text"]
    assert "document" in s["summary"]
    assert "Growth held steady" in pack_for_prompt(pack, ["src_notes"])


def test_extracts_pdf_text_locally_with_read_at_run_time_summary():
    # Sanctioned divergence: real pypdf extraction, assert Python-side behavior.
    pack = build_source_pack(
        [{"id": "src_deck", "name": "deck.pdf", "mime": "application/pdf", "path": PDF_PATH}]
    )
    s = pack["sources"][0]
    assert s["kind"] == "pdf"
    assert s["text"].strip()  # non-empty extracted text
    assert "PDF" in s["summary"]
    assert "(read at run time)" in s["summary"]
    # KB summary: Math.round(bytes/1024), min 1.
    kb = max(1, int((os.path.getsize(PDF_PATH) / 1024) + 0.5))
    assert s["summary"] == f"deck.pdf — PDF, {kb} KB (read at run time)"
    packed = pack_for_prompt(pack, ["src_deck"])
    assert "### deck.pdf (src_deck)" in packed


def test_malformed_pdf_yields_empty_text_not_a_crash(tmp_path):
    path = tmp_path / "deck.pdf"
    path.write_bytes(b"%PDF-1.4 minimal")
    pack = build_source_pack(
        [{"id": "src_deck", "name": "deck.pdf", "mime": "application/pdf", "path": str(path)}]
    )
    s = pack["sources"][0]
    assert s["kind"] == "pdf"
    assert s["text"] == ""
    assert "(read at run time)" in s["summary"]


# --- pack_for_prompt / caps ------------------------------------------------


def test_pack_for_prompt_applies_max_document_chars_cap():
    long_text = "x" * 20_000
    pack = {
        "sources": [
            {"id": "big", "label": "Big", "kind": "document", "text": long_text, "summary": "big doc"}
        ]
    }
    out = pack_for_prompt(pack, ["big"])
    # header + summary + text sliced to MAX_DOCUMENT_CHARS
    assert out == f"### Big (big)\nbig doc\n{'x' * 8000}"


def test_pack_for_prompt_selects_only_requested_ids():
    pack = {
        "sources": [
            {"id": "a", "label": "A", "kind": "document", "text": "aaa", "summary": "sa"},
            {"id": "b", "label": "B", "kind": "document", "text": "bbb", "summary": "sb"},
        ]
    }
    assert pack_for_prompt(pack, ["b"]) == "### B (b)\nsb\nbbb"


# --- extract_file_text -----------------------------------------------------


def test_extract_file_text_returns_raw_docx_text():
    text = extract_file_text(
        {"id": "src_notes", "name": "notes.docx", "mime": DOCX_MIME, "path": "/does/not/matter.docx"}
    )
    assert text == "Quarterly notes.\nGrowth held steady across channels."


def test_extract_file_text_skips_tabular_returns_empty():
    assert extract_file_text(
        {"id": "famX", "name": "kpi.xlsx", "mime": XLSX_MIME, "path": "/nope.xlsx"}
    ) == ""


# --- cell_text / cell_value (exports; no TS cases, ported for parity) -------


def test_cell_text_primitives_and_objects():
    assert cell_text(None) == ""
    assert cell_text("hi") == "hi"
    assert cell_text(1) == "1"
    assert cell_text(1.5) == "1.5"
    assert cell_text(True) == "true"
    assert cell_text({"text": "cell"}) == "cell"
    assert cell_text({"richText": [{"text": "a"}, {"text": "b"}, {}]}) == "ab"
    assert cell_text({"result": 42}) == "42"
    assert cell_text({"result": None}) == ""


def test_cell_value_primitives_and_objects():
    assert cell_value(None) == ""
    assert cell_value(3) == 3
    assert cell_value(2.5) == 2.5
    assert cell_value(True) == "true"
    assert cell_value(False) == "false"
    assert cell_value({"result": 7}) == 7
    assert cell_value({"text": "cell"}) == "cell"
