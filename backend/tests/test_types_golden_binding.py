from pydantic import ValidationError

from runoff_api.core.types.document import RunDocument
from runoff_api.core.types.golden_binding import (
    BindingInventory,
    SubmittedInventory,
    validate_inventory_anchors,
)

DOC = {
    "title": "AR Review", "eyebrow": "Quarterly", "dateline": "Q1 2026",
    "sections": [
        {"key": "summary", "heading": "Summary", "blocks": [
            {"type": "paragraph", "spans": [{"text": "Total reached "}, {"text": "$4.2M"}]},
            {"type": "table", "columns": ["status", "total"],
             "rows": [{"cells": [[{"text": "open"}], [{"text": "1,000"}]]}]},
        ]},
    ],
}


def _item(**over):
    base = {
        "id": "total", "kind": "value",
        "anchor": {"sectionKey": "summary", "blockIndex": 0, "spanIndex": 1},
        "raw": "$4.2M", "parsed": 4200000, "binding": None, "reason": "no candidate",
    }
    base.update(over)
    return base


def _raises(fn, msg):
    try:
        fn()
    except ValueError as e:
        assert str(e) == msg, f"expected {msg!r}, got {str(e)!r}"
        return
    raise AssertionError(f"expected error {msg!r}")


# Ports packages/core/test/goldenBinding.test.ts "RunDocumentSchema > accepts and rejects bad keys".
def test_run_document_accepts_and_rejects_bad_section_keys():
    RunDocument.model_validate(DOC)
    bad = {**DOC, "sections": [{**DOC["sections"][0], "key": "Bad Key"}]}
    try:
        RunDocument.model_validate(bad)
        raise AssertionError("expected ValidationError")
    except ValidationError:
        pass


# Ports "RunDocumentSchema > rejects duplicate section keys".
def test_run_document_rejects_duplicate_section_keys():
    dup = {**DOC, "sections": [DOC["sections"][0], DOC["sections"][0]]}
    try:
        RunDocument.model_validate(dup)
        raise AssertionError("expected ValidationError")
    except ValidationError:
        pass


# Ports "inventory schemas > stored form requires status; submitted form forbids it".
def test_stored_requires_status_submitted_forbids_it():
    stored = {"version": 1, "items": [_item(
        binding={"familyId": "fam_1", "sql": "SELECT 1", "verifiedValue": 4200000, "status": "bound"},
        reason=None,
    )]}
    BindingInventory.model_validate(stored)
    submitted = {"version": 1, "items": [_item(
        binding={"familyId": "fam_1", "sql": "SELECT 1"}, reason=None,
    )]}
    SubmittedInventory.model_validate(submitted)
    try:
        SubmittedInventory.model_validate(stored)
        raise AssertionError("expected ValidationError (extra keys)")
    except ValidationError:
        pass


# Ports "inventory schemas > requires reason when unbound".
def test_requires_reason_when_unbound():
    try:
        BindingInventory.model_validate({"version": 1, "items": [_item(reason=None)]})
        raise AssertionError("expected ValidationError")
    except ValidationError:
        pass


# Ports "validateInventoryAnchors > accepts valid value and table anchors".
def test_validate_inventory_anchors_accepts_valid():
    inv = {"items": [
        _item(),
        _item(id="tbl", kind="table", anchor={"sectionKey": "summary", "blockIndex": 1, "spanIndex": None}),
    ]}
    validate_inventory_anchors(inv, DOC)


# Ports "validateInventoryAnchors > throws byte-exact anchor errors".
def test_validate_inventory_anchors_byte_exact_errors():
    def anc(section_key, block_index, span_index):
        return {"sectionKey": section_key, "blockIndex": block_index, "spanIndex": span_index}

    def check(items, msg):
        _raises(lambda: validate_inventory_anchors({"items": items}, DOC), msg)

    check([_item(anchor=anc("nope", 0, 0))], "unknown section: nope")
    check([_item(anchor=anc("summary", 9, 0))], "block index out of range: summary[9]")
    check([_item(anchor=anc("summary", 0, 7))], "span index out of range: summary[0][7]")
    check([_item(id="t", kind="table", anchor=anc("summary", 0, None))], "anchor kind mismatch: t")
    check([_item(id="v", kind="value", anchor=anc("summary", 1, None))], "anchor kind mismatch: v")
    check([_item(), _item()], "duplicate item id: total")
