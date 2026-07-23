"""Port of packages/core/src/types/goldenBinding.ts (golden binding inventory, v1.5 spec §2).

All zod objects here are `.strict()` -> CamelModel. The `requireReasonWhenUnbound`
superRefine and the `validateInventoryAnchors` byte-exact checks are ported
verbatim. `validate_inventory_anchors` operates on plain dicts (runtime shape).
"""

from typing import Literal

from pydantic import Field, model_validator

from .base import CamelModel

ID_RE = r"^[a-z][a-z0-9_]*$"


class BindingAnchor(CamelModel):
    section_key: str = Field(min_length=1)
    block_index: int = Field(ge=0)
    span_index: int | None = Field(ge=0)  # nullable, required


class BindingResult(CamelModel):
    family_id: str = Field(min_length=1)
    sql: str = Field(min_length=1)
    verified_value: int | float | str | None
    status: Literal["bound", "mismatch", "error"]


class SubmittedBinding(CamelModel):
    family_id: str = Field(min_length=1)
    sql: str = Field(min_length=1)


def _require_reason_when_unbound(item) -> None:
    binding = item.binding
    status = getattr(binding, "status", None) if binding is not None else None
    if (binding is None or (status is not None and status != "bound")) and item.reason is None:
        raise ValueError("reason required when not bound")


class BindingItem(CamelModel):
    id: str = Field(pattern=ID_RE)
    kind: Literal["value", "table"]
    anchor: BindingAnchor
    raw: str = Field(min_length=1, max_length=200)
    parsed: int | float | str | None
    reason: str | None
    binding: BindingResult | None

    @model_validator(mode="after")
    def _check_reason(self) -> "BindingItem":
        _require_reason_when_unbound(self)
        return self


class SubmittedItem(CamelModel):
    id: str = Field(pattern=ID_RE)
    kind: Literal["value", "table"]
    anchor: BindingAnchor
    raw: str = Field(min_length=1, max_length=200)
    parsed: int | float | str | None
    reason: str | None
    binding: SubmittedBinding | None

    @model_validator(mode="after")
    def _check_reason(self) -> "SubmittedItem":
        _require_reason_when_unbound(self)
        return self


class BindingInventory(CamelModel):
    version: Literal[1]
    items: list[BindingItem] = Field(max_length=60)


class SubmittedInventory(CamelModel):
    version: Literal[1]
    items: list[SubmittedItem] = Field(max_length=60)


def validate_inventory_anchors(inventory: dict, document: dict) -> None:
    """Port of validateInventoryAnchors.

    Throws ValueError on the first bad anchor or duplicate id — byte-exact
    messages, spec §11. Operates on plain dicts.
    """
    seen: set[str] = set()
    for it in inventory["items"]:
        if it["id"] in seen:
            raise ValueError(f"duplicate item id: {it['id']}")
        seen.add(it["id"])
        anchor = it["anchor"]
        section_key = anchor["sectionKey"]
        block_index = anchor["blockIndex"]
        span_index = anchor["spanIndex"]
        section = next((s for s in document["sections"] if s["key"] == section_key), None)
        if section is None:
            raise ValueError(f"unknown section: {section_key}")
        if block_index >= len(section["blocks"]):
            raise ValueError(f"block index out of range: {section_key}[{block_index}]")
        block = section["blocks"][block_index]
        if it["kind"] == "value":
            if block["type"] != "paragraph" or span_index is None:
                raise ValueError(f"anchor kind mismatch: {it['id']}")
            if span_index >= len(block["spans"]):
                raise ValueError(f"span index out of range: {section_key}[{block_index}][{span_index}]")
        else:
            if block["type"] != "table" or span_index is not None:
                raise ValueError(f"anchor kind mismatch: {it['id']}")
