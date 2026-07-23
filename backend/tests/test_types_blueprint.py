from pydantic import ValidationError

from runoff_api.core.types.blueprint import (
    BlueprintContent,
    BlueprintSection,
    Rule,
    SectionQuery,
)


# Ports packages/core/test/types.test.ts "domain types > validates a blueprint content document".
def test_validates_a_blueprint_content_document():
    bp = {
        "title": "Monthly Performance Report",
        "clientName": "Meridian Retail Group",
        "eyebrow": "PREPARED FOR MERIDIAN RETAIL GROUP · JULY 2026",
        "dateline": "July 2026",
        "sections": [{
            "key": "exec", "number": 2, "heading": "Executive summary", "mode": "review",
            "instruction": "Summarize the month.", "familyIds": ["src_a"], "queries": [],
            "rules": [{"kind": "assert", "text": "spend within budget",
                       "sql": "SELECT SUM(spend) FROM fam_src_a", "op": "<=", "value": 250000}],
        }],
        "globalRules": ["Cite every figure."],
        "delivery": {"recipient": "reports@meridianretail.com", "autoDeliverOnClear": True},
    }
    assert BlueprintContent.model_validate(bp).sections[0].mode == "review"


_base_section = {
    "key": "s1", "number": 1, "heading": "H", "mode": "auto", "instruction": "i",
    "familyIds": [], "rules": [], "queries": [],
}


# Ports "v1.3b blueprint schema > requires queries on sections (empty array ok)".
def test_requires_queries_on_sections_empty_array_ok():
    assert BlueprintSection.model_validate(_base_section).queries == []
    without_queries = {k: v for k, v in _base_section.items() if k != "queries"}
    try:
        BlueprintSection.model_validate(without_queries)
        raise AssertionError("expected ValidationError")
    except ValidationError:
        pass


# Ports "v1.3b blueprint schema > validates query names as identifiers".
def test_validates_query_names_as_identifiers():
    assert SectionQuery.model_validate({"name": "total_paid", "sql": "SELECT 1"}).name == "total_paid"
    for bad in ("Total Paid", "2total"):
        try:
            SectionQuery.model_validate({"name": bad, "sql": "SELECT 1"})
            raise AssertionError(f"expected ValidationError for {bad}")
        except ValidationError:
            pass


# Ports "v1.3b blueprint schema > accepts SQL assert rules and rejects the old expression field".
def test_accepts_sql_assert_rules_and_strips_expression():
    Rule.model_validate({"kind": "assert", "text": "t", "sql": "SELECT 1", "op": ">", "value": 0})
    Rule.model_validate({"kind": "style", "text": "t"})
    parsed = Rule.model_validate(
        {"kind": "assert", "text": "t", "sql": "SELECT 1", "op": ">", "value": 0,
         "expression": "sum(x.y) > 0"}
    )
    assert not hasattr(parsed, "expression")
    assert "expression" not in parsed.model_dump()


# z.number() preserves int identity — an int must survive validate -> model_dump as an int.
def test_rule_value_int_survives_round_trip_as_int():
    parsed = Rule.model_validate({"kind": "assert", "text": "t", "op": "<=", "value": 250000})
    dumped = parsed.model_dump(by_alias=True, exclude_unset=True)
    assert dumped["value"] == 250000
    assert isinstance(dumped["value"], int) and not isinstance(dumped["value"], bool)
