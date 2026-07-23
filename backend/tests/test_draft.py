"""Ports packages/engine/test/draft.test.ts — the streaming section draft loop,
driven by the ported fake streaming client (tests/fake_client.py)."""

from types import SimpleNamespace

import pytest
from fake_client import make_fake_client

from runoff_api.engine.draft import RefusalError, draft_section

content = {
    "title": "T", "clientName": "C", "eyebrow": "E", "dateline": "D",
    "sections": [{
        "key": "exec", "number": 2, "heading": "Executive summary", "mode": "auto",
        "instruction": "Summarize.", "familyIds": ["src_spend"], "queries": [], "rules": [],
    }],
    "globalRules": [], "delivery": {"recipient": "", "autoDeliverOnClear": False},
}
data_block = (
    "### spend (src_spend)\nfam_spend(amount REAL) — 2 rows\n-- default: SELECT SUM(amount) FROM fam_spend\n1"
)

ASK_INPUT = {
    "question": "Cite them?", "options": ["Cite", "Skip"], "fallback": "skip", "deadlineSection": "exec",
}
FLAG_INPUT = {"question": "Tone ok?", "options": ["Keep", "Soften"]}


def cb(*, on_delta=lambda t: None, on_flag=lambda f: None, on_question=lambda q: None):
    return SimpleNamespace(on_delta=on_delta, on_flag=on_flag, on_question=on_question)


def draft(client, callbacks):
    return draft_section(
        client=client, content=content, section=content["sections"][0], data_block=data_block,
        completed=[], steers=[], answers=[], cb=callbacks,
    )


def test_streams_deltas_and_parses_the_final_dialect_text():
    client = make_fake_client([[{"text": "Spend was [[$1|src_spend|sum(src_spend.amount)]] overall."}]])
    deltas = []
    r = draft(client, cb(on_delta=deltas.append))
    assert "Spend was" in "".join(deltas)
    assert r["blocks"][0]["type"] == "paragraph"


def test_surfaces_raise_flag_and_ask_user_tool_calls_then_continues_the_turn():
    client = make_fake_client([
        [{"toolUse": {"name": "ask_user", "input": ASK_INPUT}}],
        [
            {"text": "Final text."},
            {"toolUse": {"name": "raise_flag", "input": FLAG_INPUT}},
        ],
        [{"text": "Final text."}],
    ])
    flags = []
    questions = []
    r = draft(client, cb(
        on_flag=lambda f: flags.append(f["question"]),
        on_question=lambda q: questions.append(q["question"]),
    ))
    assert questions == ["Cite them?"]
    assert flags == ["Tone ok?"]
    assert "Final text." in r["raw"]


def test_accumulates_fragmented_tool_call_arguments_across_two_tool_calls_in_one_turn():
    client = make_fake_client([
        [
            {"toolUse": {"name": "ask_user", "input": ASK_INPUT}},
            {"toolUse": {"name": "raise_flag", "input": FLAG_INPUT}},
        ],
        [{"text": "Done."}],
    ])
    flags = []
    questions = []
    r = draft(client, cb(on_flag=flags.append, on_question=questions.append))
    assert questions == [ASK_INPUT]
    assert flags == [FLAG_INPUT]
    assert "Done." in r["raw"]


def test_throws_a_typed_refusal_error_when_the_model_refuses_to_draft():
    client = make_fake_client([[{"stopReason": "refusal"}]])
    with pytest.raises(RefusalError):
        draft(client, cb())
    with pytest.raises(RefusalError, match="model refused to draft this section"):
        draft(client, cb())


def test_skips_a_malformed_tool_argument_payload_and_keeps_drafting():
    client = make_fake_client([
        [{"toolUse": {"name": "raise_flag", "rawArguments": "{ this is not json"}}],
        [{"text": "Recovered and finished."}],
    ])
    flags = []
    r = draft(client, cb(on_flag=flags.append))
    assert flags == []  # malformed args → callback skipped
    assert "Recovered and finished." in r["raw"]


def test_retries_once_with_a_larger_budget_when_a_draft_is_truncated_by_length():
    client = make_fake_client([
        [{"text": "Partial draft ", "stopReason": "max_tokens"}],
        [{"text": "Complete draft after retry."}],
    ])
    r = draft(client, cb())
    assert "Complete draft after retry." in r["raw"]
    assert "Partial draft" not in r["raw"]


def test_accepts_the_truncated_text_when_the_length_retry_also_truncates():
    client = make_fake_client([[{"text": "Truncated only.", "stopReason": "max_tokens"}]])
    r = draft(client, cb())
    assert "Truncated only." in r["raw"]
