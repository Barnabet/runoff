"""Ports packages/engine/test/llm.test.ts — the client's endpoint wiring."""

from runoff_api.engine.llm import make_llm_client


def test_defaults_to_the_local_cliproxyapi_endpoint_when_env_is_unset(monkeypatch):
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert "localhost:8317" in str(make_llm_client().base_url)


def test_reflects_openai_base_url_when_overridden(monkeypatch):
    monkeypatch.setenv("OPENAI_BASE_URL", "http://example.test:9000/v1")
    # The Python openai SDK normalizes base_url with a trailing slash (the TS SDK does not).
    assert str(make_llm_client().base_url) == "http://example.test:9000/v1/"
