"""Ports packages/engine/test/classify.test.ts — proposing where one uploaded
file belongs in the project's family/period taxonomy. One chat call, JSON-object
response; null on any failure or a semantically invalid proposal."""

import json
from types import SimpleNamespace

from runoff_api.engine.classify import classify_source


def client(content):
    """Chat-completions stub returning a fixed JSON body (or throwing)."""

    def create(**params):
        if isinstance(content, Exception):
            raise content
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])

    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))


FAMILIES = [
    {"key": "trade_data", "label": "Trade data", "kind": "periodic", "granularity": "quarter"},
    {"key": "brand_guidelines", "label": "Brand guidelines", "kind": "constant", "granularity": None},
]

BASE = {"filename": "trade_q2.csv", "content_sample": "date,volume\n2026-04-01,10", "families": FAMILIES}


def test_accepts_a_valid_existing_family_proposal():
    p = classify_source(
        client=client(json.dumps({"familyKey": "trade_data", "period": "2026-Q2", "confidence": "high"})),
        **BASE,
    )
    assert p == {"familyKey": "trade_data", "period": "2026-Q2", "confidence": "high"}


def test_accepts_a_valid_new_family_proposal():
    p = classify_source(
        client=client(
            json.dumps(
                {
                    "familyKey": "spend_data",
                    "newFamily": {
                        "key": "spend_data",
                        "label": "Spend data",
                        "kind": "periodic",
                        "granularity": "month",
                    },
                    "period": "2026-06",
                    "confidence": "medium",
                }
            )
        ),
        **BASE,
    )
    assert p["newFamily"]["granularity"] == "month"


def test_nulls_on_period_not_matching_the_existing_familys_granularity():
    assert (
        classify_source(
            client=client(json.dumps({"familyKey": "trade_data", "period": "2026-06", "confidence": "high"})),
            **BASE,
        )
        is None
    )


def test_nulls_on_new_family_present_for_existing_key_or_absent_for_unknown_key():
    assert (
        classify_source(
            client=client(
                json.dumps(
                    {
                        "familyKey": "trade_data",
                        "newFamily": {
                            "key": "trade_data",
                            "label": "x",
                            "kind": "periodic",
                            "granularity": "quarter",
                        },
                        "period": "2026-Q2",
                        "confidence": "high",
                    }
                )
            ),
            **BASE,
        )
        is None
    )
    assert (
        classify_source(
            client=client(json.dumps({"familyKey": "mystery", "period": "2026-Q2", "confidence": "high"})),
            **BASE,
        )
        is None
    )


def test_nulls_on_constant_family_with_a_period_periodic_without_one():
    assert (
        classify_source(
            client=client(
                json.dumps({"familyKey": "brand_guidelines", "period": "2026-Q2", "confidence": "high"})
            ),
            **BASE,
        )
        is None
    )
    assert (
        classify_source(
            client=client(json.dumps({"familyKey": "trade_data", "period": None, "confidence": "high"})),
            **BASE,
        )
        is None
    )


def test_nulls_on_constant_new_family_carrying_a_granularity_or_periodic_new_family_missing_one():
    assert (
        classify_source(
            client=client(
                json.dumps(
                    {
                        "familyKey": "ref",
                        "newFamily": {
                            "key": "ref",
                            "label": "Ref",
                            "kind": "constant",
                            "granularity": "quarter",
                        },
                        "period": None,
                        "confidence": "low",
                    }
                )
            ),
            **BASE,
        )
        is None
    )
    assert (
        classify_source(
            client=client(
                json.dumps(
                    {
                        "familyKey": "np",
                        "newFamily": {"key": "np", "label": "NP", "kind": "periodic", "granularity": None},
                        "period": "2026-Q1",
                        "confidence": "low",
                    }
                )
            ),
            **BASE,
        )
        is None
    )


def test_nulls_on_api_error_and_on_non_json_output():
    assert classify_source(client=client(RuntimeError("proxy down")), **BASE) is None
    assert classify_source(client=client("not json"), **BASE) is None
