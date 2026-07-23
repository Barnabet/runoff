"""Port of packages/engine/src/distill.ts — turn one run's human interventions
into 0-3 durable, generalized memories.

Returns [] (never raises) when there is nothing to learn, the model output is
unparseable, or every candidate duplicates an existing memory — the caller (the
worker, post-completion) must never be affected by distillation failure.

Runtime shapes are plain dicts. ``interactions`` mirrors RunInteractions
(``steers``, ``answers`` = list of {"question","answer"}, ``flagResolutions`` =
list of {"question","resolution"}). Each returned DistilledMemory is
{"body": str, "scope": "blueprint"|"project"}.

The request payload (model, messages, response_format, max_completion_tokens) is
field-for-field identical to the TS ``create(...)`` object literal — a later task
byte-checks it.
"""

import json

from runoff_api.engine.prompts import MODEL

MAX_MEMORIES_PER_RUN = 3
MAX_MEMORY_CHARS = 500


def distill_run(
    *,
    client,
    title: str,
    section_headings: list[str],
    interactions: dict,
    existing: list[dict],
) -> list[dict]:
    steers = interactions["steers"]
    answers = interactions["answers"]
    flag_resolutions = interactions["flagResolutions"]
    if not steers and not answers and not flag_resolutions:
        return []

    lines: list[str] = []
    if steers:
        lines.append("Steers the user sent mid-run:\n" + "\n".join(f"- {s}" for s in steers))
    if answers:
        lines.append(
            "Questions the user answered:\n"
            + "\n".join(f"- Q: {a['question']} A: {a['answer']}" for a in answers)
        )
    if flag_resolutions:
        lines.append(
            "Flags the user resolved:\n"
            + "\n".join(f"- {f['question']} → {f['resolution']}" for f in flag_resolutions)
        )

    try:
        res = client.chat.completions.create(
            model=MODEL,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You distill a report-automation run's human interventions into durable "
                        "standing guidance "
                        f'for future runs of the same blueprint ("{title}", '
                        f'sections: {", ".join(section_headings)}). '
                        'Return JSON {"memories": [{"body": string, "scope": "blueprint"|"project"}]} with '
                        f"0-{MAX_MEMORIES_PER_RUN} entries. Each entry must be a "
                        'generalized preference that will apply to every future run '
                        '(e.g. "Always express spend deltas in '
                        "percentages\"), never a one-off fact about this period's data. "
                        'Each entry is {"body": string, "scope": "blueprint"|"project"} — '
                        'scope "blueprint" for guidance '
                        "about this document's content or structure, \"project\" for guidance "
                        "about the client or its "
                        "data that applies to every document in the project. "
                        'Return {"memories": []} when nothing generalizes.'
                    ),
                },
                {"role": "user", "content": "\n\n".join(lines)},
            ],
            response_format={"type": "json_object"},
            max_completion_tokens=1000,
        )
        choices = getattr(res, "choices", None)
        raw = (choices[0].message.content if choices else None) or ""
    except Exception:  # noqa: BLE001 — mirrors the TS catch-all
        return []

    try:
        parsed = json.loads(raw)
    except Exception:  # noqa: BLE001 — mirrors the TS catch-all
        return []

    memories = parsed.get("memories") if isinstance(parsed, dict) else None
    candidates = (
        [
            m
            for m in memories
            if m
            and isinstance(m, dict)
            and isinstance(m.get("body"), str)
            and len(m["body"].strip()) > 0
            and (m.get("scope") == "blueprint" or m.get("scope") == "project")
        ]
        if isinstance(memories, list)
        else []
    )
    # Dedup on lowercased body regardless of scope (an existing project row still
    # knocks out a blueprint-scoped duplicate).
    seen = {e["body"].strip().lower() for e in existing}
    out: list[dict] = []
    for c in candidates:
        body = c["body"].strip()[:MAX_MEMORY_CHARS]
        key = body.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append({"body": body, "scope": c["scope"]})
        if len(out) >= MAX_MEMORIES_PER_RUN:
            break
    return out
