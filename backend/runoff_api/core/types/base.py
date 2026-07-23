"""Pydantic base models mirroring the zod strictness used across `packages/core/src/types`.

Serialization rule: when a validated model must be re-serialized (e.g. the
revisions POST), use ``model_dump(by_alias=True, exclude_unset=True)`` — optional
fields absent from the input stay absent, explicit nulls stay null, matching
zod's round-trip semantics. Because ``exclude_unset`` drops any field that was
never present in the input, fields carrying a zod ``.default()`` (given a Python
default here, e.g. ``TablePlan.on_period_mismatch``) must be passed explicitly at
construction sites where the serialized output is expected to contain them.
"""

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    """zod `.strict()` equivalent: unknown keys rejected; camelCase wire aliases."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class CamelModelOpen(BaseModel):
    """zod default (non-strict) equivalent: unknown keys ignored."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")
