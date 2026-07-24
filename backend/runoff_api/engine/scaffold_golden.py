"""Port of packages/engine/src/scaffoldGolden.ts —
`serializeProse`, `buildScaffoldDigest`, `renderScaffoldDigest`.

Deterministic scaffold-digest engine (no LLM): groups an inventory's bound /
mismatch bindings into per-section queries and turns the rest into warnings,
then renders the digest text an agent lifts SQL from verbatim.

Everything flows as plain dicts with camelCase keys (the TS runtime shape).
"""

from runoff_api.services.golden_binding import _js_string, boundness_line

PROSE_CAP = 1500


def serialize_prose(blocks: list[dict]) -> str:
    """Spec §2.3: spans joined with a space; tables header-only; blocks joined with \\n; capped."""
    text = "\n".join(
        " ".join(sp["text"] for sp in b["spans"])
        if b["type"] == "paragraph"
        else f"[table {len(b['columns'])} cols × {len(b['rows'])} rows: {' | '.join(b['columns'])}]"
        for b in blocks
    )
    return f"{text[:PROSE_CAP]}…" if len(text) > PROSE_CAP else text


def build_scaffold_digest(g: dict) -> dict:
    """Spec §2.2: one digest section per document section (document order);
    bound/mismatch SQL lifted, the rest becomes warnings.
    """
    by_section: dict[str, list[dict]] = {}
    for it in g["inventory"]["items"]:
        by_section.setdefault(it["anchor"]["sectionKey"], []).append(it)
    sections = []
    for s in g["document"]["sections"]:
        queries: list[dict] = []
        warnings: list[str] = []
        used: set[str] = set()
        for it in by_section.get(s["key"], []):
            b = it["binding"]
            if b and b["status"] in ("bound", "mismatch"):
                name = it["id"]
                i = 2
                while name in used:
                    name = f"{it['id']}_{i}"
                    i += 1
                used.add(name)
                queries.append(
                    {
                        "name": name,
                        "sql": b["sql"],
                        "provenance": "verified" if b["status"] == "bound" else "verified-mismatch",
                    }
                )
                if b["status"] == "mismatch":
                    warnings.append(
                        f'"{it["raw"]}" mismatches current data '
                        f'(golden says {it["raw"]} · data {_js_string(b["verifiedValue"])})'
                    )
            else:
                reason = it["reason"] if it.get("reason") is not None else "unbound"
                warnings.append(f'"{it["raw"]}" has no data backing ({reason})')
        if len(queries) == 0:
            warnings.append("no verified queries in this section")
        sections.append(
            {
                "key": s["key"],
                "heading": s["heading"],
                "prose": serialize_prose(s["blocks"]),
                "queries": queries,
                "warnings": warnings,
            }
        )
    return {
        "goldenId": g["id"],
        "label": g["label"],
        "period": g["period"],
        "boundness": boundness_line(g["inventory"]),
        "sections": sections,
    }


def render_scaffold_digest(d: dict) -> str:
    """Spec §2.4. SQL is NOT truncated here — the agent lifts it verbatim."""
    period = d["period"] if d["period"] is not None else "none"
    lines = [f'SCAFFOLD DIGEST — golden "{d["label"]}" (period {period}, {d["boundness"]})']
    for s in d["sections"]:
        lines.extend(["", f'## section: {s["key"]} — {s["heading"]}', "prose:", s["prose"]])
        if s["queries"]:
            lines.append("queries:")
            for q in s["queries"]:
                lines.append(f'  {q["name"]}: {q["sql"]}  [{q["provenance"]}]')
        if s["warnings"]:
            lines.append("warnings:")
            for w in s["warnings"]:
                lines.append(f"  - {w}")
    return "\n".join(lines)
