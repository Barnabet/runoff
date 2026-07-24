"""Port of packages/engine/src/unifyGolden.ts — convert one report file into
Runoff's universal document JSON via the LLM.

``unify_golden_report`` runs at most 2 structural attempts; a single degenerate
success (zero sections / every block empty) buys one extra retry that does NOT
consume a structural attempt. Any client-side exception → None. Unparseable or
schema-invalid output → a retry message and another structural attempt.

Runtime shapes are plain dicts: the validated document is returned as a dict
(``model_dump(by_alias=True, exclude_unset=True)`` — the zod-round-trip rule from
``core.types.base``).

The request payload (model, messages, response_format, max_completion_tokens) is
field-for-field identical to the TS ``create(...)`` object literal — a later task
byte-checks it.
"""

import json

from runoff_api.core.types.document import RunDocument
from runoff_api.core.types.sources import PERIOD_REGEX
from runoff_api.engine.prompts import MODEL


def cap_exemplar_text(text: str) -> str:
    """Head+tail sample long exemplars: first 20k + last 4k of a >24k text (spec §3)."""
    if len(text) <= 24000:
        return text
    return f"{text[:20000]}\n…\n{text[-4000:]}"


def is_unsupported_exemplar_mime(mime: str) -> bool:
    """Reports, not data: tabular exemplars are not unified (spec §3)."""
    return mime in (
        "text/csv",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


UNIFY_CONTRACT = (
    "You convert a report file into Runoff's universal document JSON.\n"
    'Return ONLY a JSON object: {"document": {...}, "period": "2026-Q1" | null}.\n'
    'document = {"title","eyebrow","dateline","sections":[{"key","heading","blocks":[...]}]}.\n'
    'Blocks: {"type":"paragraph","spans":[{"text":"..."}]} or '
    '{"type":"table","columns":[...],"rows":[{"cells":[[{"text":"..."}], ...]}]}.\n'
    "Rules:\n"
    "- Preserve the original wording VERBATIM wherever possible. Restructure, never paraphrase.\n"
    "- Section keys: lowercase snake_case (^[a-z][a-z0-9_]*$), unique.\n"
    "- Put each figure that comes from data in its own span within its paragraph "
    '(e.g. "reached ", "$4.2M", " this quarter" as three spans) so figures are individually addressable.\n'
    "- Tabular content in the report becomes table blocks, one row per data row "
    "(keep total rows if the report shows them).\n"
    "- No citations: spans carry text only.\n"
    '- period: the period this report covers, as "YYYY-Q<n>", "YYYY-MM", or "YYYY" — null if unclear.'
)


def _degenerate_reason(document: RunDocument) -> str | None:
    if len(document.sections) == 0:
        return "the document has zero sections"
    has_content = any(
        any(
            any(span.text.strip() for span in block.spans)
            if block.type == "paragraph"
            else len(block.rows) > 0
            for block in section.blocks
        )
        for section in document.sections
    )
    return None if has_content else "every block is empty"


def unify_golden_report(*, client, filename: str, text: str) -> dict | None:
    messages: list[dict] = [
        {"role": "system", "content": UNIFY_CONTRACT},
        {"role": "user", "content": f"File: {filename}\n\n{cap_exemplar_text(text)}"},
    ]
    # 2 structural attempts + at most 1 degeneracy retry (spec §3): a degenerate
    # success appends the reason and retries WITHOUT consuming an attempt, exactly
    # once; an unparseable/invalid output consumes an attempt.
    degenerate_retried = False
    attempt = 0
    while attempt < 2:
        try:
            res = client.chat.completions.create(
                model=MODEL,
                messages=messages,
                response_format={"type": "json_object"},
                max_completion_tokens=4000,
            )
            choices = getattr(res, "choices", None)
            content = (choices[0].message.content if choices else None) or ""
        except Exception:  # noqa: BLE001 — mirrors the TS bare `catch { return null; }`
            return None
        try:
            parsed = json.loads(content)
            document = RunDocument.model_validate(parsed.get("document"))
            reason = _degenerate_reason(document)
            if reason and not degenerate_retried:
                degenerate_retried = True
                messages.append(
                    {
                        "role": "user",
                        "content": f"That document is degenerate: {reason}. Produce the full document.",
                    }
                )
                continue  # degeneracy retry does not consume a structural attempt
            if reason:
                return None
            raw_period = parsed.get("period")
            period = (
                raw_period
                if isinstance(raw_period, str)
                and any(pat.fullmatch(raw_period) for pat in PERIOD_REGEX.values())
                else None
            )
            return {
                "document": document.model_dump(by_alias=True, exclude_unset=True),
                "period": period,
            }
        except Exception:  # noqa: BLE001 — JSON.parse throw + zod parse failure both retry
            messages.append(
                {
                    "role": "user",
                    "content": "That was not valid document JSON. Return exactly the specified JSON object.",
                }
            )
            attempt += 1
            continue
    return None
