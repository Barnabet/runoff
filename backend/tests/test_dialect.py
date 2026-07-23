"""Ports the spansFromInline/parseSectionText cases from packages/engine/test/dialect.test.ts."""

from runoff_api.core.dialect import parse_section_text, spans_from_inline


def test_parses_citation_markers_into_cited_spans():
    spans = spans_from_inline(
        "Sessions rose [[12.4%|src_ga4|sum(src_ga4.sessions)]] month over month."
    )
    assert spans == [
        {"text": "Sessions rose "},
        {"text": "12.4%", "citation": {"sourceId": "src_ga4", "locator": "sum(src_ga4.sessions)"}},
        {"text": " month over month."},
    ]


def test_parses_paragraphs_and_tables():
    raw = "\n".join([
        "Revenue held steady at [[$1.2M|src_crm|sum(src_crm.revenue)]].",
        "",
        "| Metric | Value |",
        "| --- | --- |",
        "| Spend | [[240,100|src_spend|sum(src_spend.amount)]] |",
    ])
    blocks = parse_section_text(raw)
    assert len(blocks) == 2
    assert blocks[0]["type"] == "paragraph"
    table = blocks[1]
    assert table["type"] == "table"
    assert table["columns"] == ["Metric", "Value"]
    assert table["rows"][0]["cells"][1][0]["citation"]["sourceId"] == "src_spend"
