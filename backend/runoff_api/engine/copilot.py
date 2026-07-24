"""Copilot engine — statement-for-statement port of packages/engine/src/copilot.ts.

This task covers the non-turn surface: the tool schemas (``TOOLS``), the system
prompt, the activity labels, and every tool executor (``execute_tool`` and its
helpers). The streaming turn loop (``copilot_turn``) is a separate task and is
NOT implemented here.

Runtime shapes are plain dicts with camelCase keys, matching the TS interfaces:

  - BlueprintContent / BlueprintSection: ``clientName``, ``globalRules``,
    ``familyIds``, ``fixedText`` ...
  - CopilotEvent (emitted through ``io.emit``): ``{"type": "edit", "op": EditOp}``,
    ``{"type": "memory_saved", "memoryId", "body"}`` ...
  - CopilotContext (the Task 8 dict from services.queries.build_copilot_context):
    data keys ``families`` / ``defaultFiles`` / ``periodFiles`` / ``catalog`` and
    callables ``runSql(sql)`` / ``listRuns()`` / ``getRunSection(run_id, key)`` /
    ``listGoldens()`` / ``getGolden(id)`` / ``scaffoldDigest(golden_id)`` /
    ``saveMemory(body, scope)``.
  - FamilyInfo / CatalogFamily: as built by build_copilot_context / build_warehouse_catalog.

``execute_tool`` takes a ``state`` dict mirroring the TS ``ToolState``:
``{"draft", "default_pack", "period_pack", "ctx", "io", "actions"}``. The
``default_pack`` / ``period_pack`` are SourcePack dicts from R2 build_source_pack;
the period pack is keyed ``{familyId}:{period}`` (the turn builds it that way).
"""

from __future__ import annotations

import re
from typing import Any

from pydantic import ValidationError

from ..core.jsonutil import to_json
from ..core.types.blueprint import BlueprintContent
from .catalog_format import serialize_catalog
from .prompts import guidance_blocks
from .source_pack import pack_for_prompt

MAX_ITERATIONS = 12
# Must stay >= core's SQL serialization cap (formatSqlResult, 10_000 chars) plus
# its contractual "… truncated at N of M rows" line, so a fully-capped run_sql
# result always passes through this clamp intact — otherwise the clamp would clip
# mid-row with no marker and drop the truncation line the model relies on.
MAX_TOOL_RESULT_CHARS = 10_100


def _fn(name: str, description: str, properties: dict) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "strict": True,
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
        "edit_section",
        "Patch fields of one existing section of the blueprint draft. Only include fields you are changing.",
        {
            "key": {"type": "string"},
            "patch": {
                "type": "object",
                "properties": {
                    "heading": {"type": ["string", "null"]},
                    "mode": {"type": ["string", "null"], "enum": ["fixed", "auto", "review", None]},
                    "instruction": {"type": ["string", "null"]},
                    "fixedText": {"type": ["string", "null"]},
                    "familyIds": {"type": ["array", "null"], "items": {"type": "string"}},
                    "rules": {
                        "type": ["array", "null"],
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": {"type": "string", "enum": ["assert", "style", "judgment"]},
                                "text": {"type": "string"},
                                "sql": {"type": ["string", "null"]},
                                "op": {"type": ["string", "null"], "enum": ["==", "<=", ">=", "<", ">", None]},  # noqa: E501
                                "value": {"type": ["number", "null"]},
                                "withinPct": {"type": ["number", "null"]},
                            },
                            "required": ["kind", "text", "sql", "op", "value", "withinPct"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["heading", "mode", "instruction", "fixedText", "familyIds", "rules"],
                "additionalProperties": False,
            },
        },
    ),
    _fn(
        "add_section",
        "Insert a new section after the section named by afterKey (null appends at the end). Numbers are reassigned automatically.",  # noqa: E501
        {
            "afterKey": {"type": ["string", "null"]},
            "section": {
                "type": "object",
                "properties": {
                    "key": {"type": "string"},
                    "heading": {"type": "string"},
                    "mode": {"type": "string", "enum": ["fixed", "auto", "review"]},
                    "instruction": {"type": "string"},
                    "fixedText": {"type": ["string", "null"]},
                    "familyIds": {"type": "array", "items": {"type": "string"}},
                    "queries": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "sql": {"type": "string"},
                                "description": {"type": ["string", "null"]},
                            },
                            "required": ["name", "sql", "description"],
                            "additionalProperties": False,
                        },
                    },
                    "rules": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "kind": {"type": "string", "enum": ["assert", "style", "judgment"]},
                                "text": {"type": "string"},
                                "sql": {"type": ["string", "null"]},
                                "op": {"type": ["string", "null"], "enum": ["==", "<=", ">=", "<", ">", None]},  # noqa: E501
                                "value": {"type": ["number", "null"]},
                                "withinPct": {"type": ["number", "null"]},
                            },
                            "required": ["kind", "text", "sql", "op", "value", "withinPct"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["key", "heading", "mode", "instruction", "fixedText", "familyIds", "queries", "rules"],  # noqa: E501
                "additionalProperties": False,
            },
        },
    ),
    _fn("remove_section", "Remove one section from the draft.", {"key": {"type": "string"}}),
    _fn(
        "update_masthead",
        "Patch the report masthead. Only include fields you are changing.",
        {
            "patch": {
                "type": "object",
                "properties": {
                    "title": {"type": ["string", "null"]},
                    "clientName": {"type": ["string", "null"]},
                    "eyebrow": {"type": ["string", "null"]},
                    "dateline": {"type": ["string", "null"]},
                },
                "required": ["title", "clientName", "eyebrow", "dateline"],
                "additionalProperties": False,
            },
        },
    ),
    _fn(
        "update_global_rules",
        "Replace the blueprint's global rules list.",
        {"rules": {"type": "array", "items": {"type": "string"}}},
    ),
    _fn(
        "update_section_queries",
        "Replace one section's baked data queries (name + read-only SELECT). The drafting model sees each query's result verbatim at run time; parameterize periodic tables with :period. Baked queries replace the default 40-row preview for the tables they mention.",  # noqa: E501
        {
            "sectionKey": {"type": "string"},
            "queries": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "sql": {"type": "string"},
                        "description": {"type": ["string", "null"]},
                    },
                    "required": ["name", "sql", "description"],
                    "additionalProperties": False,
                },
            },
        },
    ),
    _fn(
        "query_sources",
        "Inspect the data families in this project. Without familyId: the family tree — one line per family with its kind, granularity, and filed periods. With familyId: columns and first rows of that family's latest file (or its constant reference file). With familyId and period: that specific period's file.",  # noqa: E501
        {
            "familyId": {"type": ["string", "null"]},
            "period": {"type": ["string", "null"]},
        },
    ),
    _fn(
        "run_sql",
        "Run one read-only SQL SELECT against this project's ingested data (SQLite). Table and column names are in the data catalog; periodic tables have a _period column (e.g. WHERE _period = '2026-Q1'). Results are capped at 200 rows. You may reference :period — it binds to the project's latest filed period.",  # noqa: E501
        {"sql": {"type": "string"}},
    ),
    _fn("list_runs", "List this blueprint's most recent runs with their stats.", {}),
    _fn(
        "get_run_section",
        "Fetch one section of a past run: its text plus that section's check failures, retries, steers, answers, and flags.",  # noqa: E501
        {"runId": {"type": "string"}, "key": {"type": "string"}},
    ),
    _fn("list_goldens", "List this blueprint's golden examples (starred runs/sections and uploaded exemplars).", {}),  # noqa: E501
    _fn("get_golden", "Fetch one golden example's full text.", {"id": {"type": "string"}}),
    _fn(
        "get_golden_scaffold",
        "Fetch a bound golden example's scaffold digest: per-section prose (tone source), verified data queries lifted from its bindings (lift these verbatim into section queries), and warnings for unverified figures. Use when asked to scaffold blueprint sections from a golden.",  # noqa: E501
        {"goldenId": {"type": "string"}},
    ),
    _fn(
        "save_memory",
        'Save one durable, generalized preference. scope "blueprint" = about this document; scope "project" = about the client or its data, true for every document in the project.',  # noqa: E501
        {"body": {"type": "string"}, "scope": {"type": "string", "enum": ["blueprint", "project"]}},
    ),
]


# The builder-copilot system prompt prose. The TS source joins ~18 template-literal
# lines with `\` continuations that produce NO newline — the result is continuous
# prose with single spaces. Each segment below is one such source line (trailing
# space included where the source had one before the backslash); byte-identical.
_SYSTEM_PROMPT_PROSE = (
    "You are the builder copilot for a Runoff blueprint — a template that generates a recurring, "
    "fact-checked business report. You edit the blueprint itself (instructions, rules, structure), never "
    "the report output. Use your tools to inspect the bound data, past runs, and golden examples before "
    "guessing; apply edits directly with the edit tools (the user sees each edit and can revert it); keep "
    "instructions concrete and grounded in the actual source columns. Figures in generated reports are "
    "audited against warehouse-table locators like agg(tableName.column) resolved over the fam_* tables — "
    "prefer assert rules and instructions that reference real columns. Bake per-section data queries with "
    "update_section_queries — the run executes them (with :period bound to the run's period) and drafts from "
    "their results, so keep them small and purposeful. Assert rules are scalar SQL: { sql, op, value } where "
    "sql returns one number (use :period for periodic tables). Test any SQL with run_sql first; run_sql binds "  # noqa: E501
    ":period to the latest filed period. Data is organized into families (one file per period, or "
    "constant reference files); query_sources shows what periods exist. "
    "To scaffold blueprint sections from a golden example, call get_golden_scaffold and build from its digest: "  # noqa: E501
    "add_section per digest section (distill the golden's tone from the prose into the instruction — never paste "  # noqa: E501
    "the prose verbatim), lift [verified] and [verified-mismatch] queries verbatim (same names) via the section's "  # noqa: E501
    "queries, add complementary queries where the narration needs more, and relay the digest's warnings to the user. "  # noqa: E501
    "Prefer one section per edit so the user can steer between them. When the user states a durable "
    "preference, save it with save_memory. Reply concisely in plain prose; never dump raw JSON at the user."
)


def copilot_system_prompt(
    draft: dict, selected_key: str | None, memories: list[dict], catalog: list[dict]
) -> str:
    """Byte-identical port of copilotSystemPrompt. `draft` is embedded via to_json
    (JSON.stringify equivalent); the selected/catalog blocks are conditional."""
    memory_block = guidance_blocks(memories)
    selected = (
        f'\nThe user currently has section "{selected_key}" selected in the editor.'
        if selected_key
        else ""
    )
    catalog_block = (
        f"\n\nData catalog (tables you can query with run_sql):\n{serialize_catalog(catalog)}"
        if catalog
        else ""
    )
    return (
        f"{_SYSTEM_PROMPT_PROSE}{selected}{catalog_block}"
        f"\n\nCurrent draft (JSON):\n{to_json(draft)}{memory_block}"
    )


def _q(v: Any) -> Any:
    """The TS `?? "?"` fallback: None becomes "?", but an empty string stays empty."""
    return v if v is not None else "?"


def activity_label(name: str, args: Any, families: list[dict]) -> str:
    """Human-readable label for a tool call — verbatim port of activityLabel."""
    args = args or {}
    if name == "edit_section":
        return f"editing §{_q(args.get('key'))}"
    if name == "add_section":
        return f'adding section "{_q((args.get("section") or {}).get("heading"))}"'
    if name == "remove_section":
        return f"removing §{_q(args.get('key'))}"
    if name == "update_masthead":
        return "editing masthead"
    if name == "update_global_rules":
        return "editing global rules"
    if name == "update_section_queries":
        return "baking data queries"
    if name == "query_sources":
        if not args.get("familyId"):
            return "listing data families"
        fam = next((f for f in families if f["id"] == args["familyId"]), None)
        key = fam["key"] if fam is not None else args["familyId"]
        suffix = f" @ {args['period']}" if args.get("period") else ""
        return f"reading {key}{suffix}"
    if name == "run_sql":
        return "running SQL"
    if name == "list_runs":
        return "listing recent runs"
    if name == "get_run_section":
        return f"reading run {_q(args.get('runId'))} §{_q(args.get('key'))}"
    if name == "list_goldens":
        return "listing goldens"
    if name == "get_golden":
        return f"reading golden {_q(args.get('id'))}"
    if name == "get_golden_scaffold":
        return f"scaffolding from golden {_q(args.get('goldenId'))}"
    if name == "save_memory":
        return "saving a memory"
    return name


def compact(obj: dict | None) -> dict:
    """Strip nulls the strict schemas force into optional slots."""
    return {k: v for k, v in (obj or {}).items() if v is not None}


def renumber(sections: list[dict]) -> list[dict]:
    return [{**s, "number": i + 1} for i, s in enumerate(sections)]


def family_line(f: dict) -> str:
    """One line per family: `key · kind · granularity · <data status>`."""
    gran = f" · {f['granularity']}" if f["granularity"] else ""
    if f["kind"] == "constant":
        data = "live file ✓" if f["hasLiveFile"] else "no data yet"
    else:
        data = (
            "periods: " + ", ".join(f"{p} ✓" for p in f["filedPeriods"])
            if f["filedPeriods"]
            else "no data yet"
        )
    return f"{f['key']} · {f['kind']}{gran} · {data}"


_QUERY_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")


def execute_tool(name: str, args: dict, state: dict) -> dict:
    """Port of executeTool. Returns ``{"draft": dict, "result": str}``."""
    default_pack = state["default_pack"]
    period_pack = state["period_pack"]
    ctx = state["ctx"]
    io = state["io"]
    actions = state["actions"]
    draft = state["draft"]

    def commit(candidate: dict, op: dict) -> dict:
        """Validate a candidate draft; on success commit it + emit the op."""
        try:
            parsed = BlueprintContent.model_validate(candidate)
        except ValidationError as e:
            issues = "; ".join(
                f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}" for err in e.errors()
            )
            return {"draft": draft, "result": f"Tool error: edit rejected — {issues}"}
        io.emit({"type": "edit", "op": op})
        actions.append({"kind": "edit", "op": op})
        return {"draft": parsed.model_dump(by_alias=True, exclude_unset=True), "result": "Edit applied."}

    def compact_nested(obj: dict) -> dict:
        """Per-item null-strip a section's nested query/rule arrays; the strict tool
        schemas force `null` into their optional slots, which the core schemas reject."""
        out = {**obj}
        if isinstance(out.get("queries"), list):
            out["queries"] = [compact(qy) for qy in out["queries"]]
        if isinstance(out.get("rules"), list):
            out["rules"] = [compact(r) for r in out["rules"]]
        return out

    def validate_queries(queries: list[dict]) -> str | None:
        """Validate + dry-run baked queries; None on success, else the byte-exact Tool error string."""
        seen: set[str] = set()
        for qy in queries:
            nm = qy.get("name")
            if not isinstance(nm, str) or not _QUERY_NAME_RE.match(nm) or nm in seen:
                return f"Tool error: invalid query name: {nm}"
            seen.add(nm)
            try:
                ctx["runSql"](qy["sql"])  # dry run: read-only + syntax + table existence
            except Exception as e:  # noqa: BLE001
                return f"Tool error: invalid query {nm}: {e}"
        return None

    def reject_unbound(family_ids: Any) -> str | None:
        """Reject familyIds a patch/section would set that are not bound to this blueprint."""
        bound_ids = {f["id"] for f in ctx["families"] if f["bound"]}
        ids = family_ids if isinstance(family_ids, list) else []
        bad = [i for i in ids if i not in bound_ids]
        return f"Tool error: family not bound to this blueprint: {', '.join(bad)}" if bad else None

    if name == "edit_section":
        section = next((s for s in draft["sections"] if s["key"] == args.get("key")), None)
        if section is None:
            return {"draft": draft, "result": f"Tool error: no section with key {args.get('key')}"}
        patch = compact_nested(compact(args.get("patch") or {}))
        if len(patch) == 0:
            return {"draft": draft, "result": "Tool error: empty patch"}
        if "familyIds" in patch:
            err = reject_unbound(patch["familyIds"])
            if err:
                return {"draft": draft, "result": err}
        # Match TS `before[k] = section[k]`: when the section lacks an optional key
        # (only fixedText), TS assigns undefined, which JSON.stringify drops — so the
        # key must be ABSENT here too (an explicit null breaks the editOps revert,
        # whose z.string().optional() rejects null).
        before = {k: section[k] for k in patch if k in section}
        candidate = {
            **draft,
            "sections": [
                {**s, **patch} if s["key"] == args.get("key") else s for s in draft["sections"]
            ],
        }
        return commit(candidate, {"type": "edit_section", "key": args.get("key"), "before": before, "after": patch})  # noqa: E501

    if name == "add_section":
        sec_arg = args.get("section") or {}
        if any(s["key"] == sec_arg.get("key") for s in draft["sections"]):
            return {"draft": draft, "result": f"Tool error: duplicate section key {sec_arg.get('key')}"}
        unbound_err = reject_unbound(sec_arg.get("familyIds"))
        if unbound_err:
            return {"draft": draft, "result": unbound_err}
        compacted = compact_nested(compact(sec_arg))
        query_err = validate_queries(compacted.get("queries") or [])
        if query_err:
            return {"draft": draft, "result": query_err}
        section = {**compacted, "number": 0}
        after_key = args.get("afterKey")
        if after_key is None:
            idx = len(draft["sections"])
        else:
            idx = next((i for i, s in enumerate(draft["sections"]) if s["key"] == after_key), -1) + 1
        if idx == 0 and after_key:
            return {"draft": draft, "result": f"Tool error: no section with key {after_key}"}
        sections = renumber([*draft["sections"][:idx], section, *draft["sections"][idx:]])
        placed = sections[idx]
        return commit(
            {**draft, "sections": sections},
            {"type": "add_section", "afterKey": after_key, "section": placed},
        )

    if name == "remove_section":
        idx = next((i for i, s in enumerate(draft["sections"]) if s["key"] == args.get("key")), -1)
        if idx == -1:
            return {"draft": draft, "result": f"Tool error: no section with key {args.get('key')}"}
        removed = draft["sections"][idx]
        after_key = None if idx == 0 else draft["sections"][idx - 1]["key"]
        sections = renumber([s for s in draft["sections"] if s["key"] != args.get("key")])
        return commit(
            {**draft, "sections": sections},
            {"type": "remove_section", "afterKey": after_key, "removed": removed},
        )

    if name == "update_masthead":
        patch = compact(args.get("patch") or {})
        if len(patch) == 0:
            return {"draft": draft, "result": "Tool error: empty patch"}
        before = {k: draft.get(k) for k in patch}
        return commit({**draft, **patch}, {"type": "update_masthead", "before": before, "after": patch})

    if name == "update_global_rules":
        rules = (
            [r for r in args["rules"] if isinstance(r, str)]
            if isinstance(args.get("rules"), list)
            else []
        )
        return commit(
            {**draft, "globalRules": rules},
            {"type": "update_global_rules", "before": draft["globalRules"], "after": rules},
        )

    if name == "update_section_queries":
        section = next((s for s in draft["sections"] if s["key"] == args.get("sectionKey")), None)
        if section is None:
            return {"draft": draft, "result": f"Tool error: no section with key {args.get('sectionKey')}"}
        queries = (
            [compact(qy) for qy in args["queries"]] if isinstance(args.get("queries"), list) else []
        )
        query_err = validate_queries(queries)
        if query_err:
            return {"draft": draft, "result": query_err}
        candidate = {
            **draft,
            "sections": [
                {**s, "queries": queries} if s["key"] == args.get("sectionKey") else s
                for s in draft["sections"]
            ],
        }
        return commit(
            candidate,
            {"type": "update_section_queries", "sectionKey": args.get("sectionKey"), "before": section["queries"], "after": queries},  # noqa: E501
        )

    if name == "query_sources":
        cat_by_key = {c["key"]: c for c in ctx["catalog"]}
        family_id = args.get("familyId")
        period_arg = args.get("period")
        if not family_id:
            # v1.2b tree, plus table/column lines for queryable families.
            def with_tables(f: dict) -> str:
                cat = cat_by_key.get(f["key"])
                if cat and cat["queryable"]:
                    extra = [
                        "  " + t["name"] + "(" + ", ".join(c["name"] + " " + c["type"] for c in t["columns"]) + ")"  # noqa: E501
                        for t in cat["tables"]
                    ]
                else:
                    extra = []
                return "\n".join([family_line(f), *extra])

            bound = [with_tables(f) for f in ctx["families"] if f["bound"]]
            unbound = [with_tables(f) for f in ctx["families"] if not f["bound"]]
            if not ctx["families"]:
                return {"draft": draft, "result": "No data families in this project."}
            trailer = ["Not bound to this blueprint:", *unbound] if unbound else []
            return {"draft": draft, "result": "\n".join([*bound, *trailer])}
        fam = next((f for f in ctx["families"] if f["id"] == family_id), None)
        key = fam["key"] if fam is not None else family_id
        cat = cat_by_key.get(fam["key"]) if fam is not None else None
        if cat and cat["queryable"]:
            if period_arg and period_arg not in fam["filedPeriods"]:
                return {"draft": draft, "result": f"Tool error: no file for {key} at {period_arg}"}
            if fam["kind"] == "periodic":
                period = (
                    period_arg
                    if period_arg is not None
                    else (fam["filedPeriods"][-1] if fam["filedPeriods"] else None)
                )
            else:
                period = None
            parts = [serialize_catalog([cat])]
            for t in cat["tables"]:
                where = f" WHERE _period = '{period}'" if period else ""
                sql = f"SELECT * FROM {t['name']}{where} LIMIT 10"
                try:
                    parts.append(f"-- {t['name']}\n{ctx['runSql'](sql)}")
                except Exception as e:  # noqa: BLE001
                    parts.append(f"-- {t['name']}\nTool error: sql: {e}")
            return {"draft": draft, "result": "\n".join(parts)}
        # Document families: v1.2b pack behavior, byte-identical error strings.
        if period_arg:
            entry_id = f"{family_id}:{period_arg}"
            if not any(s["id"] == entry_id for s in period_pack["sources"]):
                return {"draft": draft, "result": f"Tool error: no file for {key} at {period_arg}"}
            return {"draft": draft, "result": pack_for_prompt(period_pack, [entry_id])}
        if not any(s["id"] == family_id for s in default_pack["sources"]):
            return {"draft": draft, "result": f"Tool error: no file for {key}"}
        return {"draft": draft, "result": pack_for_prompt(default_pack, [family_id])}

    if name == "run_sql":
        sql = str(args.get("sql") if args.get("sql") is not None else "")
        try:
            return {"draft": draft, "result": ctx["runSql"](sql)}
        except Exception as e:  # noqa: BLE001
            return {"draft": draft, "result": f"Tool error: sql: {e}"}

    if name == "list_runs":
        runs = ctx["listRuns"]()
        if not runs:
            return {"draft": draft, "result": "No runs yet."}
        return {
            "draft": draft,
            "result": "\n".join(
                f"{r['id']} · {r['createdAt']} · {r['status']} · rev {r['rev']}"
                + (
                    f" · {r['stats']['citationCount']} citations, {r['stats']['checksFailed']} failed checks, "  # noqa: E501
                    f"{r['flagCount']} flags, {r['stats']['retries']} retries"
                    if r["stats"]
                    else ""
                )
                for r in runs
            ),
        }

    if name == "get_run_section":
        d = ctx["getRunSection"](
            str(args.get("runId") if args.get("runId") is not None else ""),
            str(args.get("key") if args.get("key") is not None else ""),
        )
        if not d:
            return {"draft": draft, "result": "Tool error: run or section not found"}
        parts = [d["text"]]
        if d["checkFailures"]:
            parts.append(f"Check failures: {'; '.join(d['checkFailures'])}")
        if d["retryReasons"]:
            parts.append(f"Retries: {'; '.join(d['retryReasons'])}")
        if d["steers"]:
            parts.append(f"Steers: {' | '.join(d['steers'])}")
        if d["answers"]:
            parts.append(
                "Answers: " + " | ".join(f"Q: {a['question']} A: {a['answer']}" for a in d["answers"])
            )
        if d["flags"]:
            flag_parts = []
            for fl in d["flags"]:
                res = f": {fl['resolution']}" if fl["resolution"] else ""
                flag_parts.append(f"{fl['question']} [{fl['status']}{res}]")
            parts.append("Flags: " + " | ".join(flag_parts))
        return {"draft": draft, "result": "\n\n".join(parts)}

    if name == "list_goldens":
        gs = ctx["listGoldens"]()
        if not gs:
            return {"draft": draft, "result": "No goldens yet."}
        lines = []
        for g in gs:
            note = f" — {g['note']}" if g["note"] else ""
            lines.append(f"{g['id']} · {g['kind']} · {g['label']}{note}")
        return {"draft": draft, "result": "\n".join(lines)}

    if name == "get_golden":
        g = ctx["getGolden"](str(args.get("id") if args.get("id") is not None else ""))
        if not g:
            return {"draft": draft, "result": "Tool error: golden not found"}
        return {"draft": draft, "result": f"{g['description']}\n\n{g['text']}"}

    if name == "get_golden_scaffold":
        return {
            "draft": draft,
            "result": ctx["scaffoldDigest"](
                str(args.get("goldenId") if args.get("goldenId") is not None else "")
            ),
        }

    if name == "save_memory":
        body = str(args.get("body") if args.get("body") is not None else "").strip()
        if not body:
            return {"draft": draft, "result": "Tool error: empty memory body"}
        scope = "project" if args.get("scope") == "project" else "blueprint"
        memory_id = ctx["saveMemory"](body, scope)
        io.emit({"type": "memory_saved", "memoryId": memory_id, "body": body})
        actions.append({"kind": "memory", "memoryId": memory_id, "body": body})
        return {"draft": draft, "result": "Memory saved."}

    return {"draft": draft, "result": f"Tool error: unknown tool {name}"}


__all__ = [
    "MAX_ITERATIONS",
    "MAX_TOOL_RESULT_CHARS",
    "TOOLS",
    "copilot_system_prompt",
    "activity_label",
    "compact",
    "renumber",
    "family_line",
    "execute_tool",
]
