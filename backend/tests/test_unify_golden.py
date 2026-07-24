"""Ports packages/engine/test/unifyGolden.test.ts — converting one report file
into Runoff's universal document JSON. Up to 2 structural attempts + one free
degeneracy retry; None on any client exception."""

import json
from types import SimpleNamespace

from runoff_api.engine.unify_golden import (
    cap_exemplar_text,
    is_unsupported_exemplar_mime,
    unify_golden_report,
)

DOC = {
    "title": "AR Review",
    "eyebrow": "Quarterly",
    "dateline": "Q1 2026",
    "sections": [
        {
            "key": "summary",
            "heading": "Summary",
            "blocks": [{"type": "paragraph", "spans": [{"text": "Total $4.2M"}]}],
        }
    ],
}


def client_returning(*bodies):
    """Chat-completions stub returning each body once in order (or throwing it)."""
    state = {"i": 0}
    calls = []

    def create(**params):
        calls.append(params)
        b = bodies[state["i"]]
        state["i"] += 1
        if isinstance(b, Exception):
            raise b
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=b))])

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    return client, calls


def test_cap_exemplar_text_passes_short_and_head_tail_samples_long():
    assert cap_exemplar_text("short") == "short"
    long = "a" * 30000
    capped = cap_exemplar_text(long)
    assert len(capped) <= 24000 + 20
    assert "\n…\n" in capped


def test_is_unsupported_exemplar_mime_rejects_tabular_accepts_documents():
    assert is_unsupported_exemplar_mime("text/csv")
    assert is_unsupported_exemplar_mime(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )
    assert not is_unsupported_exemplar_mime("application/pdf")
    assert not is_unsupported_exemplar_mime("text/markdown")


def test_returns_validated_document_and_period():
    client, _ = client_returning(json.dumps({"document": DOC, "period": "2026-Q1"}))
    r = unify_golden_report(client=client, filename="ar.md", text="Total $4.2M")
    assert r is not None
    assert r["document"]["sections"][0]["key"] == "summary"
    assert r["period"] == "2026-Q1"


def test_nulls_non_canonical_period_but_keeps_document():
    client, _ = client_returning(json.dumps({"document": DOC, "period": "Q1 of 26"}))
    r = unify_golden_report(client=client, filename="ar.md", text="x")
    assert r is not None
    assert r["period"] is None


def test_retries_once_on_invalid_structure_then_null():
    client, calls = client_returning("not json", "still not json")
    assert unify_golden_report(client=client, filename="ar.md", text="x") is None
    assert len(calls) == 2


def test_degenerate_zero_sections_triggers_exactly_one_extra_attempt():
    empty = {**DOC, "sections": []}
    client, calls = client_returning(
        json.dumps({"document": empty, "period": None}),
        json.dumps({"document": DOC, "period": None}),
    )
    r = unify_golden_report(client=client, filename="ar.md", text="x")
    assert r is not None
    assert len(r["document"]["sections"]) == 1
    assert len(calls) == 2
    assert "zero sections" in calls[1]["messages"][-1]["content"]


def test_client_throw_yields_null_never_throws():
    client, _ = client_returning(Exception("boom"), Exception("boom"))
    assert unify_golden_report(client=client, filename="a.md", text="x") is None
