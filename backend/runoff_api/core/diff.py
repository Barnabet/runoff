"""Port of packages/core/src/diff.ts — figure parsing + deterministic run-over-run diff.

Runtime shape is plain dicts. ``parse_figure`` mirrors JS ``parseFloat``: after
stripping ``$ , %`` it parses a leading numeric prefix (e.g. "1.2M" -> 1.2); with
no parseable prefix it yields NaN. ``Number.isFinite`` becomes ``math.isfinite``.
"""

import math
import re

from .types.document import blocks_to_plain_text

# Leading numeric prefix, mirroring JS parseFloat's accepted grammar.
_FLOAT_PREFIX = re.compile(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?")
_INFINITY_PREFIX = re.compile(r"[+-]?Infinity")


def _parse_float(text: str) -> float:
    """JS parseFloat: skip leading whitespace, parse the longest leading numeric prefix."""
    s = text.lstrip()
    m = _INFINITY_PREFIX.match(s)
    if m:
        return float("-inf") if s[0] == "-" else float("inf")
    m = _FLOAT_PREFIX.match(s)
    if not m:
        return math.nan
    try:
        return float(m.group(0))
    except ValueError:
        return math.nan


def parse_figure(text: str) -> float:
    """Strip $, commas and % so a rendered figure can be compared numerically."""
    return _parse_float(re.sub(r"[$,%]", "", text))


def _cited_figures(blocks: list[dict]) -> dict[str, float]:
    """First parseable cited-figure value per ``{sourceId}|{locator.strip()}`` key."""
    out: dict[str, float] = {}

    def visit(span: dict) -> None:
        citation = span.get("citation")
        if not citation:
            return
        key = f"{citation['sourceId']}|{citation['locator'].strip()}"
        if key in out:
            return
        value = parse_figure(span["text"])
        if math.isfinite(value):
            out[key] = value

    for block in blocks:
        if block["type"] == "paragraph":
            for span in block["spans"]:
                visit(span)
        else:
            for row in block["rows"]:
                for cell in row["cells"]:
                    for span in cell:
                        visit(span)
    return out


def diff_runs(current: dict, previous: dict) -> dict:
    """Deterministic run-over-run diff.

    Sections match by key (new / removed / changed / unchanged by plain-text
    equality); within a matched section, cited figures match by
    ``{sourceId}|{locator.strip()}`` and changed values become deltas.
    Zero-difference and non-numeric pairs are dropped.
    """
    sections: dict[str, str] = {}
    deltas: list[dict] = []
    prev_by_key = {s["key"]: s for s in previous["sections"]}

    for cur in current["sections"]:
        prev = prev_by_key.get(cur["key"])
        if prev is None:
            sections[cur["key"]] = "new"
            continue
        sections[cur["key"]] = (
            "unchanged"
            if blocks_to_plain_text(cur["blocks"]) == blocks_to_plain_text(prev["blocks"])
            else "changed"
        )

        before = _cited_figures(prev["blocks"])
        for key, after in _cited_figures(cur["blocks"]).items():
            b = before.get(key)
            if b is None or b == after:
                continue
            sep = key.index("|")
            deltas.append({
                "sectionKey": cur["key"],
                "sourceId": key[:sep],
                "locator": key[sep + 1:],
                "before": b,
                "after": after,
            })
    for prev in previous["sections"]:
        if not any(s["key"] == prev["key"] for s in current["sections"]):
            sections[prev["key"]] = "removed"
    return {"deltas": deltas, "sections": sections}
