"""Ports packages/engine/test/distill.test.ts — run-interaction distillation into
0-3 durable memories, driven by the fake client (tests/fake_client.py)."""

import json
from types import SimpleNamespace

from fake_client import make_fake_client

from runoff_api.engine.distill import distill_run

BASE = {"title": "Monthly Performance Report", "section_headings": ["Executive summary", "Budget"]}
NONE = {"steers": [], "answers": [], "flagResolutions": []}


def test_returns_empty_without_an_llm_call_when_the_run_had_no_interactions():
    called = {"v": False}

    def create(**params):
        called["v"] = True
        raise RuntimeError("no")

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    out = distill_run(client=client, **BASE, interactions=NONE, existing=[])
    assert out == []
    assert called["v"] is False


def test_parses_scoped_candidate_memories_from_the_models_json_reply():
    client = make_fake_client([
        [{"text": json.dumps({"memories": [
            {"body": "Always use GBP", "scope": "project"},
            {"body": "Shorter intro", "scope": "blueprint"},
        ]})}],
    ])
    out = distill_run(
        client=client, **BASE,
        interactions={"steers": ["show deltas as percentages"], "answers": [], "flagResolutions": []},
        existing=[],
    )
    assert out == [
        {"body": "Always use GBP", "scope": "project"},
        {"body": "Shorter intro", "scope": "blueprint"},
    ]


def test_drops_entries_with_a_missing_or_invalid_scope():
    client = make_fake_client([
        [{"text": json.dumps({"memories": [
            {"body": "No scope here"},
            {"body": "Bad scope", "scope": "global"},
            {"body": "Keeper", "scope": "blueprint"},
        ]})}],
    ])
    out = distill_run(
        client=client, **BASE,
        interactions={"steers": ["x"], "answers": [], "flagResolutions": []},
        existing=[],
    )
    assert out == [{"body": "Keeper", "scope": "blueprint"}]


def test_drops_case_insensitive_duplicates_of_existing_memories_any_scope_and_caps_at_3():
    client = make_fake_client([
        [{"text": json.dumps({"memories": [
            {"body": "ALWAYS express spend deltas in percentages.", "scope": "blueprint"},
            {"body": "A", "scope": "project"},
            {"body": "B", "scope": "blueprint"},
            {"body": "C", "scope": "project"},
            {"body": "D", "scope": "blueprint"},
        ]})}],
    ])
    out = distill_run(
        client=client, **BASE,
        interactions={"steers": ["x"], "answers": [], "flagResolutions": []},
        # Dedup is on lowercased body regardless of scope: the existing project row
        # still knocks out the blueprint-scoped duplicate.
        existing=[{"body": "Always express spend deltas in percentages.", "scope": "project"}],
    )
    assert out == [
        {"body": "A", "scope": "project"},
        {"body": "B", "scope": "blueprint"},
        {"body": "C", "scope": "project"},
    ]


def test_returns_empty_on_unparseable_model_output_instead_of_throwing():
    client = make_fake_client([[{"text": "not json"}]])
    out = distill_run(
        client=client, **BASE,
        interactions={"steers": ["x"], "answers": [], "flagResolutions": []}, existing=[],
    )
    assert out == []
