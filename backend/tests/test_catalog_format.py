"""Ports packages/engine/test/catalogFormat.test.ts case-by-case (snake_cased).

Catalogs flow as plain dicts with camelCase keys at runtime.
"""

from runoff_api.engine.catalog_format import serialize_catalog

FAMS = [
    {
        "id": "fam_1",
        "key": "marketing_spend",
        "label": "Marketing spend",
        "kind": "periodic",
        "granularity": "quarter",
        "queryable": True,
        "filedPeriods": ["2026-Q1", "2026-Q2"],
        "tables": [
            {
                "name": "fam_marketing_spend",
                "columns": [{"name": "campaign", "type": "TEXT"}, {"name": "spend", "type": "REAL"}],
                "rowCounts": {"2026-Q1": 598, "2026-Q2": 606},
            }
        ],
    },
    {
        "id": "fam_2",
        "key": "brand_guidelines",
        "label": "Brand guidelines",
        "kind": "constant",
        "granularity": None,
        "queryable": False,
        "tables": [],
        "filedPeriods": [],
    },
]


def test_renders_the_specs_two_line_per_table_shape():
    out = serialize_catalog(FAMS)
    assert out == (
        'marketing_spend — "Marketing spend" (periodic, quarter; filed: 2026-Q1, 2026-Q2)\n'
        "  fam_marketing_spend(campaign TEXT, spend REAL) — 1,204 rows (2026-Q1: 598, 2026-Q2: 606)\n"
        'brand_guidelines — "Brand guidelines" (constant) — document, not queryable'
    )


def test_marks_a_queryable_constant_familys_counts_without_periods():
    fam = {
        **FAMS[0],
        "key": "rates",
        "label": "Rates",
        "kind": "constant",
        "granularity": None,
        "filedPeriods": [],
        "tables": [
            {"name": "fam_rates", "columns": [{"name": "code", "type": "TEXT"}], "rowCounts": {"": 12}}
        ],
    }
    out = serialize_catalog([fam])
    assert out == 'rates — "Rates" (constant)\n  fam_rates(code TEXT) — 12 rows'


def test_shows_a_queryable_family_with_zero_rows_as_a_gap_not_an_error():
    fam = {**FAMS[0], "tables": [{**FAMS[0]["tables"][0], "rowCounts": {}}]}
    out = serialize_catalog([fam])
    assert "fam_marketing_spend(campaign TEXT, spend REAL) — 0 rows" in out
