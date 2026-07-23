"""Port of packages/engine/src/draft.ts — the sync streaming section draft loop.

The LLM heart of the run pipeline: it builds the two-message request (system +
section user prompt from engine/prompts.py), streams the completion, assembles
tool-call fragments by index, dispatches ask_user/raise_flag through the
callbacks, retries once on a length cutoff, and parses the accumulated text into
dialect blocks. TS wins on every statement.

The request payload (model, messages, tools, sampling params) is field-for-field
identical to the TS ``create(...)`` object literal — a later task byte-checks it.

Runtime shapes are plain dicts with camelCase keys. ``cb`` is any object exposing
``on_delta(text)``, ``on_question(q)``, ``on_flag(f)`` (mirror DraftCallbacks).
"""

import json

from runoff_api.core.dialect import parse_section_text
from runoff_api.engine.prompts import MODEL, section_user_prompt, system_prompt

_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "ask_user",
            "description": (
                "Ask the user a blocking-with-fallback question when the source data or its "
                "business framing is genuinely ambiguous. Never ask about report mechanics (the "
                "dialect, citation markers, locator grammar) — the user never sees those; resolve "
                "them yourself and raise_flag if precision suffers. Continue drafting using the "
                "fallback unless an answer arrives."
            ),
            "strict": True,
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {"type": "string"},
                    "options": {"type": "array", "items": {"type": "string"}},
                    "fallback": {"type": "string"},
                    "deadlineSection": {"type": "string"},
                },
                "required": ["question", "options", "fallback", "deadlineSection"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "raise_flag",
            "description": (
                "Flag a passage that needs the user's judgment before the report can be released. "
                "Does not stop drafting."
            ),
            "strict": True,
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {"type": "string"},
                    "options": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["question", "options"],
                "additionalProperties": False,
            },
        },
    },
]


class RefusalError(Exception):
    """Thrown when the model refuses to draft a section. The orchestrator catches
    this per-section (emitting ``section_failed``) so one refusal does not fail the
    whole run; any other error propagates and fails the run.
    """

    def __init__(self, message: str = "model refused to draft this section"):
        super().__init__(message)
        self.name = "RefusalError"


def draft_section(
    *,
    client,
    content: dict,
    section: dict,
    data_block: str,
    completed: list[dict],
    steers: list[str],
    answers: list[dict],
    retry_feedback: str | None = None,
    previous_section_text: str | None = None,
    memories: list[dict] | None = None,
    cb,
) -> dict:
    messages: list[dict] = [
        {"role": "system", "content": system_prompt(content, memories)},
        {
            "role": "user",
            "content": section_user_prompt(
                section=section,
                dataBlock=data_block,
                completed=completed,
                steers=steers,
                answers=answers,
                retryFeedback=retry_feedback,
                previousSectionText=previous_section_text,
            ),
        },
    ]
    raw = ""
    max_tokens = 16000
    length_retried = False

    for _iter in range(6):
        stream = client.chat.completions.create(
            model=MODEL,
            stream=True,
            messages=messages,
            tools=_TOOLS,
            max_completion_tokens=max_tokens,
        )

        turn_text = ""
        refusal_text = ""
        finish_reason = None
        tool_calls: dict[int, dict] = {}

        for chunk in stream:
            choices = getattr(chunk, "choices", None)
            choice = choices[0] if choices else None
            if not choice:
                continue
            delta = getattr(choice, "delta", None)

            content_delta = getattr(delta, "content", None)
            if isinstance(content_delta, str) and content_delta:
                turn_text += content_delta
                cb.on_delta(content_delta)
            refusal = getattr(delta, "refusal", None)
            if isinstance(refusal, str) and refusal:
                refusal_text += refusal
            deltas_tool_calls = getattr(delta, "tool_calls", None)
            if isinstance(deltas_tool_calls, list):
                for tc in deltas_tool_calls:
                    idx = getattr(tc, "index", None)
                    if idx is None:
                        idx = 0
                    acc = tool_calls.get(idx)
                    if acc is None:
                        acc = {"id": "", "name": "", "arguments": ""}
                        tool_calls[idx] = acc
                    if getattr(tc, "id", None):
                        acc["id"] = tc.id
                    fn = getattr(tc, "function", None)
                    if fn is not None:
                        if getattr(fn, "name", None):
                            acc["name"] = fn.name
                        if getattr(fn, "arguments", None):
                            acc["arguments"] += fn.arguments
            if getattr(choice, "finish_reason", None):
                finish_reason = choice.finish_reason

        raw = turn_text

        if refusal_text:
            raise RefusalError()

        if finish_reason == "tool_calls":
            results: list[dict] = []
            for call in tool_calls.values():
                if not call["name"]:
                    continue
                # Guard the tool-argument parse: one malformed payload must not throw and
                # sink the whole run. Skip the callback and tell the model to continue.
                try:
                    parsed = json.loads(call["arguments"] or "{}")
                except Exception:  # noqa: BLE001 — mirrors the TS catch-all
                    results.append({
                        "role": "tool",
                        "tool_call_id": call["id"],
                        "content": "Invalid tool arguments — ignored. Continue drafting.",
                    })
                    continue
                if call["name"] == "ask_user":
                    cb.on_question(parsed)
                    tool_content = (
                        "The user will answer asynchronously. Proceed now using your stated "
                        "fallback; an answer may be injected into later sections."
                    )
                else:
                    cb.on_flag(parsed)
                    tool_content = "Flag recorded for the user's review. Continue drafting."
                results.append({"role": "tool", "tool_call_id": call["id"], "content": tool_content})
            messages.append({
                "role": "assistant",
                "content": turn_text or None,
                "tool_calls": [
                    {
                        "id": c["id"],
                        "type": "function",
                        "function": {"name": c["name"], "arguments": c["arguments"]},
                    }
                    for c in tool_calls.values()
                    if c["name"]
                ],
            })
            for r in results:
                messages.append(r)
            continue

        # The model hit the token ceiling mid-draft. Retry the same turn once with a
        # larger budget; if it truncates again, accept the truncated text and let the
        # orchestrator proceed normally rather than failing the run.
        if finish_reason == "length" and not length_retried:
            length_retried = True
            max_tokens = 32000
            continue

        break

    return {"raw": raw, "blocks": parse_section_text(raw)}
