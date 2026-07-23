from pydantic import ValidationError

from runoff_api.core.types.sources import (
    PERIOD_REGEX,
    ClassifyProposal,
    format_period,
)


# Ports packages/core/test/sourcesModel.test.ts "period utilities > validates canonical periods".
def test_validates_canonical_periods_per_granularity():
    assert PERIOD_REGEX["quarter"].search("2026-Q1")
    assert not PERIOD_REGEX["quarter"].search("2026-Q5")
    assert not PERIOD_REGEX["quarter"].search("Q1_2026")
    assert PERIOD_REGEX["month"].search("2026-06")
    assert not PERIOD_REGEX["month"].search("2026-13")
    assert PERIOD_REGEX["year"].search("2026")
    assert not PERIOD_REGEX["year"].search("26")


# Ports "period utilities > formats periods for display, auto-detecting granularity".
def test_formats_periods_for_display():
    assert format_period("2026-Q1") == "Q1 2026"
    assert format_period("2026-06") == "Jun 2026"
    assert format_period("2026") == "2026"
    assert format_period("garbage") == "garbage"


# Ports "period utilities > lexicographic MAX is chronological within a granularity".
def test_lexicographic_max_is_chronological():
    assert sorted(["2026-Q1", "2025-Q4", "2026-Q2"])[-1] == "2026-Q2"
    assert sorted(["2026-09", "2026-10", "2026-02"])[-1] == "2026-10"


# Ports "ClassifyProposalSchema > accepts an existing-family and a new-family proposal".
def test_classify_proposal_accepts_existing_and_new_family():
    ClassifyProposal.model_validate({"familyKey": "trade_data", "period": "2026-Q1", "confidence": "high"})
    ClassifyProposal.model_validate({
        "familyKey": "brand_guidelines",
        "newFamily": {"key": "brand_guidelines", "label": "Brand guidelines",
                      "kind": "constant", "granularity": None},
        "period": None,
        "confidence": "medium",
    })


# Ports "ClassifyProposalSchema > rejects unknown confidence and non-string periods".
def test_classify_proposal_rejects_unknown_confidence_and_non_string_periods():
    for bad in (
        {"familyKey": "x", "period": "2026-Q1", "confidence": "sure"},
        {"familyKey": "x", "period": 5, "confidence": "high"},
    ):
        try:
            ClassifyProposal.model_validate(bad)
            raise AssertionError(f"expected ValidationError for {bad}")
        except ValidationError:
            pass
