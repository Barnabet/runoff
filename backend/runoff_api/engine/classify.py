"""Port of packages/engine/src/classify.ts — propose where one uploaded file
belongs in the project's family/period taxonomy.

One chat call, JSON-object response. Returns None on ANY failure — API error,
unparseable output, schema mismatch, or a semantically invalid proposal — the
caller treats None as "no proposal; user files manually".

Families flow as plain dicts ``{"key","label","kind","granularity"}``
(``granularity`` is None for constant families). The proposal returns as a plain
dict (camelCase keys) carrying only the fields the model supplied.

The request payload (model, messages, response_format, max_completion_tokens) is
field-for-field identical to the TS ``create(...)`` object literal — a later task
byte-checks it.
"""

import json

from runoff_api.core.types.sources import PERIOD_REGEX, ClassifyProposal
from runoff_api.engine.prompts import MODEL


def classify_source(*, client, filename: str, content_sample: str, families: list[dict]) -> dict | None:
    family_lines = (
        "\n".join(
            f'- {f["key"]} ("{f["label"]}"): {f["kind"]}'
            + (f', one file per {f["granularity"]}' if f.get("granularity") else "")
            for f in families
        )
        if families
        else "(none yet)"
    )

    try:
        res = client.chat.completions.create(
            model=MODEL,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You file uploaded data files into a project's source taxonomy: families of one kind "
                        '("periodic" = one file per period, or "constant" = reference material with no '
                        "period), "
                        "each periodic family having ONE fixed granularity. Existing families:\n"
                        f"{family_lines}"
                        "\n\n"
                        "Strongly prefer filing into an existing family. Propose a new family only when "
                        "nothing fits; "
                        'propose "constant" only for clearly non-periodic reference material. Periods MUST '
                        "be canonical: "
                        'quarter "2026-Q1", month "2026-06", year "2026" — matching the family\'s '
                        "granularity; null for constant. "
                        'Return JSON {"familyKey": string, "newFamily"?: {"key","label","kind",'
                        '"granularity"|null}, '
                        '"period": string|null, "confidence": "high"|"medium"|"low"}. New-family keys are '
                        "short snake_case slugs."
                    ),
                },
                {
                    "role": "user",
                    "content": f"Filename: {filename}\n\nContent sample:\n{content_sample[:2000]}",
                },
            ],
            response_format={"type": "json_object"},
            max_completion_tokens=500,
        )
        choices = getattr(res, "choices", None)
        raw = (choices[0].message.content if choices else None) or ""
    except Exception:  # noqa: BLE001 — mirrors the TS catch-all
        return None

    try:
        obj = json.loads(raw)
        parsed = ClassifyProposal.model_validate(obj)
    except Exception:  # noqa: BLE001 — JSON.parse throw + safeParse failure both → None
        return None

    def ok() -> dict:
        return parsed.model_dump(by_alias=True, exclude_unset=True)

    existing = next((f for f in families if f["key"] == obj.get("familyKey")), None)
    if existing:
        if obj.get("newFamily"):
            return None
        if existing["kind"] == "constant":
            return ok() if obj.get("period") is None else None
        return (
            ok()
            if obj.get("period") is not None and PERIOD_REGEX[existing["granularity"]].search(obj["period"])
            else None
        )
    nf = obj.get("newFamily")
    if not nf or nf.get("key") != obj.get("familyKey"):
        return None
    if nf.get("kind") == "constant":
        return ok() if nf.get("granularity") is None and obj.get("period") is None else None
    if nf.get("granularity") is None:
        return None
    return (
        ok()
        if obj.get("period") is not None and PERIOD_REGEX[nf["granularity"]].search(obj["period"])
        else None
    )
