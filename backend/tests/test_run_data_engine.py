"""Ports packages/engine/test/runData.test.ts case-by-case (snake_cased).

RunData is a plain dict {"catalog": [...], "exec": callable}; exec returns a
SqlResult dict {"columns": [...], "rows": [[...]]}. Document families render
through the source pack unchanged.
"""

from runoff_api.engine.run_data import section_data_block

EMPTY_PACK = {"sources": []}


def fam(**over):
    base = {
        "id": "famA",
        "key": "ar",
        "label": "AR transactions",
        "kind": "periodic",
        "granularity": "quarter",
        "queryable": True,
        "filedPeriods": ["2026-Q1"],
        "tables": [
            {"name": "fam_ar", "columns": [{"name": "amount", "type": "REAL"}], "rowCounts": {"2026-Q1": 3}}
        ],
    }
    base.update(over)
    return base


def section(**over):
    base = {
        "key": "s1",
        "number": 1,
        "heading": "H",
        "mode": "auto",
        "instruction": "i",
        "familyIds": ["famA"],
        "rules": [],
        "queries": [],
    }
    base.update(over)
    return base


def test_renders_baked_query_results_through_format_sql_result():
    calls = []

    def exec_fn(sql):
        calls.append(sql)
        return {"columns": ["total"], "rows": [[123]]}

    data = {"catalog": [fam()], "exec": exec_fn}
    out = section_data_block(
        section(
            queries=[
                {"name": "total", "sql": "SELECT SUM(amount) AS total FROM fam_ar WHERE _period = :period"}
            ]
        ),
        data,
        EMPTY_PACK,
    )
    assert "### AR transactions (famA)" in out
    assert "fam_ar(amount REAL) — 3 rows" in out
    assert "-- total: SELECT SUM(amount) AS total FROM fam_ar WHERE _period = :period" in out
    assert "total\n123" in out
    assert calls == ["SELECT SUM(amount) AS total FROM fam_ar WHERE _period = :period"]


def test_synthesizes_the_default_query_when_no_baked_query_covers_the_family():
    calls = []

    def exec_fn(sql):
        calls.append(sql)
        return {"columns": ["amount"], "rows": [[1]]}

    data = {"catalog": [fam()], "exec": exec_fn}
    out = section_data_block(section(), data, EMPTY_PACK)
    assert '-- default_fam_ar: SELECT * FROM "fam_ar" WHERE _period = :period LIMIT 40' in out
    assert calls == ['SELECT * FROM "fam_ar" WHERE _period = :period LIMIT 40']


def test_constant_family_default_has_no_period_clause():
    data = {
        "catalog": [
            fam(
                kind="constant",
                granularity=None,
                filedPeriods=[],
                tables=[
                    {"name": "fam_ref", "columns": [{"name": "region", "type": "TEXT"}], "rowCounts": {"": 2}}
                ],
            )
        ],
        "exec": lambda sql: {"columns": ["region"], "rows": [["EMEA"]]},
    }
    out = section_data_block(section(), data, EMPTY_PACK)
    assert '-- default_fam_ref: SELECT * FROM "fam_ref" LIMIT 40' in out


def test_a_baked_query_mentioning_one_family_table_suppresses_that_familys_defaults_only():
    data = {
        "catalog": [
            fam(),
            fam(
                id="famB",
                key="spend",
                label="Spend",
                tables=[
                    {
                        "name": "fam_spend",
                        "columns": [{"name": "amount", "type": "REAL"}],
                        "rowCounts": {"2026-Q1": 2},
                    }
                ],
            ),
        ],
        "exec": lambda sql: {"columns": ["c"], "rows": [[1]]},
    }
    out = section_data_block(
        section(
            familyIds=["famA", "famB"],
            queries=[{"name": "ar_total", "sql": "SELECT COUNT(*) AS c FROM fam_ar"}],
        ),
        data,
        EMPTY_PACK,
    )
    assert "-- ar_total:" in out
    assert "default_fam_ar" not in out
    assert "default_fam_spend" in out


def test_renders_query_failed_message_when_exec_throws_and_still_drafts():
    def exec_fn(sql):
        raise ValueError("no such column: nope")

    data = {"catalog": [fam()], "exec": exec_fn}
    out = section_data_block(
        section(queries=[{"name": "bad", "sql": "SELECT nope FROM fam_ar"}]), data, EMPTY_PACK
    )
    assert "query failed: no such column: nope" in out


def test_renders_section_query_covering_no_bound_family_in_one_trailing_block_exactly_once():
    calls = []

    def exec_fn(sql):
        calls.append(sql)
        return {"columns": ["one"], "rows": [[1]]}

    data = {"catalog": [fam()], "exec": exec_fn}
    out = section_data_block(
        section(queries=[{"name": "constant_check", "sql": "SELECT 1 AS one"}]), data, EMPTY_PACK
    )
    assert "-- default_fam_ar:" in out
    assert "-- constant_check: SELECT 1 AS one" in out
    assert "one\n1" in out
    assert out.count("-- constant_check:") == 1
    assert len([s for s in calls if s == "SELECT 1 AS one"]) == 1


def test_does_not_repeat_a_query_covering_a_bound_table_in_the_trailing_block():
    data = {"catalog": [fam()], "exec": lambda sql: {"columns": ["c"], "rows": [[1]]}}
    out = section_data_block(
        section(queries=[{"name": "ar_total", "sql": "SELECT COUNT(*) AS c FROM fam_ar"}]), data, EMPTY_PACK
    )
    assert out.count("-- ar_total:") == 1


def test_renders_query_failed_message_for_an_uncovered_query_whose_exec_throws():
    def exec_fn(sql):
        if sql == "SELECT bad":
            raise ValueError("boom")
        return {"columns": ["amount"], "rows": [[1]]}

    data = {"catalog": [fam()], "exec": exec_fn}
    out = section_data_block(
        section(queries=[{"name": "broken", "sql": "SELECT bad"}]), data, EMPTY_PACK
    )
    assert "-- broken: SELECT bad" in out
    assert "query failed: boom" in out


def test_falls_back_to_pack_for_prompt_for_non_queryable_families():
    pack = {
        "sources": [
            {
                "id": "famDoc",
                "label": "Brand Guide",
                "kind": "document",
                "text": "Voice: plain.",
                "summary": "brand guide",
            }
        ]
    }
    data = {
        "catalog": [
            fam(
                id="famDoc",
                key="brand",
                label="Brand Guide",
                kind="constant",
                granularity=None,
                queryable=False,
                tables=[],
                filedPeriods=[],
            )
        ],
        "exec": lambda sql: (_ for _ in ()).throw(AssertionError("must not be called")),
    }
    out = section_data_block(section(familyIds=["famDoc"]), data, pack)
    assert "### Brand Guide (famDoc)" in out
    assert "Voice: plain." in out
