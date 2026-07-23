"""Port of packages/engine/src/llm.ts.

Construct the LLM client used across the engine. Inference runs against a
locally hosted CLIProxyAPI that speaks the OpenAI-compatible API (serving
GPT 5.6 Sol), so the client is just the `openai` SDK pointed at the local
proxy. Env overrides keep it configurable without code changes.
"""

import os

import openai


def make_llm_client() -> openai.OpenAI:
    return openai.OpenAI(
        base_url=os.environ.get("OPENAI_BASE_URL", "http://localhost:8317/v1"),
        api_key=os.environ.get("OPENAI_API_KEY", "local"),
    )
