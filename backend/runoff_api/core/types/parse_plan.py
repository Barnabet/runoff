"""Port of packages/core/src/types/parsePlan.ts.

zod objects here are plain (non-strict) -> CamelModelOpen. `validate_parse_plan`
and `plan_table_name` operate on plain dicts (the runtime shape), mirroring the
TS functions that receive already-parsed ParsePlan objects.
"""

import re
from typing import Annotated, Literal

from pydantic import Field

from .base import CamelModelOpen

NAME_RE = r"^[a-z][a-z0-9_]*$"


def plan_pattern(pattern: str) -> re.Pattern:
    """Port of planPattern.

    Matching is always case-insensitive, so a leading PCRE inline-flag group like
    `(?i)` (which LLM proposers emit but Python/ECMAScript reject) is stripped
    before compilation. Raises re.error (like `new RegExp`) on a malformed pattern.
    """
    return re.compile(re.sub(r"^\(\?[a-z]+\)", "", pattern, flags=re.IGNORECASE), re.IGNORECASE)


class RowRule(CamelModelOpen):
    # Canonical column name, or None = match against any matched cell in the row.
    column: str | None
    # Case-insensitive regex tested against the cell's raw (trimmed) text.
    pattern: str


class ColumnPlan(CamelModelOpen):
    # Normalized merged raw header text this column matches.
    from_: str = Field(alias="from", min_length=1)
    name: str = Field(pattern=NAME_RE)
    type: Literal["TEXT", "INTEGER", "REAL"]
    parse: Literal["number", "currency", "percent", "date"] | None = None


class TableAnchor(CamelModelOpen):
    # Slugified sheet-name HINT; breaks ties, never required to match.
    sheet: str | None = None
    # Normalized raw texts of the header row's cells.
    header_signature: list[Annotated[str, Field(min_length=1)]] = Field(min_length=1)
    min_match: int = Field(ge=1)


class Unpivot(CamelModelOpen):
    keep: list[str]
    # Case-insensitive regex; matched (unmapped) merged headers melt into rows.
    value_pattern: str
    key_column: str = Field(pattern=NAME_RE)
    value_column: str = Field(pattern=NAME_RE)
    value_type: Literal["INTEGER", "REAL", "TEXT"]
    value_parse: Literal["number", "currency", "percent"] | None = None


class TablePlan(CamelModelOpen):
    name: str = Field(pattern=NAME_RE)
    anchor: TableAnchor
    header_rows: int = Field(ge=1, le=3)
    exclude: list[RowRule]
    columns: list[ColumnPlan] = Field(min_length=1)
    unpivot: Unpivot | None = None
    # Canonical column (parse: "date") validated against the slot period.
    period_column: str | None = None
    on_period_mismatch: Literal["keep", "exclude"] = "keep"  # zod .default("keep")


class ParsePlan(CamelModelOpen):
    version: Literal[1]
    tables: list[TablePlan] = Field(min_length=1)


class _ExecReportRowExcluded(CamelModelOpen):
    pattern: str
    count: float
    samples: list[str]


class _ExecReportCoercionFailure(CamelModelOpen):
    column: str
    count: float
    samples: list[str]


class _ExecReportPeriodMismatches(CamelModelOpen):
    count: float
    samples: list[str]


class _ExecReportAnchor(CamelModelOpen):
    sheet: str
    row: float


class _ExecReportTable(CamelModelOpen):
    name: str
    anchor: _ExecReportAnchor | None
    # Byte-exact problem lines; a table with problems produces no rows.
    problems: list[str]
    rows_kept: float
    rows_excluded: list[_ExecReportRowExcluded]
    coercion_failures: list[_ExecReportCoercionFailure]
    period_mismatches: _ExecReportPeriodMismatches | None
    unknown_columns: list[str]


class ExecReport(CamelModelOpen):
    tables: list[_ExecReportTable]


class _PlanPreviewTable(CamelModelOpen):
    name: str
    columns: list[str]
    rows: list[list[str | float | None]]


class PlanPreview(CamelModelOpen):
    tables: list[_PlanPreviewTable]


def validate_parse_plan(plan: dict) -> None:
    """Port of validateParsePlan — structural validity beyond zod.

    Raises ValueError whose message is the first violated rule; messages are
    stable and user-visible. Operates on the plain-dict runtime shape.
    """
    table_names: set[str] = set()
    for t in plan["tables"]:
        name = t["name"]
        if name in table_names:
            raise ValueError(f"duplicate table name: {name}")
        table_names.add(name)
        canon: set[str] = set()
        froms: set[str] = set()
        for c in t["columns"]:
            if c["name"] == "_period":
                raise ValueError(f"reserved column name: {name}._period")
            if c["name"] in canon:
                raise ValueError(f"duplicate column name: {name}.{c['name']}")
            canon.add(c["name"])
            f = re.sub(r"\s+", " ", c["from"].strip().lower())
            if f in froms:
                raise ValueError(f"duplicate column from: {name}.{c['from']}")
            froms.add(f)

        def ref(col: str | None, _canon: set[str] = canon, _name: str = name) -> None:
            if col is not None and col not in _canon:
                raise ValueError(f"unknown column reference: {_name}.{col}")

        for r in t["exclude"]:
            ref(r["column"])
            try:
                plan_pattern(r["pattern"])
            except re.error:
                raise ValueError(f"invalid pattern: {name}.{r['pattern']}") from None

        unpivot = t.get("unpivot")
        if unpivot:
            for k in unpivot["keep"]:
                ref(k)
            try:
                plan_pattern(unpivot["valuePattern"])
            except re.error:
                raise ValueError(f"invalid pattern: {name}.{unpivot['valuePattern']}") from None
            if (
                unpivot["keyColumn"] in canon
                or unpivot["valueColumn"] in canon
                or unpivot["keyColumn"] == unpivot["valueColumn"]
            ):
                raise ValueError(f"unpivot column collides: {name}")

        period_column = t.get("periodColumn")
        if period_column is not None:
            ref(period_column)
            c = next((x for x in t["columns"] if x["name"] == period_column), None)
            if not c or c.get("parse") != "date":
                raise ValueError(f'periodColumn must have parse "date": {name}.{period_column}')


def plan_table_name(family_key: str, plan: dict, logical_name: str) -> str:
    """Warehouse table name for one logical table (mirrors tableNamesFor's single-table rule)."""
    return f"fam_{family_key}" if len(plan["tables"]) == 1 else f"fam_{family_key}__{logical_name}"
