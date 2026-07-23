"""Port of the run-side checks from packages/engine/src/checks.ts —
``evaluate_assert``, ``audit_citations``, ``count_citations``.

``compileLocator`` was ported into ``services/golden_binding.py`` in R1; it is
imported from there, never duplicated. TS wins on every statement; runtime shapes
are plain dicts with camelCase keys (RunData = {"catalog", "exec"}, SqlResult =
{"columns", "rows"}, Block/Span the dialect shapes). ``evaluate_assert`` returns
``{"pass": bool, "detail": str}`` and ``audit_citations`` returns
``{"pass": bool, "failures": list[str]}`` — the "pass" dict key stays "pass".
"""

import math
import re

from runoff_api.core.diff import parse_figure
from runoff_api.services.golden_binding import compile_locator

# Left side of the locator grammar: how citation locators reference a source
# column, optionally row-filtered: sum(src.amount where channel=search).
_AGG_REF = re.compile(
    r"^(sum|avg|min|max|count)\((\w+)\.(\w+)(?:\s+where\s+(\w+)\s*=\s*([^)]+?))?\)$",
)

# A digit-bearing numeric figure: optional $, digits/commas, optional decimal, optional %.
# The lookbehind keeps digits embedded in identifiers ("GA4", "Q2") from reading as figures.
_FIGURE = re.compile(r"(?<!\w)\$?\d[\d,]*(?:\.\d+)?%?")


def _is_number(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _is_integer(v: object) -> bool:
    """Mirror JS Number.isInteger — a finite real whose value is integral."""
    return _is_number(v) and float(v).is_integer()


def _fmt(n: float) -> str:
    """Mirror Number.toLocaleString('en-US'): comma grouping, up to 3 fraction digits."""
    if float(n).is_integer():
        return f"{int(n):,}"
    return f"{n:,.3f}".rstrip("0").rstrip(".")


def _js_number_str(n: float) -> str:
    """Mirror a JS number in a template literal (integral values print unsuffixed)."""
    if isinstance(n, float) and n.is_integer():
        return str(int(n))
    return str(n)


def _compare(actual: float, op: str, target: float, pct: float | None = None) -> bool:
    tol = abs(target) * (pct / 100) if pct is not None else None
    if op == "==":
        if tol is not None:
            return abs(actual - target) <= tol
        # Exact for integers; small absolute tolerance for float rounding.
        if _is_integer(actual) and _is_integer(target):
            return actual == target
        return abs(actual - target) <= 0.01
    if op == "<=":
        return actual <= target + tol if tol is not None else actual <= target
    if op == ">=":
        return actual >= target - tol if tol is not None else actual >= target
    if op == "<":
        return actual < target + tol if tol is not None else actual < target
    if op == ">":
        return actual > target - tol if tol is not None else actual > target
    return False


def _scalar_of(res: dict) -> float | None:
    """Single numeric cell of a result, or None."""
    rows = res["rows"]
    v = rows[0][0] if len(rows) == 1 and len(rows[0]) == 1 else None
    return v if _is_number(v) else None


def evaluate_assert(rule: dict, data: dict) -> dict:
    if not rule.get("sql") or not rule.get("op") or rule.get("value") is None:
        return {"pass": False, "detail": "assert rule is missing sql/op/value"}
    try:
        res = data["exec"](rule["sql"])
    except Exception as e:  # noqa: BLE001 — mirrors the TS catch-all
        return {"pass": False, "detail": str(e)}
    actual = _scalar_of(res)
    if actual is None:
        return {"pass": False, "detail": "check query must return one numeric value"}
    passed = _compare(actual, rule["op"], rule["value"], rule.get("withinPct"))
    sql_line = re.sub(r"\s*\n\s*", " ", rule["sql"]).strip()
    within = f" within {rule['withinPct']}%" if rule.get("withinPct") is not None else ""
    expected = f"{rule['op']} {_fmt(rule['value'])}{within}"
    verdict = "pass" if passed else "fail"
    return {"pass": passed, "detail": f"{sql_line} = {_fmt(actual)} (expected {expected}) — {verdict}"}


def _all_spans(blocks: list[dict]):
    """Yield every auditable span: paragraph spans and table cell spans (header columns skipped)."""
    for block in blocks:
        if block["type"] == "paragraph":
            yield from block["spans"]
        else:
            for row in block["rows"]:
                for cell in row["cells"]:
                    yield from cell


def _figure_in(text: str) -> str | None:
    """The numeric figure a span carries, or None if it is not a digit-bearing figure ≥ 2 chars."""
    if len(text) < 2:
        return None
    m = _FIGURE.search(text)
    return m.group(0) if m else None


def audit_citations(blocks: list[dict], data: dict, bound_source_ids: list[str]) -> dict:
    failures: list[str] = []

    for span in _all_spans(blocks):
        fig = _figure_in(span["text"])
        if not fig:
            # The dialect cites figures; a cited span with no digits renders placeholder
            # text to the reader verbatim (e.g. the literal word "figure"). A quote-style
            # citation legitimately cites a verbatim quote, so it is exempt.
            text = span["text"]
            if span.get("citation") and not re.search(r"\d", text) and not re.match(
                r'^".*"$', text.strip(), re.S
            ):
                failures.append(f'cited span has no figure: "{text}"')
            continue

        citation = span.get("citation")
        if not citation:
            failures.append(f"uncited figure: {fig}")
            continue
        if citation["sourceId"] not in bound_source_ids:
            failures.append(f"figure cites unbound source {citation['sourceId']}: {fig}")
            continue

        # When the locator itself is an aggregate reference, recompute and cross-check.
        locator = citation["locator"].strip()
        ref = _AGG_REF.match(locator)
        if ref:
            try:
                compiled = compile_locator(locator, data["catalog"])
            except Exception:  # noqa: BLE001 — mirrors the TS catch-all
                # Aggregate-shaped but pointing at nothing we can compile — the whole
                # point of an aggregate locator is verifiability, so this is a failure.
                failures.append(f"unverifiable locator: {locator}")
                continue
            if compiled["family"]["id"] != citation["sourceId"]:
                failures.append(
                    f"locator source mismatch: cites {citation['sourceId']} "
                    f"but locator references {ref.group(2)}"
                )
                continue
            try:
                computed = _scalar_of(data["exec"](compiled["sql"]))
                if computed is None:
                    raise ValueError("non-numeric")
            except Exception:  # noqa: BLE001 — mirrors the TS catch-all
                failures.append(f"unverifiable locator: {locator}")
                continue
            actual = parse_figure(fig)
            if not math.isnan(actual) and abs(actual - computed) > abs(computed) * 0.005:
                failures.append(f"citation mismatch: {fig} vs computed {_js_number_str(computed)}")

    return {"pass": len(failures) == 0, "failures": failures}


def count_citations(blocks: list[dict]) -> int:
    n = 0
    for span in _all_spans(blocks):
        if span.get("citation"):
            n += 1
    return n
