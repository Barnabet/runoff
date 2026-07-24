"""Twin of packages/engine/test/scaffoldGolden.test.ts (all 7 cases), snake_cased."""

from runoff_api.engine.scaffold_golden import (
    build_scaffold_digest,
    render_scaffold_digest,
)

DOC = {
    "title": "AR Review",
    "eyebrow": "",
    "dateline": "",
    "sections": [
        {
            "key": "overview",
            "heading": "Overview",
            "blocks": [
                {
                    "type": "paragraph",
                    "spans": [
                        {"text": "Total AR is "},
                        {"text": "$4.2M"},
                        {"text": " across "},
                        {"text": "1,204"},
                        {"text": " invoices."},
                    ],
                },
                {
                    "type": "table",
                    "columns": ["status", "amount"],
                    "rows": [
                        {"cells": [[{"text": "open"}], [{"text": "$1M"}]]},
                        {"cells": [[{"text": "paid"}], [{"text": "$3M"}]]},
                    ],
                },
            ],
        },
        {
            "key": "empty_sec",
            "heading": "Notes",
            "blocks": [{"type": "paragraph", "spans": [{"text": "No figures here."}]}],
        },
    ],
}


def item(**over):
    base = {
        "kind": "value",
        "raw": "x",
        "parsed": 1,
        "reason": None,
        "anchor": {"sectionKey": "overview", "blockIndex": 0, "spanIndex": 1},
        "binding": {"familyId": "fam_ar", "sql": "SELECT 1", "verifiedValue": 1, "status": "bound"},
    }
    base.update(over)
    return base


def golden(items):
    return {
        "id": "g1",
        "label": "AR exemplar",
        "period": "2026-Q1",
        "document": DOC,
        "inventory": {"version": 1, "items": items},
    }


class TestBuildScaffoldDigest:
    def test_groups_lifted_queries_by_anchor_section_in_document_order(self):
        d = build_scaffold_digest(
            golden(
                [
                    item(
                        id="total",
                        raw="$4.2M",
                        binding={
                            "familyId": "fam_ar",
                            "sql": "SELECT SUM(amount) FROM fam_ar WHERE _period = :period",
                            "verifiedValue": 4200000,
                            "status": "bound",
                        },
                    ),
                    item(
                        id="tbl",
                        kind="table",
                        parsed=None,
                        anchor={"sectionKey": "overview", "blockIndex": 1, "spanIndex": None},
                        raw="table: status, amount",
                        binding={
                            "familyId": "fam_ar",
                            "sql": "SELECT status, SUM(amount) FROM fam_ar GROUP BY status",
                            "verifiedValue": 2,
                            "status": "bound",
                        },
                    ),
                ]
            )
        )
        assert [s["key"] for s in d["sections"]] == ["overview", "empty_sec"]
        assert d["sections"][0]["queries"] == [
            {
                "name": "total",
                "sql": "SELECT SUM(amount) FROM fam_ar WHERE _period = :period",
                "provenance": "verified",
            },
            {
                "name": "tbl",
                "sql": "SELECT status, SUM(amount) FROM fam_ar GROUP BY status",
                "provenance": "verified",
            },
        ]
        assert d["boundness"] == "2/2 bound, 0 mismatch, 0 unbound"

    def test_lifts_mismatch_sql_plus_warning_unbound_error_become_warnings(self):
        d = build_scaffold_digest(
            golden(
                [
                    item(
                        id="stale",
                        raw="$4.2M",
                        binding={
                            "familyId": "fam_ar",
                            "sql": "SELECT SUM(x) FROM fam_ar",
                            "verifiedValue": 3981102,
                            "status": "mismatch",
                        },
                    ),
                    item(
                        id="orphan",
                        raw="12",
                        binding=None,
                        reason="no matching family",
                        anchor={"sectionKey": "overview", "blockIndex": 0, "spanIndex": 3},
                    ),
                    item(
                        id="broken",
                        raw="7",
                        reason="sql error: boom",
                        anchor={"sectionKey": "overview", "blockIndex": 0, "spanIndex": 4},
                        binding={
                            "familyId": "fam_ar",
                            "sql": "SELECT bad",
                            "verifiedValue": None,
                            "status": "error",
                        },
                    ),
                ]
            )
        )
        s = d["sections"][0]
        assert s["queries"] == [
            {"name": "stale", "sql": "SELECT SUM(x) FROM fam_ar", "provenance": "verified-mismatch"}
        ]
        assert s["warnings"] == [
            '"$4.2M" mismatches current data (golden says $4.2M · data 3981102)',
            '"12" has no data backing (no matching family)',
            '"7" has no data backing (sql error: boom)',
        ]

    def test_flags_sections_with_no_lifted_queries(self):
        d = build_scaffold_digest(golden([]))
        assert d["sections"][0]["warnings"] == ["no verified queries in this section"]
        assert d["sections"][1]["warnings"] == ["no verified queries in this section"]

    def test_renders_prose_spaces_tables_header_only_capped(self):
        d = build_scaffold_digest(golden([]))
        assert d["sections"][0]["prose"] == (
            "Total AR is  $4.2M  across  1,204  invoices.\n[table 2 cols × 2 rows: status | amount]"
        )
        long_doc = {
            **DOC,
            "sections": [
                {
                    "key": "big",
                    "heading": "B",
                    "blocks": [{"type": "paragraph", "spans": [{"text": "x" * 2000}]}],
                }
            ],
        }
        d2 = build_scaffold_digest({**golden([]), "document": long_doc})
        assert len(d2["sections"][0]["prose"]) == 1501  # 1500 + trailing …
        assert d2["sections"][0]["prose"].endswith("…")

    def test_defensively_dedupes_repeated_lifted_names(self):
        d = build_scaffold_digest(
            golden(
                [
                    item(id="dup"),
                    item(id="dup", anchor={"sectionKey": "overview", "blockIndex": 0, "spanIndex": 3}),
                ]
            )
        )
        assert [q["name"] for q in d["sections"][0]["queries"]] == ["dup", "dup_2"]


class TestRenderScaffoldDigest:
    def test_renders_the_exact_digest_format(self):
        d = build_scaffold_digest(
            golden(
                [
                    item(
                        id="total",
                        raw="$4.2M",
                        binding={
                            "familyId": "fam_ar",
                            "sql": "SELECT SUM(amount) FROM fam_ar",
                            "verifiedValue": 4200000,
                            "status": "bound",
                        },
                    ),
                ]
            )
        )
        text = render_scaffold_digest(d)
        assert text.startswith(
            'SCAFFOLD DIGEST — golden "AR exemplar" (period 2026-Q1, 1/1 bound, 0 mismatch, 0 unbound)'
        )
        assert "## section: overview — Overview" in text
        assert "prose:\nTotal AR is  $4.2M  across  1,204  invoices." in text
        assert "queries:\n  total: SELECT SUM(amount) FROM fam_ar  [verified]" in text
        assert "## section: empty_sec — Notes" in text
        assert "warnings:\n  - no verified queries in this section" in text

    def test_renders_period_none_for_a_period_less_golden(self):
        d = build_scaffold_digest({**golden([]), "period": None})
        assert "(period none," in render_scaffold_digest(d)
