"""Port of packages/engine/src/prompts.ts.

Prompt strings are byte-identical to the TS template literals; do not "improve"
whitespace, wording, or interpolation order.

Runtime shapes are plain dicts with camelCase keys:
  - BlueprintContent: ``clientName``, ``globalRules``, ...
  - BlueprintSection: ``number``, ``heading``, ``instruction``, ``rules``
  - rule: ``kind``, ``text``, optional ``sql``
  - DocSection (completed): ``heading``, ``blocks``
  - ScopedMemory: ``id``, ``body``, ``scope`` ("blueprint" | "project")
  - answer: ``question``, ``answer``
"""

import os
import re

from runoff_api.core.types.document import blocks_to_plain_text

MODEL = os.environ.get("RUNOFF_MODEL", "gpt-5.6-sol")


def guidance_blocks(memories: list[dict]) -> str:
    """The two standing-guidance blocks — PROJECT then BLUEPRINT — the single source
    of truth for both the drafting system prompt and the copilot system prompt.
    Either block is omitted when its scope has no memories; returns "" for none.
    """
    project = [m for m in memories if m["scope"] == "project"]
    blueprint = [m for m in memories if m["scope"] == "blueprint"]
    project_block = (
        "\n\nStanding guidance for this project (applies to every document in this project — "
        "follow unless blueprint guidance or a section instruction contradicts it):\n"
        + "\n".join(f"- {m['body']}" for m in project)
        if project
        else ""
    )
    blueprint_block = (
        "\n\nStanding guidance for this blueprint (learned from the builder and past runs — "
        "follow unless a section instruction contradicts it):\n"
        + "\n".join(f"- {m['body']}" for m in blueprint)
        if blueprint
        else ""
    )
    return f"{project_block}{blueprint_block}"


def system_prompt(content: dict, memories: list[dict] | None = None) -> str:
    """Global rules + dialect contract. STABLE per blueprint — no timestamps or
    per-section content — so it is byte-identical across every section of a run.
    Per-section content goes in the user turn.
    """
    if memories is None:
        memories = []
    global_rules = (
        "\n\nGlobal rules for this report:\n" + "\n".join(f"- {r}" for r in content["globalRules"])
        if content["globalRules"]
        else ""
    )

    guidance = guidance_blocks(memories)

    return (
        f"You are drafting one section of a formal business report for {content['clientName']}. "
        "Write in the report's dialect exactly as specified below. Ground every claim in the sources bound "
        "to this section; never invent figures."
        "\n\n"
        "Dialect contract: write plain paragraphs separated by blank lines; NO markdown headings/bold/lists; "
        "tables as GitHub markdown tables; every figure sourced from data must be written as "
        "[[numeral|familyId|locator]] — the first field is the exact text the reader sees, so it must be the "
        'actual number (e.g. [[220,500|fam_ab12|sum(fam_ar_transactions.amount)]]), never the word "figure" or any '  # noqa: E501
        "other placeholder; locator is agg(tableName.column) — agg one of sum|avg|min|max|count, tableName one of "  # noqa: E501
        "the warehouse tables shown in this section's data (each belongs to the family you cite) — adding a row "  # noqa: E501
        "filter when the figure covers only matching rows, e.g. sum(fam_ar_transactions.amount where channel=search); "  # noqa: E501
        "for document sources, a short quote reference; only cite familyIds bound to this section."
        "\n\n"
        "Tools: use ask_user only for genuine ambiguity in the data or its business framing — never about "
        "the dialect, citation markers, or locator grammar, which the reader never sees; resolve mechanics "
        "yourself and raise_flag if precision suffers. Use raise_flag for judgment calls the rules mark as "
        f"needing review.{global_rules}{guidance}"
    )


def section_user_prompt(
    section: dict,
    dataBlock: str,
    completed: list[dict],
    steers: list[str],
    answers: list[dict],
    retryFeedback: str | None = None,
    previousSectionText: str | None = None,
) -> str:
    """Per-section user turn: heading + instruction, the section's data block (schema
    lines and baked-query results for warehouse families, document text for
    document families), the plain text of completed sections (continuity),
    numbered steers, answered questions, and an optional retry-feedback block.
    """
    parts: list[str] = [
        f"Section {section['number']}: {section['heading']}",
        f"Instruction: {section['instruction']}",
        f"\nSources bound to this section:\n{dataBlock}",
    ]

    if section["rules"]:
        lines = []
        for r in section["rules"]:
            base = f"- [{r['kind']}] {r['text']}"
            if r["kind"] == "assert" and r.get("sql"):
                collapsed = re.sub(r"\s*\n\s*", " ", r["sql"]).strip()
                lines.append(f"{base} (sql: {collapsed})")
            else:
                lines.append(base)
        parts.append(
            "\nRules for this section:\n" + "\n".join(lines) + "\n"
            "(assert rules are verified deterministically after drafting; style rules shape your "
            "writing; judgment rules should prompt raise_flag when triggered.)"
        )

    if completed:
        prior = "\n\n".join(f"{s['heading']}\n{blocks_to_plain_text(s['blocks'])}" for s in completed)
        parts.append(f"\nSections already written (for continuity — do not repeat their content):\n{prior}")

    if previousSectionText:
        parts.append(
            "\nLast run's version of this section (keep its structure and wording where the\n"
            f"underlying data is unchanged; update figures and note material changes):\n{previousSectionText}"
        )

    if steers:
        parts.append("\nUser steers:\n" + "\n".join(f"{i + 1}. {s}" for i, s in enumerate(steers)))

    if answers:
        qa = "\n\n".join(f"Q: {a['question']}\nA: {a['answer']}" for a in answers)
        parts.append(f"\nAnswered questions:\n{qa}")

    if retryFeedback:
        parts.append(
            f"\nA previous draft failed checks: {retryFeedback}\n"
            "Fix and redraft the full section. Cite a figure by wrapping the numeral itself in the "
            "marker — [[220,500|sourceId|locator]] — the visible text must be the actual number, "
            'never the word "figure".'
        )

    parts.append("\nWrite the section now.")
    return "\n".join(parts)
