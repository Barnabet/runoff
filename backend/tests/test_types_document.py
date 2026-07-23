import pytest
from pydantic import ValidationError

from runoff_api.core.types.document import (
    RunDocument,
    blocks_to_plain_text,
    count_words,
)


def _doc(sections):
    return {"title": "T", "eyebrow": "E", "dateline": "D", "sections": sections}


def test_run_document_rejects_duplicate_section_keys():
    doc = _doc([
        {"key": "cash", "heading": "Cash", "blocks": []},
        {"key": "cash", "heading": "Cash 2", "blocks": []},
    ])
    with pytest.raises(ValidationError, match="duplicate section key: cash"):
        RunDocument.model_validate(doc)


def test_run_document_rejects_unknown_keys():
    doc = _doc([])
    doc["extra"] = 1
    with pytest.raises(ValidationError):
        RunDocument.model_validate(doc)


def test_blocks_to_plain_text_joins_tables_with_middle_dot():
    blocks = [
        {"type": "paragraph", "spans": [
            {"text": "Hi "}, {"text": "there", "citation": {"sourceId": "f", "locator": "l"}},
        ]},
        {"type": "table", "columns": ["A"], "rows": [{"cells": [[{"text": "1"}, {"text": "2"}]]}]},
    ]
    assert blocks_to_plain_text(blocks) == "Hi there\n\n12"


def test_blocks_to_plain_text_joins_cells_within_a_row_with_middle_dot():
    blocks = [
        {"type": "table", "columns": ["A", "B"],
         "rows": [{"cells": [[{"text": "open"}], [{"text": "1,000"}]]}]},
    ]
    assert blocks_to_plain_text(blocks) == "open · 1,000"


# Ports packages/core/test/types.test.ts "counts words and flattens blocks".
def test_counts_words_and_flattens_blocks():
    blocks = [
        {"type": "paragraph", "spans": [
            {"text": "Sessions rose "},
            {"text": "12.4%", "citation": {"sourceId": "src_a", "locator": "sum(src_a.sessions)"}},
        ]},
        {"type": "table", "columns": ["Metric", "Value"],
         "rows": [{"cells": [[{"text": "Spend"}], [{"text": "240,100"}]]}]},
    ]
    assert count_words(blocks) > 3
    assert "12.4%" in blocks_to_plain_text(blocks)
