"""Port of packages/core/src/types/blueprint.ts.

All zod objects here are plain (non-strict), so they map to CamelModelOpen —
unknown keys are ignored (e.g. a legacy `expression` field is stripped, matching
zod's default key-stripping).
"""

from typing import Literal

from pydantic import Field

from .base import CamelModelOpen

NAME_RE = r"^[a-z][a-z0-9_]*$"


class SectionQuery(CamelModelOpen):
    name: str = Field(pattern=NAME_RE)
    sql: str
    description: str | None = None


class Rule(CamelModelOpen):
    kind: Literal["assert", "style", "judgment"]
    text: str
    sql: str | None = None
    op: Literal["==", "<=", ">=", "<", ">"] | None = None
    value: int | float | None = None  # z.number() — preserve int vs float on round-trip
    within_pct: int | float | None = None


class BlueprintSection(CamelModelOpen):
    key: str
    number: int
    heading: str
    mode: Literal["fixed", "auto", "review"]
    instruction: str
    fixed_text: str | None = None
    family_ids: list[str]
    queries: list[SectionQuery]
    rules: list[Rule]


class Delivery(CamelModelOpen):
    recipient: str
    auto_deliver_on_clear: bool


class BlueprintContent(CamelModelOpen):
    title: str
    client_name: str
    eyebrow: str
    dateline: str
    sections: list[BlueprintSection]
    global_rules: list[str]
    delivery: Delivery
