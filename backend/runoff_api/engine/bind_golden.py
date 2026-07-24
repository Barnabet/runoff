"""Port of packages/engine/src/bindGolden.ts (golden bind LLM engine).

Anchor-addressable document rendering plus the run_sql/submit_inventory tool
loop. Prompt strings are byte-identical to the TS template literals; do not
"improve" whitespace, wording, or interpolation order. Runtime shapes are plain
dicts with camelCase keys (RunDocument, BindingInventory, CatalogFamily).
"""

import json

from pydantic import ValidationError

from runoff_api.core.jsonutil import to_json
from runoff_api.core.types.golden_binding import (
    SubmittedInventory,
    validate_inventory_anchors,
)
from runoff_api.engine.catalog_format import serialize_catalog
from runoff_api.engine.prompts import MODEL

MAX_BIND_ITERATIONS = 16


def render_doc_for_binding(document: dict) -> str:
    """Anchor-addressable rendering: the agent copies these coordinates into items."""
    lines: list[str] = [f"title: {document['title']}"]
    for s in document["sections"]:
        lines.append(f"## section: {s['key']} — {s['heading']}")
        for bi, b in enumerate(s["blocks"]):
            if b["type"] == "paragraph":
                for si, sp in enumerate(b["spans"]):
                    lines.append(f"[b{bi}.s{si}] {to_json(sp['text'][:160])}")
            else:
                lines.append(
                    f"[b{bi}] table ({len(b['columns'])} cols × {len(b['rows'])} rows): "
                    f"{' | '.join(b['columns'])}"
                )
                for r in b["rows"][:12]:
                    lines.append(
                        "  " + " | ".join("".join(sp["text"] for sp in c) for c in r["cells"])
                    )
                if len(b["rows"]) > 12:
                    lines.append(f"  … {len(b['rows']) - 12} more rows")
    return "\n".join(lines)


def _render_siblings(siblings: list[dict]) -> str:
    out: list[str] = []
    for s in siblings[:3]:
        bound = [
            i for i in s["inventory"]["items"]
            if (i.get("binding") or {}).get("status") == "bound"
        ]
        if bound:
            out.append(f"period {s['period'] if s['period'] is not None else 'unknown'}:")
            for i in bound:
                out.append(f"  {i['id']}: \"{i['raw']}\" ← {i['binding']['familyId']}: {i['binding']['sql']}")
    return "\n".join(out)


def _fn(name: str, description: str, properties: dict) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "strict": False,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": list(properties.keys()),
                "additionalProperties": False,
            },
        },
    }


TOOLS = [
    _fn(
        "run_sql",
        "Run one read-only SQL SELECT against the project's warehouse. :period binds to THIS GOLDEN's period. Results capped at 200 rows.",  # noqa: E501
        {"sql": {"type": "string"}},
    ),
    _fn(
        "submit_inventory",
        "Submit the final binding inventory. Calling this with a valid inventory ends the task.",
        {
            "version": {"type": "number"},
            "items": {"type": "array", "items": {"type": "object"}},
        },
    ),
]


def bind_golden(
    *,
    client,
    catalog: list[dict],
    run_sql,
    document: dict,
    period: str | None,
    siblings: list[dict],
    prior_inventory: dict | None = None,
    feedback: str | None = None,
) -> dict | None:
    sys = [
        "You inventory a golden report's data-driven content and bind it to warehouse data.",
        "Inventory EVERY narration-driving value (figures, counts, amounts, percentages, data-derived dates — not styling numbers) and EVERY table.",  # noqa: E501
        "For each item propose {familyId, sql} that reproduces it, or binding: null with a reason.",
        "Use :period in SQL for periodic tables so bindings transfer across periods. Probe with run_sql BEFORE submitting.",  # noqa: E501
        'Item shape: {id (snake_case, stable), kind: "value"|"table", anchor: {sectionKey, blockIndex, spanIndex|null}, raw, parsed, binding, reason}.',  # noqa: E501
        "Anchors come from the bracketed coordinates in the document below: [b0.s1] → blockIndex 0, spanIndex 1; [b1] table → blockIndex 1, spanIndex null.",  # noqa: E501
        f"\nData catalog:\n{serialize_catalog(catalog)}",
        f"\nGolden period: {period if period is not None else 'unknown'}",
        f"\nDocument:\n{render_doc_for_binding(document)}",
    ]
    sib = _render_siblings(siblings)
    if sib:
        sys.append(
            f"\nThese are verified binding patterns from other periods of the same report family. Try these first: the same logical value binds with the same SQL at a different :period. Reuse their item ids for matching items.\n{sib}"  # noqa: E501
        )
    if prior_inventory:
        sys.append(
            f"\nPrior inventory (amend, do not restart — keep existing item ids and bound SQL for items the feedback does not dispute):\n{to_json(prior_inventory)}"  # noqa: E501
        )
    if feedback:
        sys.append(f"\nUser feedback: {feedback}")

    messages: list[dict] = [
        {"role": "system", "content": "\n".join(sys)},
        {"role": "user", "content": "Build and submit the binding inventory."},
    ]
    nudged = False
    iteration = 0
    while True:
        try:
            res = client.chat.completions.create(
                model=MODEL, messages=messages, tools=TOOLS, max_completion_tokens=6000
            )
        except Exception:  # noqa: BLE001 — mirrors the TS catch-all → None
            return None
        choices = getattr(res, "choices", None)
        choice = choices[0] if choices else None
        calls = getattr(getattr(choice, "message", None), "tool_calls", None) or []
        if getattr(choice, "finish_reason", None) != "tool_calls" or len(calls) == 0:
            return None  # finished without submitting
        content = getattr(choice.message, "content", None)
        messages.append(
            {
                "role": "assistant",
                "content": content if content is not None else None,
                "tool_calls": [
                    {
                        "id": c.id,
                        "type": "function",
                        "function": {"name": c.function.name, "arguments": c.function.arguments},
                    }
                    for c in calls
                ],
            }
        )
        over_budget = iteration >= MAX_BIND_ITERATIONS
        for call in calls:
            name = call.function.name
            if name == "submit_inventory":
                try:
                    args = json.loads(call.function.arguments)
                    inv = SubmittedInventory.model_validate(args).model_dump(by_alias=True)
                    validate_inventory_anchors(inv, document)
                    return inv  # valid submit ends the loop; remaining tool results are moot
                except ValidationError as e:
                    # pydantic ValidationError is the zod-v3 ZodError analogue: flatten
                    # issues to `path: message` pairs so the agent gets an actionable
                    # detail instead of a bare "[".
                    detail = "; ".join(
                        f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}"
                        for err in e.errors()
                    )
                    result = f"Tool error: invalid inventory: {detail[:300]}"
                except Exception as e:  # noqa: BLE001 — anchor / parse errors keep first-line handling
                    detail = str(e).split("\n")[0]
                    result = f"Tool error: invalid inventory: {detail[:300]}"
            elif name == "run_sql" and not over_budget:
                try:
                    result = run_sql(json.loads(call.function.arguments)["sql"])
                except Exception as e:  # noqa: BLE001
                    result = f"Tool error: sql: {str(e)}"
            else:
                result = "Tool budget exhausted. Call submit_inventory with your best inventory now."
            messages.append({"role": "tool", "tool_call_id": call.id, "content": result})
        if nudged:
            return None  # post-nudge round processed submit_inventory; no valid submit arrived
        if over_budget:
            nudged = True
        iteration += 1
