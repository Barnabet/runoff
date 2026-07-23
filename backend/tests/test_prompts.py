"""Ports packages/engine/test/prompts.test.ts — asserts exact prompt output strings."""

from runoff_api.engine.prompts import section_user_prompt, system_prompt

BASE = {
    "dataBlock": "### AR transactions (famA)\namount 12,340",
    "completed": [],
    "steers": [],
    "answers": [],
}


def section(rules: list[dict]) -> dict:
    return {
        "key": "exec",
        "number": 2,
        "heading": "Executive summary",
        "mode": "auto",
        "instruction": "Summarize the quarter.",
        "familyIds": [],
        "queries": [],
        "rules": rules,
    }


CONTENT = {
    "title": "Monthly Performance Report",
    "clientName": "Meridian Retail",
    "eyebrow": "Marketing Performance",
    "dateline": "June 2026",
    "sections": [],
    "globalRules": [],
    "delivery": {"recipient": "ops@example.com", "autoDeliverOnClear": False},
}

PROJECT_HEADING = (
    "Standing guidance for this project (applies to every document in this project — "
    "follow unless blueprint guidance or a section instruction contradicts it):"
)
BLUEPRINT_HEADING = (
    "Standing guidance for this blueprint (learned from the builder and past runs — "
    "follow unless a section instruction contradicts it):"
)


# --- sectionUserPrompt — data block + rules block ---


def test_lands_the_section_data_block_under_the_sources_heading():
    prompt = section_user_prompt(**BASE, section=section([]))
    assert "Sources bound to this section:\n### AR transactions (famA)\namount 12,340" in prompt


def test_lists_each_rules_kind_and_text_so_the_rules_reach_the_model():
    prompt = section_user_prompt(
        **BASE,
        section=section(
            [
                {"kind": "style", "text": "Keep the tone measured."},
                {"kind": "judgment", "text": "Flag any layoffs mention for review."},
                {
                    "kind": "assert",
                    "text": "Spend must be positive.",
                    "sql": "SELECT SUM(amount) FROM fam_ar_transactions",
                    "op": ">",
                    "value": 0,
                },
            ]
        ),
    )

    assert "Rules for this section:" in prompt
    assert "- [style] Keep the tone measured." in prompt
    assert "- [judgment] Flag any layoffs mention for review." in prompt
    # An assert with an SQL check surfaces the SQL inline.
    assert "- [assert] Spend must be positive. (sql: SELECT SUM(amount) FROM fam_ar_transactions)" in prompt
    # The block explains how each kind is enforced.
    assert "assert rules are verified deterministically after drafting" in prompt
    assert "judgment rules should prompt raise_flag when triggered" in prompt


def test_collapses_newlines_in_a_multiline_assert_sql_onto_one_line():
    prompt = section_user_prompt(
        **BASE,
        section=section(
            [
                {
                    "kind": "assert",
                    "text": "",
                    "sql": "SELECT SUM(amount)\n  FROM fam_ar_transactions",
                    "op": ">",
                    "value": 0,
                }
            ]
        ),
    )
    assert "(sql: SELECT SUM(amount) FROM fam_ar_transactions)" in prompt


def test_omits_the_sql_suffix_for_an_assert_rule_that_has_none():
    prompt = section_user_prompt(
        **BASE,
        section=section([{"kind": "assert", "text": "Mention the headline figure."}]),
    )
    assert "- [assert] Mention the headline figure." in prompt
    assert "(sql:" not in prompt


def test_emits_no_rules_block_when_the_section_has_no_rules():
    prompt = section_user_prompt(**BASE, section=section([]))
    assert "Rules for this section:" not in prompt


# --- continuity block ---


def test_pins_the_stability_contract_wording_when_previous_section_text_is_given():
    prompt = section_user_prompt(
        **BASE,
        section=section([]),
        previousSectionText="June spend totaled 208,200 within the cap.",
    )
    assert (
        "Last run's version of this section (keep its structure and wording where the\n"
        "underlying data is unchanged; update figures and note material changes):"
    ) in prompt
    assert "June spend totaled 208,200 within the cap." in prompt


def test_emits_no_continuity_block_for_a_first_run():
    prompt = section_user_prompt(**BASE, section=section([]))
    assert "Last run's version" not in prompt


# --- citation-marker wording ---


def test_the_dialect_contract_shows_a_numeral_placeholder_and_a_concrete_warehouse_table_example():
    prompt = system_prompt(CONTENT)
    assert "[[numeral|familyId|locator]]" in prompt
    assert "[[220,500|fam_ab12|sum(fam_ar_transactions.amount)]]" in prompt
    assert "[[figure|" not in prompt


def test_describes_the_agg_table_name_column_locator_grammar_against_warehouse_tables():
    prompt = system_prompt(CONTENT)
    assert "locator is agg(tableName.column)" in prompt
    assert "fam_ar_transactions" in prompt


def test_advertises_row_filtered_locators_and_bans_internal_mechanics_questions():
    prompt = system_prompt(CONTENT)
    assert "sum(fam_ar_transactions.amount where channel=search)" in prompt
    assert "never about the dialect, citation markers, or locator grammar" in prompt


def test_the_retry_feedback_tells_the_model_to_wrap_the_numeral_itself():
    prompt = section_user_prompt(
        **BASE,
        section=section([]),
        retryFeedback="uncited figure: 4",
    )
    assert "A previous draft failed checks: uncited figure: 4" in prompt
    assert "the visible text must be the actual number" in prompt
    assert "[[figure|" not in prompt


# --- standing-guidance blocks ---


def test_renders_the_project_block_before_the_blueprint_block():
    prompt = system_prompt(
        CONTENT,
        [
            {"id": "m1", "body": "GBP only", "scope": "project"},
            {"id": "m2", "body": "Lead with table", "scope": "blueprint"},
        ],
    )
    assert PROJECT_HEADING in prompt
    assert BLUEPRINT_HEADING in prompt
    # Project block precedes the blueprint block.
    assert prompt.index(PROJECT_HEADING) < prompt.index(BLUEPRINT_HEADING)
    # Each body sits under its own heading.
    proj_seg = prompt[prompt.index(PROJECT_HEADING) : prompt.index(BLUEPRINT_HEADING)]
    bp_seg = prompt[prompt.index(BLUEPRINT_HEADING) :]
    assert "- GBP only" in proj_seg
    assert "- Lead with table" not in proj_seg
    assert "- Lead with table" in bp_seg


def test_omits_the_blueprint_heading_for_project_only_memories_and_vice_versa():
    project_only = system_prompt(CONTENT, [{"id": "m1", "body": "GBP only", "scope": "project"}])
    assert PROJECT_HEADING in project_only
    assert BLUEPRINT_HEADING not in project_only

    blueprint_only = system_prompt(CONTENT, [{"id": "m2", "body": "Lead with table", "scope": "blueprint"}])
    assert BLUEPRINT_HEADING in blueprint_only
    assert PROJECT_HEADING not in blueprint_only


def test_standing_guidance_is_absent_without_memories():
    assert "Standing guidance" not in system_prompt(CONTENT)
    assert "Standing guidance" not in system_prompt(CONTENT, [])
