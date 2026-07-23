"""Source pack — statement-for-statement port of packages/engine/src/sourcePack.ts.

Builds the document-side prompt surface: the warehouse owns every tabular file,
so csv/xlsx are skipped entirely and never reach the prompt; docx/pdf/unknown
files are text-extracted locally and packaged for drafting prompts.

Runtime shapes are plain dicts with camelCase keys (TS async -> sync here):
  PackedSource  {"id", "label", "kind", "text"?, "summary"}   kind in {"document","pdf"}
  SourcePack    {"sources": [PackedSource, ...]}
  EngineFile    {"id", "name", "mime", "path"}   (exact field set from the TS interface)

Sanctioned near-parity divergence (spec §6): extract_file_text's PDF branch uses
pypdf, whose text may differ from TS pdf-parse output. DOCX extraction is
likewise a near-parity path (no mammoth in Python) — both are fuzzy document
text that feeds prompts, never byte-exact warehouse data. cell_text / cell_value
stay byte-exact ports (they coerce warehouse cell values that feed prompts).
"""

from __future__ import annotations

import datetime as _dt
import os
import re
import zipfile
from typing import Any

import pypdf

from .tabular import _to_iso_string

MAX_DOCUMENT_CHARS = 8_000


def _extname(name: str) -> str:
    return os.path.splitext(name)[1]


def _classify(file: dict) -> str:
    """Dispatch on mime type, falling back to file extension (SourceKind)."""
    mime = file["mime"].lower()
    if "csv" in mime:
        return "csv"
    if "spreadsheetml" in mime or "ms-excel" in mime:
        return "xlsx"
    if "wordprocessingml" in mime or "msword" in mime:
        return "docx"
    if "pdf" in mime:
        return "pdf"

    ext = _extname(file["name"]).lower()
    if ext == ".csv":
        return "csv"
    if ext in (".xlsx", ".xls"):
        return "xlsx"
    if ext in (".docx", ".doc"):
        return "docx"
    if ext == ".pdf":
        return "pdf"
    return "unknown"


def build_source_pack(files: list[dict]) -> dict:
    """Build the source pack from document families only — csv/xlsx are skipped."""
    sources = [
        _build_source(f) for f in files if _classify(f) not in ("csv", "xlsx")
    ]
    return {"sources": sources}


def _build_source(file: dict) -> dict:
    if _classify(file) == "pdf":
        return _build_pdf(file)
    # docx and unknown types fall through to plain-text extraction.
    return _build_document(file)


def _js_thousands(n: int) -> str:
    """Number.toLocaleString('en-US') for a non-negative integer."""
    return f"{n:,}"


def _build_document(file: dict) -> dict:
    kind = _classify(file)
    if kind == "docx":
        text = _extract_docx(file["path"])
    else:
        with open(file["path"], encoding="utf-8") as fh:
            text = fh.read()
    words = len(text.strip().split()) if text.strip() else 0
    return {
        "id": file["id"],
        "label": file["name"],
        "kind": "document",
        "text": text,
        "summary": f"{file['name']} — document, {_js_thousands(words)} words",
    }


def _build_pdf(file: dict) -> dict:
    size = os.path.getsize(file["path"])
    # Math.round (round half to +inf), min 1.
    kb = max(1, int((size / 1024) + 0.5))
    # Extract text locally so the PDF's contents flow through the source pack like
    # any document. Never let a malformed PDF crash the whole pack build.
    text = ""
    try:
        reader = pypdf.PdfReader(file["path"])
        text = "\n".join(page.extract_text() for page in reader.pages)
    except Exception:
        text = ""
    return {
        "id": file["id"],
        "label": file["name"],
        "kind": "pdf",
        "text": text,
        "summary": f"{file['name']} — PDF, {kb} KB (read at run time)",
    }


def _extract_docx(path: str) -> str:
    """Raw-text extraction from a .docx (mammoth's role in TS).

    Dependency-free near-parity path: read word/document.xml from the zip,
    treat each </w:p> as a paragraph break and strip the remaining tags. Tests
    monkeypatch this exactly as the TS suite mocks mammoth.
    """
    try:
        with zipfile.ZipFile(path) as z:
            xml = z.read("word/document.xml").decode("utf-8")
    except (KeyError, zipfile.BadZipFile, FileNotFoundError):
        return ""
    xml = re.sub(r"</w:p>", "\n", xml)
    text = re.sub(r"<[^>]+>", "", xml)
    return text.strip()


def extract_file_text(file: dict) -> str:
    """Raw extracted text of one file — the same reader build_source_pack uses."""
    pack = build_source_pack([file])
    return "\n\n".join(s.get("text") or "" for s in pack["sources"])


def pack_for_prompt(pack: dict, source_ids: list[str]) -> str:
    """Serialize selected sources for a drafting prompt."""
    chosen = [s for s in pack["sources"] if s["id"] in source_ids]
    return "\n\n".join(_serialize_source(s) for s in chosen)


def _serialize_source(source: dict) -> str:
    parts = [f"### {source['label']} ({source['id']})", source["summary"]]
    # PDFs are text-extracted locally, so they serialize like documents.
    text = source.get("text")
    if text:
        parts.append(text[:MAX_DOCUMENT_CHARS])
    return "\n".join(parts)


# --- exceljs cell coercion -------------------------------------------------
# Kept for tabular parity: warehouse cell values coerce through cell_value.


def _js_string(v: Any) -> str:
    """String(v) for the primitive kinds cell coercion reaches (JS repr)."""
    if v is True:
        return "true"
    if v is False:
        return "false"
    if v is None:
        return "null"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def cell_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, _dt.datetime):
        return _to_iso_string(value)
    if isinstance(value, dict):
        text = value.get("text")
        if isinstance(text, str):
            return text
        rich = value.get("richText")
        if isinstance(rich, list):
            return "".join((t.get("text") or "") for t in rich)
        if "result" in value:
            result = value.get("result")
            return "" if result is None else _js_string(result)
        return _js_string(value)
    return _js_string(value)


def cell_value(value: Any) -> str | int | float:
    if value is None:
        return ""
    # A JS boolean is not a number; check it before the numeric branch since a
    # Python bool is an int subclass.
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, _dt.datetime):
        return _to_iso_string(value)
    if isinstance(value, dict):
        result = value.get("result")
        if isinstance(result, (int, float)) and not isinstance(result, bool):
            return result
        return cell_text(value)
    return _js_string(value)
