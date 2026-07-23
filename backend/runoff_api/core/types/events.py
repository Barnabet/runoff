"""Port of packages/core/src/types/events.ts.

events.ts declares only TypeScript interfaces / a discriminated-union type (no
zod). The reducer consumes plain dicts; these models exist for validation
completeness and later phases. Ported as the `RunEvent` discriminated union plus
`RunStats`, per the task brief.
"""

from typing import Annotated, Literal, Union

from pydantic import Field

from .base import CamelModel
from .document import Block, RunDocument


class RunStats(CamelModel):
    duration_ms: int
    words: int
    sources_used: int
    checks_passed: int
    checks_failed: int
    flag_count: int
    citation_count: int
    retries: int


class RunStartedEvent(CamelModel):
    type: Literal["run_started"]
    section_keys: list[str]
    blueprint_rev: int
    memory_ids: list[str] | None = None
    period: str | None = None
    gaps: list[str] | None = None


class SourceReadEvent(CamelModel):
    type: Literal["source_read"]
    source_id: str
    label: str
    summary: str


class SectionStartedEvent(CamelModel):
    type: Literal["section_started"]
    section_key: str


class TextDeltaEvent(CamelModel):
    type: Literal["text_delta"]
    section_key: str
    text: str


class SectionCompletedEvent(CamelModel):
    type: Literal["section_completed"]
    section_key: str
    blocks: list[Block]
    words: int
    ms: int
    retries: int


class SectionFailedEvent(CamelModel):
    type: Literal["section_failed"]
    section_key: str
    error: str


class CheckPassedEvent(CamelModel):
    type: Literal["check_passed"]
    section_key: str
    rule: str


class CheckFailedEvent(CamelModel):
    type: Literal["check_failed"]
    section_key: str
    rule: str
    detail: str


class RetryStartedEvent(CamelModel):
    type: Literal["retry_started"]
    section_key: str
    reason: str


class QuestionRaisedEvent(CamelModel):
    type: Literal["question_raised"]
    question_id: str
    section_key: str
    question: str
    options: list[str]
    fallback: str
    deadline_section: str


class QuestionAnsweredEvent(CamelModel):
    type: Literal["question_answered"]
    question_id: str
    answer: str


class QuestionFallbackAppliedEvent(CamelModel):
    type: Literal["question_fallback_applied"]
    question_id: str


class FlagRaisedEvent(CamelModel):
    type: Literal["flag_raised"]
    flag_id: str
    code: str
    section_key: str
    question: str
    options: list[str]


class SteerReceivedEvent(CamelModel):
    type: Literal["steer_received"]
    text: str


class PausedEvent(CamelModel):
    type: Literal["paused"]


class ResumedEvent(CamelModel):
    type: Literal["resumed"]


class RenderStartedEvent(CamelModel):
    type: Literal["render_started"]


class RunCompletedEvent(CamelModel):
    type: Literal["run_completed"]
    stats: RunStats
    document: RunDocument


class RunFailedEvent(CamelModel):
    type: Literal["run_failed"]
    error: str


class LogEvent(CamelModel):
    type: Literal["log"]
    level: Literal["info", "warn", "error", "user"]
    message: str


RunEvent = Annotated[
    Union[  # noqa: UP007 - multi-line union kept explicit for readability
        RunStartedEvent,
        SourceReadEvent,
        SectionStartedEvent,
        TextDeltaEvent,
        SectionCompletedEvent,
        SectionFailedEvent,
        CheckPassedEvent,
        CheckFailedEvent,
        RetryStartedEvent,
        QuestionRaisedEvent,
        QuestionAnsweredEvent,
        QuestionFallbackAppliedEvent,
        FlagRaisedEvent,
        SteerReceivedEvent,
        PausedEvent,
        ResumedEvent,
        RenderStartedEvent,
        RunCompletedEvent,
        RunFailedEvent,
        LogEvent,
    ],
    Field(discriminator="type"),
]
