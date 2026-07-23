"""Port of packages/core/src/dialect.ts — inline citation + section-text parser.

Runtime shape is plain dicts; span dicts carry a ``citation`` key ONLY when a
citation exists (matches the TS object shape).
"""

import re

CITE = re.compile(r"\[\[([^\]|]+)\|([^\]|]+)\|([^\]]+)\]\]")


def spans_from_inline(text: str) -> list[dict]:
    spans: list[dict] = []
    last = 0
    for m in CITE.finditer(text):
        if m.start() > last:
            spans.append({"text": text[last:m.start()]})
        spans.append({
            "text": m.group(1),
            "citation": {"sourceId": m.group(2).strip(), "locator": m.group(3).strip()},
        })
        last = m.start() + len(m.group(0))
    if last < len(text):
        spans.append({"text": text[last:]})
    return spans if spans else [{"text": text}]


def _is_table_line(line: str) -> bool:
    return line.strip().startswith("|")


def _split_row(line: str) -> list[str]:
    inner = re.sub(r"^\||\|$", "", line.strip())
    cells: list[str] = []
    buf = ""
    in_cite = False
    i = 0
    n = len(inner)
    while i < n:
        ch = inner[i]
        nxt = inner[i + 1] if i + 1 < n else ""
        if not in_cite and ch == "[" and nxt == "[":
            in_cite = True
            buf += "[["
            i += 2
            continue
        if in_cite and ch == "]" and nxt == "]":
            in_cite = False
            buf += "]]"
            i += 2
            continue
        if ch == "|" and not in_cite:
            cells.append(buf.strip())
            buf = ""
            i += 1
            continue
        buf += ch
        i += 1
    cells.append(buf.strip())
    return cells


_SEPARATOR_RE = re.compile(r"^\|?[\s|:-]+\|?$")


def parse_section_text(raw: str) -> list[dict]:
    blocks: list[dict] = []
    chunks = [c.strip() for c in re.split(r"\n{2,}", raw.replace("\r\n", "\n"))]
    chunks = [c for c in chunks if c]
    for chunk in chunks:
        lines = chunk.split("\n")
        if len(lines) >= 2 and _is_table_line(lines[0]) and _SEPARATOR_RE.match(lines[1]):
            columns = _split_row(lines[0])
            rows = [
                {"cells": [spans_from_inline(cell) for cell in _split_row(line)]}
                for line in lines[2:]
                if _is_table_line(line)
            ]
            blocks.append({"type": "table", "columns": columns, "rows": rows})
        else:
            blocks.append({"type": "paragraph", "spans": spans_from_inline(" ".join(lines))})
    return blocks
