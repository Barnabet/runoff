"""Ports packages/engine/test/run.test.ts — the run orchestrator driven through the
fake streaming client (tests/fake_client.py) and a scripted EngineIO."""

import json
import os
from types import SimpleNamespace

from fake_client import make_fake_client

from runoff_api.core.reducer import reduce_run
from runoff_api.engine import run as run_module
from runoff_api.engine.run import execute_run

HERE = os.path.dirname(__file__)
FIXTURES = os.path.join(HERE, "fixtures")


def capturing_client(script):
    """A fake client that records messages[1].content (the section user prompt) of each call."""
    client = make_fake_client(script)
    prompts: list[str] = []
    orig = client.chat.completions.create

    def wrapped(**params):
        prompts.append(params["messages"][1]["content"])
        return orig(**params)

    client.chat.completions.create = wrapped
    return client, prompts


def capturing_system_client(client):
    """Records the system message (messages[0]) of each call."""
    system_prompts: list[str] = []
    orig = client.chat.completions.create

    def wrapped(**params):
        system_prompts.append(params["messages"][0]["content"])
        return orig(**params)

    client.chat.completions.create = wrapped
    return client, system_prompts


def collecting_io(events):
    """An EngineIO that collects emitted events into `events` and no-ops the rest."""
    return SimpleNamespace(emit=events.append, poll_inputs=lambda: [], sleep=lambda ms: None)


def expect_ordered_subsequence(actual, expected):
    """Assert each `expected` type appears in `actual` strictly after the previous match."""
    cursor = 0
    for want in expected:
        try:
            found = actual.index(want, cursor)
        except ValueError:
            found = -1
        assert found >= 0, f'expected "{want}" at/after index {cursor} in {actual}'
        cursor = found + 1


content = {
    "title": "Q2 Report",
    "clientName": "Acme",
    "eyebrow": "Quarterly",
    "dateline": "July 2026",
    "sections": [
        # 1: fixed — no model call
        {"key": "intro", "number": 1, "heading": "Introduction", "mode": "fixed", "instruction": "",
         "fixedText": "Welcome to the report.", "familyIds": [], "queries": [], "rules": []},
        # 2: auto — first draft has an uncited figure (citation check fails), retry cites it (passes)
        {"key": "body", "number": 2, "heading": "Body", "mode": "auto", "instruction": "Write the body.",
         "familyIds": ["src_data"], "queries": [], "rules": []},
        # 3: auto — draft raises a question whose deadline is this very section (fallback applies)
        {"key": "outlook", "number": 3, "heading": "Outlook", "mode": "auto",
         "instruction": "Write the outlook.", "familyIds": [], "queries": [], "rules": []},
    ],
    "globalRules": [],
    "delivery": {"recipient": "", "autoDeliverOnClear": False},
}

# src_data is a document family now (the warehouse owns tabular data), so it flows
# through the pack and fires source_read at run time.
files = [
    {"id": "src_data", "name": "notes.md", "mime": "text/markdown",
     "path": os.path.join(FIXTURES, "notes.md")},
]

# A fake RunData: src_data is a non-queryable document family, exec is never exercised by these fixtures.
data = {
    "catalog": [
        {"id": "src_data", "key": "data", "label": "Data", "kind": "constant", "granularity": None,
         "queryable": False, "tables": [], "filedPeriods": []},
    ],
    "exec": lambda sql: {"columns": ["n"], "rows": [[500]]},
}


def test_drives_a_fixed_retry_question_fallback_blueprint_and_agrees_with_the_reducer():
    client = make_fake_client([
        # body — first draft: uncited figure -> citation check fails
        [{"text": "Spend was $500 this quarter."}],
        # body — retry: cited figure (quote locator, no cross-check) -> passes
        [{"text": "Spend was [[$500|src_data|table row 1]] this quarter."}],
        # outlook — draft turn 1: model asks, deadline is this section
        [{"toolUse": {"name": "ask_user", "input": {
            "question": "Include a forecast?", "options": ["Keep", "Drop"],
            "fallback": "omit the forecast", "deadlineSection": "outlook"}}}],
        # outlook — draft turn 2: plain continuation, no figures
        [{"text": "The outlook is stable."}],
    ])

    events = []
    io = SimpleNamespace(emit=events.append, poll_inputs=lambda: [], sleep=lambda ms: None)

    result = execute_run(client=client, content=content, files=files, data=data, io=io, blueprint_rev=3)
    document, stats = result["document"], result["stats"]

    types = [e["type"] for e in events]
    expect_ordered_subsequence(types, [
        "run_started", "source_read",
        "section_started", "section_completed",                       # fixed section
        "section_started", "check_failed", "retry_started", "check_passed", "section_completed",  # body
        "question_raised", "question_fallback_applied",               # outlook: ask -> fallback
        "render_started", "run_completed",
    ])

    assert types[0] == "run_started"
    assert types[-1] == "run_completed"

    done = next(e for e in events if e["type"] == "run_completed")
    assert done["stats"]["retries"] == 1
    assert stats["retries"] == 1

    assert document["title"] == "Q2 Report"
    assert [s["key"] for s in document["sections"]] == ["intro", "body", "outlook"]

    proj = reduce_run(events, [{"key": s["key"], "number": s["number"]} for s in content["sections"]])
    assert proj["status"] == "complete"


def test_contains_a_section_refusal_emits_section_failed_skips_it_and_still_completes():
    client = make_fake_client([
        [{"stopReason": "refusal"}],           # body — refuses
        [{"text": "The outlook is stable."}],  # outlook — normal
    ])

    events = []
    io = SimpleNamespace(emit=events.append, poll_inputs=lambda: [], sleep=lambda ms: None)

    result = execute_run(client=client, content=content, files=files, data=data, io=io, blueprint_rev=3)
    document = result["document"]

    failed = next(e for e in events if e["type"] == "section_failed")
    assert failed["sectionKey"] == "body"
    assert any(e["type"] == "run_completed" for e in events)
    assert not any(e["type"] == "run_failed" for e in events)

    assert [s["key"] for s in document["sections"]] == ["intro", "outlook"]

    proj = reduce_run(events, [{"key": s["key"], "number": s["number"]} for s in content["sections"]])
    assert proj["status"] == "complete"
    assert proj["sections"]["body"]["state"] == "failed"
    assert proj["sections"]["outlook"]["state"] == "done"


# --- executeRun — v1.1 -------------------------------------------------------


def test_feeds_the_previous_runs_matching_section_as_continuity_and_skips_absent_keys():
    client, prompts = capturing_client([
        [{"text": "Body [[$500|src_data|row 1]] text."}],
        [{"text": "Outlook text with no figures."}],
    ])
    io = SimpleNamespace(emit=lambda e: None, poll_inputs=lambda: [], sleep=lambda ms: None)

    execute_run(
        client=client, content=content, files=files, data=data, io=io, blueprint_rev=3,
        previous_document={
            "title": "T", "eyebrow": "E", "dateline": "D",
            "sections": [
                {"key": "body", "heading": "Body",
                 "blocks": [{"type": "paragraph", "spans": [{"text": "Prior body prose."}]}]},
                # no "outlook" section last run
            ],
        },
    )

    assert "Last run's version of this section" in prompts[0]
    assert "Prior body prose." in prompts[0]
    assert "Last run's version" not in prompts[1]


def test_drains_a_pending_answer_before_the_retry_draft():
    client, prompts = capturing_client([
        # body first draft: uncited figure -> citation audit fails -> retry
        [{"text": "Spend was $500 this quarter."}],
        # body retry: cited -> passes
        [{"text": "Spend was [[$500|src_data|row 1]] this quarter."}],
        # outlook
        [{"text": "Stable outlook."}],
    ])
    polls = {"n": 0}

    def poll_inputs():
        polls["n"] += 1
        # Poll 1 = intro boundary, poll 2 = body boundary, poll 3 = pre-retry drain.
        return [{"kind": "answer", "questionId": "q_manual", "text": "Use plan B"}] if polls["n"] == 3 else []

    io = SimpleNamespace(emit=lambda e: None, poll_inputs=poll_inputs, sleep=lambda ms: None)

    execute_run(client=client, content=content, files=files, data=data, io=io, blueprint_rev=3)

    assert "Use plan B" in prompts[1]
    assert "Use plan B" not in prompts[0]


def test_carries_period_and_gaps_on_run_started_and_omits_both_keys_entirely_when_absent():
    fixed_content = {
        "title": "P", "clientName": "Acme", "eyebrow": "E", "dateline": "D",
        "sections": [{"key": "intro", "number": 1, "heading": "Intro", "mode": "fixed", "instruction": "",
                      "fixedText": "Hi.", "familyIds": [], "queries": [], "rules": []}],
        "globalRules": [], "delivery": {"recipient": "", "autoDeliverOnClear": False},
    }

    with_events = []
    execute_run(client=make_fake_client([]), content=fixed_content, files=[], data=data,
                io=collecting_io(with_events), blueprint_rev=1, period="2026-Q1", gaps=["fam_missing"])
    with_started = next(e for e in with_events if e["type"] == "run_started")
    assert with_started["period"] == "2026-Q1"
    assert with_started["gaps"] == ["fam_missing"]

    bare_events = []
    execute_run(client=make_fake_client([]), content=fixed_content, files=[], data=data,
                io=collecting_io(bare_events), blueprint_rev=1, period=None, gaps=[])
    bare_started = next(e for e in bare_events if e["type"] == "run_started")
    js = json.dumps(bare_started)
    assert '"period"' not in js
    assert '"gaps"' not in js


def test_threads_memory_bodies_into_the_drafting_system_prompt_and_orders_ids_project_first():
    client, system_prompts = capturing_system_client(make_fake_client([[{"text": "Body text."}]]))
    events = []
    execute_run(
        client=client, content=content, files=files, data=data, io=collecting_io(events), blueprint_rev=1,
        memories=[
            {"id": "mem_b", "body": "Lead with the table.", "scope": "blueprint"},
            {"id": "mem_p", "body": "Express deltas as percentages.", "scope": "project"},
        ],
    )
    assert "- Express deltas as percentages." in system_prompts[0]
    assert "- Lead with the table." in system_prompts[0]
    started = next(e for e in events if e["type"] == "run_started")
    assert started["memoryIds"] == ["mem_p", "mem_b"]


# --- executeRun — v1.3b run-level asserts ------------------------------------


def assert_content(rule):
    return {
        "title": "Assert Report", "clientName": "Acme", "eyebrow": "E", "dateline": "D",
        "sections": [
            {"key": "body", "number": 1, "heading": "Body", "mode": "auto", "instruction": "Write the body.",
             "familyIds": [], "queries": [], "rules": [rule]},
        ],
        "globalRules": [], "delivery": {"recipient": "", "autoDeliverOnClear": False},
    }


def test_passes_a_run_level_sql_assert_and_names_the_check_by_its_sql_when_text_blank():
    ct = assert_content({"kind": "assert", "text": "", "sql": "SELECT SUM(amount) FROM ledger",
                         "op": "==", "value": 500})
    client = make_fake_client([[{"text": "The quarter closed on plan."}]])
    events = []

    execute_run(client=client, content=ct, files=[], data=data, io=collecting_io(events), blueprint_rev=1)

    passed = next((e for e in events
                   if e["type"] == "check_passed" and e["rule"] == "SELECT SUM(amount) FROM ledger"), None)
    assert passed is not None
    assert not any(e["type"] == "check_failed" for e in events)
    assert not any(e["type"] == "retry_started" for e in events)


def test_fails_a_run_level_sql_assert_retries_and_flags_when_the_retry_still_fails():
    ct = assert_content({"kind": "assert", "text": "spend under 100", "sql": "SELECT SUM(amount) FROM ledger",
                         "op": "<=", "value": 100})
    client = make_fake_client([
        [{"text": "First draft prose."}],   # draft: assert fails → retry
        [{"text": "Second draft prose."}],  # retry: assert still fails → flag
    ])
    events = []

    execute_run(client=client, content=ct, files=[], data=data, io=collecting_io(events), blueprint_rev=1)

    failed = next((e for e in events if e["type"] == "check_failed" and e["rule"] == "spend under 100"), None)
    assert failed is not None
    assert failed["detail"] == "SELECT SUM(amount) FROM ledger = 500 (expected <= 100) — fail"
    assert any(e["type"] == "retry_started" for e in events)
    assert any(e["type"] == "flag_raised" for e in events)


def test_skips_a_sql_less_assert_at_run_time_while_still_running_sql_asserts():
    ct = {
        "title": "Assert Report", "clientName": "Acme", "eyebrow": "E", "dateline": "D",
        "sections": [
            {"key": "body", "number": 1, "heading": "Body", "mode": "auto", "instruction": "Write the body.",
             "familyIds": [], "queries": [], "rules": [
                 {"kind": "assert", "text": "mention the headline figure"},  # sql-less → skipped at run time
                 {"kind": "assert", "text": "", "sql": "SELECT SUM(amount) FROM ledger",
                  "op": "==", "value": 500},
             ]},
        ],
        "globalRules": [], "delivery": {"recipient": "", "autoDeliverOnClear": False},
    }
    queries = []

    def spy_exec(sql):
        queries.append(sql)
        return {"columns": ["n"], "rows": [[500]]}

    spy_data = {"catalog": [], "exec": spy_exec}
    client = make_fake_client([[{"text": "The quarter closed on plan."}]])
    events = []

    execute_run(client=client, content=ct, files=[], data=spy_data, io=collecting_io(events), blueprint_rev=1)

    assert_passes = [e for e in events
                     if e["type"] == "check_passed" and e["rule"] == "SELECT SUM(amount) FROM ledger"]
    assert len(assert_passes) == 1
    assert not any(e["type"] == "check_failed" for e in events)
    assert not any(e["type"] == "retry_started" for e in events)
    assert queries == ["SELECT SUM(amount) FROM ledger"]


# --- executeRun — pause/resume loop (probe_pause promotion) -------------------


def test_pins_the_pause_loop_and_delivers_a_pause_time_steer_to_the_next_draft(monkeypatch):
    """Promotes the reviewer's throwaway probe_pause.py to a standing test: while
    paused the loop sleeps 200ms before every poll, `paused`/`resumed` bracket the
    pause in order, and a steer posted during the pause reaches the NEXT
    draft_section's `steers` argument. (The engine emits `paused`/`resumed`, not
    `run_paused`/`run_resumed` — this pins the engine's actual event names.)"""
    pause_content = {
        "title": "P", "clientName": "Acme", "eyebrow": "E", "dateline": "D",
        "sections": [
            {"key": "intro", "number": 1, "heading": "Intro", "mode": "fixed", "instruction": "",
             "fixedText": "Hi.", "familyIds": [], "queries": [], "rules": []},
            {"key": "body", "number": 2, "heading": "Body", "mode": "auto",
             "instruction": "Write the body.", "familyIds": [], "queries": [], "rules": []},
        ],
        "globalRules": [], "delivery": {"recipient": "", "autoDeliverOnClear": False},
    }

    # Scripted io: pause at the body boundary (poll 1), then — while paused — a
    # steer (poll 2) and a resume (poll 3). A single timeline ledger records every
    # sleep and poll so we can prove sleep(200) precedes every pause-loop poll.
    timeline: list = []
    poll_scripts = [
        [],                                                    # poll 0: intro boundary
        [{"kind": "pause"}],                                   # poll 1: body boundary -> pause
        [{"kind": "steer", "text": "Lead with Q2 revenue."}],  # poll 2: posted while paused
        [{"kind": "resume"}],                                  # poll 3: resumes the run
    ]
    polls = {"n": 0}

    def poll_inputs():
        i = polls["n"]
        polls["n"] += 1
        msgs = poll_scripts[i] if i < len(poll_scripts) else []
        timeline.append(("poll", i, [m["kind"] for m in msgs]))
        return msgs

    def sleep(ms):
        timeline.append(("sleep", ms))

    events: list = []
    io = SimpleNamespace(emit=events.append, poll_inputs=poll_inputs, sleep=sleep)

    # Snapshot the steers list at each draft_section call — the engine mutates the
    # same list in place, so a live reference would not prove pause-time delivery.
    draft_calls: list = []
    real_draft = run_module.draft_section

    def spy_draft(**kwargs):
        draft_calls.append({"key": kwargs["section"]["key"], "steers": list(kwargs["steers"])})
        return real_draft(**kwargs)

    monkeypatch.setattr(run_module, "draft_section", spy_draft)

    client = make_fake_client([[{"text": "Body text."}]])
    execute_run(client=client, content=pause_content, files=[], data=data, io=io, blueprint_rev=1)

    # paused -> steer_received -> resumed, in order.
    types = [e["type"] for e in events]
    expect_ordered_subsequence(types, ["paused", "steer_received", "resumed"])

    # Every pause-loop poll (polls 2 and 3) is immediately preceded by sleep(200).
    pause_poll_positions = [
        pos for pos, entry in enumerate(timeline) if entry[0] == "poll" and entry[1] >= 2
    ]
    assert pause_poll_positions, "expected polls inside the pause loop"
    for pos in pause_poll_positions:
        assert timeline[pos - 1] == ("sleep", 200), f"poll not preceded by sleep(200): {timeline}"
    # The loop sleeps only 200ms, exactly once per poll it makes (no other sleeps).
    assert [e for e in timeline if e[0] == "sleep"] == [("sleep", 200), ("sleep", 200)]

    # The steer posted during the pause reaches the body draft (the next draft call).
    assert draft_calls[-1]["key"] == "body"
    assert draft_calls[-1]["steers"] == ["Lead with Q2 revenue."]
