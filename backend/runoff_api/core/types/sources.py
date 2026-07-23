"""Port of packages/core/src/types/sources.ts.

`PERIOD_REGEX` is a dict[str, re.Pattern] with the exact regex literals from the
TS source. `ClassifyProposalSchema` is a plain (non-strict) zod object -> the
CamelModelOpen `ClassifyProposal`. TS interface exports (`SourceFamilyRow`,
`ProjectSourceRow`) are compile-time-only and have no Python equivalent — those
rows flow as plain dicts at runtime.
"""

import re
from typing import Literal

from .base import CamelModelOpen
from .parse_plan import ExecReport, ParsePlan, PlanPreview

# Canonical period formats. Lexicographic order is chronological within one granularity.
PERIOD_REGEX: dict[str, re.Pattern] = {
    "quarter": re.compile(r"^\d{4}-Q[1-4]$"),
    "month": re.compile(r"^\d{4}-(0[1-9]|1[0-2])$"),
    "year": re.compile(r"^\d{4}$"),
}

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def format_period(period: str) -> str:
    """Port of formatPeriod. Display form of a canonical period; unknown shapes pass through."""
    if PERIOD_REGEX["quarter"].search(period):
        return f"{period[5:]} {period[0:4]}"
    if PERIOD_REGEX["month"].search(period):
        return f"{MONTHS[int(period[5:]) - 1]} {period[0:4]}"
    return period


class _NewFamily(CamelModelOpen):
    key: str
    label: str
    kind: Literal["periodic", "constant"]
    granularity: Literal["quarter", "month", "year"] | None


class _ClassifyTable(CamelModelOpen):
    name: str
    columns: list[str]
    row_count: float


class ClassifyProposal(CamelModelOpen):
    """What the classifier proposes for one uploaded file."""

    family_key: str
    new_family: _NewFamily | None = None
    period: str | None
    confidence: Literal["high", "medium", "low"]
    tables: list[_ClassifyTable] | None = None
    skipped_fragments: float | None = None
    drift: list[str] | None = None
    plan: ParsePlan | None = None
    plan_status: Literal["stored", "proposed", "amended", "none"] | None = None
    preview: PlanPreview | None = None
    report: ExecReport | None = None
