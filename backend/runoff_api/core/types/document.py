"""Port of packages/core/src/types/document.ts (v1.5 doc shapes + zod schemas)."""

import re
from typing import Annotated, Literal

from pydantic import Field, model_validator

from .base import CamelModel

KEY_RE = r"^[a-z][a-z0-9_]*$"


class Citation(CamelModel):
    source_id: str = Field(min_length=1)
    locator: str = Field(min_length=1)


class Span(CamelModel):
    text: str
    citation: Citation | None = None


class ParagraphBlock(CamelModel):
    type: Literal["paragraph"]
    spans: list[Span]


class TableRowModel(CamelModel):
    cells: list[list[Span]]


class TableBlock(CamelModel):
    type: Literal["table"]
    columns: list[str]
    rows: list[TableRowModel]


Block = Annotated[ParagraphBlock | TableBlock, Field(discriminator="type")]


class DocSection(CamelModel):
    key: str = Field(pattern=KEY_RE)
    heading: str = Field(min_length=1)
    blocks: list[Block]


class RunDocument(CamelModel):
    title: str
    eyebrow: str
    dateline: str
    sections: list[DocSection]

    @model_validator(mode="after")
    def _unique_section_keys(self) -> "RunDocument":
        seen: set[str] = set()
        for s in self.sections:
            if s.key in seen:
                raise ValueError(f"duplicate section key: {s.key}")
            seen.add(s.key)
        return self


def blocks_to_plain_text(blocks: list[dict]) -> str:
    """Port of blocksToPlainText — operates on plain dicts (runtime shape)."""
    out = []
    for b in blocks:
        if b["type"] == "paragraph":
            out.append("".join(s["text"] for s in b["spans"]))
        else:
            out.append("\n".join(
                " · ".join("".join(s["text"] for s in cell) for cell in row["cells"])
                for row in b["rows"]
            ))
    return "\n\n".join(out)


def count_words(blocks: list[dict]) -> int:
    """Port of countWords."""
    return len([w for w in re.split(r"\s+", blocks_to_plain_text(blocks)) if w])
