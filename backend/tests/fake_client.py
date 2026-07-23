"""Sync port of packages/engine/test/fakeClient.ts.

A stand-in for the ``openai`` client, compatible enough for the draft and copilot
engines. ``chat.completions.create(**params)`` branches on ``params["stream"]``:

  - streaming (draft): returns a plain iterator of chat-completion chunks built
    from the FakeTurn parts — text becomes word-split ``delta.content`` chunks; a
    ``toolUse`` becomes several ``delta.tool_calls`` chunks (its ``arguments``
    string is split across fragments, with ``id`` + ``function.name`` carrying a
    value ONLY on the first fragment — exactly as OpenAI streams them) plus a
    final ``finish_reason == "tool_calls"``; a ``refusal`` stop becomes
    ``delta.refusal``; otherwise the final ``finish_reason`` is ``"stop"``.
  - non-streaming (copilot): returns ``{ choices: [{ message }] }`` with the
    concatenated text as ``content`` (and ``refusal`` when the turn refused).

Chunks/responses are built as ``types.SimpleNamespace`` trees so that attribute
access mirrors the openai SDK: fields the SDK always exposes (``content``,
``refusal``, ``tool_calls`` on a delta; ``id``/``type``/``function.name`` on a
tool-call) are present as ``None`` when they carry no value, since Python
attribute access — unlike JS property access — cannot return ``undefined``.

FakeTurn is a plain dict mirroring the TS interface:
  - ``text``: str streamed as one content delta per word
  - ``toolUse``: {``name``, ``input``, ``rawArguments``} — ``input`` is
    JSON-stringified into the streamed arguments; ``rawArguments`` overrides it
    verbatim so tests can inject a malformed argument payload
  - ``stopReason``: "end_turn" | "tool_use" | "max_tokens" | "refusal"
"""

import json
from types import SimpleNamespace


def make_fake_client(script: list[list[dict]]):
    state = {"call": 0}

    def create(**params):
        turns = script[min(state["call"], len(script) - 1)]
        state["call"] += 1
        return _stream_response(turns) if params.get("stream") else _blocking_response(turns)

    return SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))


def _chunk(delta: SimpleNamespace, finish_reason):
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason=finish_reason)])


def _stream_response(turns: list[dict]):
    tool_index = 0
    finish = "stop"
    refused = False

    for t in turns:
        text = t.get("text")
        if text:
            for w in _split_words(text):
                yield _chunk(SimpleNamespace(content=w, tool_calls=None, refusal=None), None)

        tool_use = t.get("toolUse")
        if tool_use:
            idx = tool_index
            tool_index += 1
            raw = tool_use.get("rawArguments")
            args_str = raw if raw is not None else json.dumps(tool_use.get("input"), separators=(",", ":"))
            fragments = _chunk_string(args_str)
            # First fragment carries id + name; later fragments carry only more
            # argument text keyed by the same index — the OpenAI streaming shape.
            first_call = SimpleNamespace(
                index=idx,
                id=f"call_{idx}",
                type="function",
                function=SimpleNamespace(name=tool_use["name"], arguments=fragments[0]),
            )
            yield _chunk(
                SimpleNamespace(content=None, refusal=None, tool_calls=[first_call]),
                None,
            )
            for i in range(1, len(fragments)):
                cont_call = SimpleNamespace(
                    index=idx,
                    id=None,
                    type=None,
                    function=SimpleNamespace(name=None, arguments=fragments[i]),
                )
                yield _chunk(
                    SimpleNamespace(content=None, refusal=None, tool_calls=[cont_call]),
                    None,
                )
            finish = "tool_calls"

        if t.get("stopReason") == "refusal":
            yield _chunk(
                SimpleNamespace(content=None, tool_calls=None, refusal="The model refused."),
                None,
            )
            refused = True
        if t.get("stopReason") == "max_tokens":
            finish = "length"

    yield _chunk(
        SimpleNamespace(content=None, tool_calls=None, refusal=None),
        "stop" if refused else finish,
    )


def _split_words(s: str) -> list[str]:
    """Split after each space, keeping the trailing space on the preceding word
    (mirrors the JS ``split(/(?<= )/)`` lookbehind split)."""
    out = []
    start = 0
    for i, ch in enumerate(s):
        if ch == " ":
            out.append(s[start : i + 1])
            start = i + 1
    out.append(s[start:])
    return out


def _chunk_string(s: str, size: int = 8) -> list[str]:
    """Split a string into fixed-size fragments (at least one) to exercise accumulation."""
    if len(s) <= size:
        return [s]
    return [s[i : i + size] for i in range(0, len(s), size)]


def _blocking_response(turns: list[dict]):
    content = "".join(t["text"] for t in turns if t.get("text"))
    refused = any(t.get("stopReason") == "refusal" for t in turns)
    message = SimpleNamespace(
        content=content or None,
        refusal="The model refused." if refused else None,
    )
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])
