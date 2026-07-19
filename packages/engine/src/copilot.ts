import type OpenAI from "openai";
import {
  BlueprintContentSchema,
  type BlueprintContent,
  type BlueprintSection,
  type CopilotAction,
  type EditOp,
  type MastheadPatch,
  type RunStats,
} from "@runoff/core";
import { buildSourcePack, packForPrompt, type EngineFile, type SourcePack } from "./sourcePack.js";
import { computeLocator } from "./checks.js";
import { serializeCatalog, type CatalogFamily } from "./catalogFormat.js";
import { MODEL, guidanceBlocks, type ScopedMemory } from "./prompts.js";

const MAX_ITERATIONS = 12;
const MAX_TOOL_RESULT_CHARS = 8_000;

export interface CopilotIO {
  emit(e: CopilotEvent): void;
}

export type CopilotEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_activity"; label: string }
  | { type: "edit"; op: EditOp }
  | { type: "memory_saved"; memoryId: string; body: string }
  | { type: "done"; messageId: string }
  | { type: "error"; message: string };

export interface RunSummary {
  id: string;
  createdAt: string;
  status: string;
  stats: RunStats | null;
  flagCount: number;
  rev: number;
}

export interface RunSectionDetail {
  text: string;
  checkFailures: string[];
  retryReasons: string[];
  steers: string[];
  answers: { question: string; answer: string }[];
  flags: { question: string; status: string; resolution: string | null }[];
}

export interface GoldenSummary {
  id: string;
  kind: "run" | "section" | "exemplar";
  label: string;
  note: string | null;
}

export interface FamilyInfo {
  id: string;
  key: string;
  label: string;
  kind: "periodic" | "constant";
  granularity: "quarter" | "month" | "year" | null;
  filedPeriods: string[]; // ascending; [] for constant
  hasLiveFile: boolean; // constant only
  bound: boolean; // bound to this blueprint
}

/** Server-side data access handed in by the caller (the web copilot route). */
export interface CopilotContext {
  families: FamilyInfo[];
  /** Bound families resolved to latest period + constants; id = family id. */
  defaultFiles: EngineFile[];
  /** Every filed periodic row of bound families; the pack keys them `${familyId}:${period}`. */
  periodFiles: { familyId: string; period: string; file: EngineFile }[];
  /** Warehouse catalog for this project: families → tables/columns/counts. */
  catalog: CatalogFamily[];
  /** Read-only SQL against the project warehouse; returns the formatted result, THROWS on any error (incl. "no data ingested yet"). */
  runSql(sql: string): string;
  listRuns(): RunSummary[];
  getRunSection(runId: string, key: string): RunSectionDetail | null;
  listGoldens(): GoldenSummary[];
  getGolden(id: string): { description: string; text: string } | null;
  saveMemory(body: string, scope: "blueprint" | "project"): string;
}

export interface CopilotTurnResult {
  reply: string;
  actions: CopilotAction[];
  draft: BlueprintContent;
}

const TOOLS = [
  fn("edit_section", "Patch fields of one existing section of the blueprint draft. Only include fields you are changing.", {
    key: { type: "string" },
    patch: {
      type: "object",
      properties: {
        heading: { type: ["string", "null"] },
        mode: { type: ["string", "null"], enum: ["fixed", "auto", "review", null] },
        instruction: { type: ["string", "null"] },
        fixedText: { type: ["string", "null"] },
        familyIds: { type: ["array", "null"], items: { type: "string" } },
        rules: {
          type: ["array", "null"],
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["assert", "style", "judgment"] },
              text: { type: "string" },
              expression: { type: ["string", "null"] },
            },
            required: ["kind", "text", "expression"],
            additionalProperties: false,
          },
        },
      },
      required: ["heading", "mode", "instruction", "fixedText", "familyIds", "rules"],
      additionalProperties: false,
    },
  }),
  fn("add_section", "Insert a new section after the section named by afterKey (null appends at the end). Numbers are reassigned automatically.", {
    afterKey: { type: ["string", "null"] },
    section: {
      type: "object",
      properties: {
        key: { type: "string" },
        heading: { type: "string" },
        mode: { type: "string", enum: ["fixed", "auto", "review"] },
        instruction: { type: "string" },
        fixedText: { type: ["string", "null"] },
        familyIds: { type: "array", items: { type: "string" } },
        rules: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["assert", "style", "judgment"] }, text: { type: "string" }, expression: { type: ["string", "null"] } }, required: ["kind", "text", "expression"], additionalProperties: false } },
      },
      required: ["key", "heading", "mode", "instruction", "fixedText", "familyIds", "rules"],
      additionalProperties: false,
    },
  }),
  fn("remove_section", "Remove one section from the draft.", { key: { type: "string" } }),
  fn("update_masthead", "Patch the report masthead. Only include fields you are changing.", {
    patch: {
      type: "object",
      properties: {
        title: { type: ["string", "null"] }, clientName: { type: ["string", "null"] },
        eyebrow: { type: ["string", "null"] }, dateline: { type: ["string", "null"] },
      },
      required: ["title", "clientName", "eyebrow", "dateline"],
      additionalProperties: false,
    },
  }),
  fn("update_global_rules", "Replace the blueprint's global rules list.", {
    rules: { type: "array", items: { type: "string" } },
  }),
  fn("query_sources", "Inspect the data families in this project. Without familyId: the family tree — one line per family with its kind, granularity, and filed periods. With familyId: columns and first rows of that family's latest file (or its constant reference file). With familyId and period: that specific period's file.", {
    familyId: { type: ["string", "null"] },
    period: { type: ["string", "null"] },
  }),
  fn("compute", "Evaluate one aggregate over a bound family's latest file: agg(familyId.column) or agg(familyId.column where col=value), agg one of sum|avg|min|max|count. To inspect an earlier period, use query_sources with that period instead.", {
    expression: { type: "string" },
  }),
  fn("run_sql", "Run one read-only SQL SELECT against this project's ingested data (SQLite). Table and column names are in the data catalog; periodic tables have a _period column (e.g. WHERE _period = '2026-Q1'). Results are capped at 200 rows.", {
    sql: { type: "string" },
  }),
  fn("list_runs", "List this blueprint's most recent runs with their stats.", {}),
  fn("get_run_section", "Fetch one section of a past run: its text plus that section's check failures, retries, steers, answers, and flags.", {
    runId: { type: "string" }, key: { type: "string" },
  }),
  fn("list_goldens", "List this blueprint's golden examples (starred runs/sections and uploaded exemplars).", {}),
  fn("get_golden", "Fetch one golden example's full text.", { id: { type: "string" } }),
  fn("save_memory", "Save one durable, generalized preference. scope \"blueprint\" = about this document; scope \"project\" = about the client or its data, true for every document in the project.", {
    body: { type: "string" },
    scope: { type: "string", enum: ["blueprint", "project"] },
  }),
] as const;

function fn(name: string, description: string, properties: Record<string, unknown>) {
  return {
    type: "function",
    function: {
      name,
      description,
      strict: true,
      parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
    },
  };
}

function copilotSystemPrompt(draft: BlueprintContent, selectedKey: string | null, memories: ScopedMemory[], catalog: CatalogFamily[]): string {
  const memoryBlock = guidanceBlocks(memories);
  const selected = selectedKey ? `\nThe user currently has section "${selectedKey}" selected in the editor.` : "";
  const catalogBlock = catalog.length ? `\n\nData catalog (tables you can query with run_sql):\n${serializeCatalog(catalog)}` : "";
  return `You are the builder copilot for a Runoff blueprint — a template that generates a recurring, \
fact-checked business report. You edit the blueprint itself (instructions, rules, structure), never \
the report output. Use your tools to inspect the bound data, past runs, and golden examples before \
guessing; apply edits directly with the edit tools (the user sees each edit and can revert it); keep \
instructions concrete and grounded in the actual source columns. Figures in generated reports are \
audited against locator expressions like sum(src.amount where channel=search) — prefer assert rules \
and instructions that reference real columns. Data is organized into families (one file per period, or \
constant reference files); query_sources shows what periods exist. When the user states a durable \
preference, save it with save_memory. Reply concisely in plain prose; never dump raw JSON at the user.${selected}${catalogBlock}

Current draft (JSON):
${JSON.stringify(draft)}${memoryBlock}`;
}

function activityLabel(name: string, args: any, families: FamilyInfo[]): string {
  switch (name) {
    case "edit_section": return `editing §${args?.key ?? "?"}`;
    case "add_section": return `adding section "${args?.section?.heading ?? "?"}"`;
    case "remove_section": return `removing §${args?.key ?? "?"}`;
    case "update_masthead": return "editing masthead";
    case "update_global_rules": return "editing global rules";
    case "query_sources": {
      if (!args?.familyId) return "listing data families";
      const key = families.find((f) => f.id === args.familyId)?.key ?? args.familyId;
      return `reading ${key}${args.period ? ` @ ${args.period}` : ""}`;
    }
    case "compute": return `computing ${args?.expression ?? "?"}`;
    case "run_sql": return "running SQL";
    case "list_runs": return "listing recent runs";
    case "get_run_section": return `reading run ${args?.runId ?? "?"} §${args?.key ?? "?"}`;
    case "list_goldens": return "listing goldens";
    case "get_golden": return `reading golden ${args?.id ?? "?"}`;
    case "save_memory": return "saving a memory";
    default: return name;
  }
}

interface AccumulatedToolCall { id: string; name: string; arguments: string }

export async function copilotTurn(opts: {
  client: OpenAI;
  draft: BlueprintContent;
  selectedKey: string | null;
  message: string;
  thread: { role: "user" | "assistant"; body: string }[];
  memories: ScopedMemory[];
  ctx: CopilotContext;
  io: CopilotIO;
}): Promise<CopilotTurnResult> {
  const { client, ctx, io } = opts;
  let draft: BlueprintContent = structuredClone(opts.draft);
  const actions: CopilotAction[] = [];
  // Two packs: the DEFAULT resolution (latest period / constant live file, keyed
  // by family id) drives query_sources/compute; the PERIOD pack (keyed
  // `${familyId}:${period}`) backs period-addressed inspection.
  const defaultPack = await buildSourcePack(ctx.defaultFiles);
  const periodPack = await buildSourcePack(
    ctx.periodFiles.map((p) => ({ ...p.file, id: `${p.familyId}:${p.period}` })),
  );

  const messages: any[] = [
    { role: "system", content: copilotSystemPrompt(draft, opts.selectedKey, opts.memories, ctx.catalog) },
    ...opts.thread.map((t) => ({ role: t.role, content: t.body })),
    { role: "user", content: opts.message },
  ];

  let reply = "";
  let nudged = false;
  for (let iter = 0; ; iter++) {
    const stream = await (client as any).chat.completions.create({
      model: MODEL,
      stream: true,
      messages,
      tools: TOOLS,
      max_completion_tokens: 8000,
    });

    let turnText = "";
    let finishReason: string | null = null;
    const toolCalls: AccumulatedToolCall[] = [];

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content.length) {
        turnText += delta.content;
        io.emit({ type: "text_delta", text: delta.content });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const acc = (toolCalls[idx] ??= { id: "", name: "", arguments: "" });
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.arguments += tc.function.arguments;
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    reply = turnText;
    if (finishReason !== "tool_calls") break;

    // Already nudged once and the model is still calling tools — hard stop.
    // Don't execute the tools or make another API call; return what we have.
    if (nudged) break;

    // Cap: after MAX_ITERATIONS tool-executing rounds, refuse the calls and
    // demand a final answer. The nudge is sent at most once.
    if (iter >= MAX_ITERATIONS) {
      nudged = true;
      messages.push({
        role: "assistant",
        content: turnText || null,
        tool_calls: toolCalls.filter((c) => c?.name).map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
      });
      for (const call of toolCalls.filter((c) => c?.name)) {
        messages.push({ role: "tool", tool_call_id: call.id, content: "Tool budget for this turn is exhausted. Summarize what you have and finish your reply now." });
      }
      continue;
    }

    messages.push({
      role: "assistant",
      content: turnText || null,
      tool_calls: toolCalls.filter((c) => c?.name).map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
    });
    for (const call of toolCalls) {
      if (!call?.name) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(call.arguments || "{}");
      } catch {
        messages.push({ role: "tool", tool_call_id: call.id, content: "Invalid tool arguments — ignored." });
        continue;
      }
      io.emit({ type: "tool_activity", label: activityLabel(call.name, parsed, ctx.families) });
      actions.push({ kind: "tool", tool: call.name, label: activityLabel(call.name, parsed, ctx.families) });
      let result: string;
      try {
        const out = executeTool(call.name, parsed, { draft, defaultPack, periodPack, ctx, io, actions });
        draft = out.draft;
        result = out.result;
      } catch (err) {
        result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result.slice(0, MAX_TOOL_RESULT_CHARS) });
    }
  }

  return { reply, actions, draft };
}

/** Strip nulls the strict schemas force into optional slots. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj ?? {})) if (v !== null && v !== undefined) out[k] = v;
  return out as Partial<T>;
}

function renumber(sections: BlueprintSection[]): BlueprintSection[] {
  return sections.map((s, i) => ({ ...s, number: i + 1 }));
}

/** One line per family: `key · kind · granularity · <data status>`. */
function familyLine(f: FamilyInfo): string {
  const gran = f.granularity ? ` · ${f.granularity}` : "";
  const data = f.kind === "constant"
    ? (f.hasLiveFile ? "live file ✓" : "no data yet")
    : (f.filedPeriods.length ? `periods: ${f.filedPeriods.map((p) => `${p} ✓`).join(", ")}` : "no data yet");
  return `${f.key} · ${f.kind}${gran} · ${data}`;
}

function executeTool(
  name: string,
  args: any,
  env: { draft: BlueprintContent; defaultPack: SourcePack; periodPack: SourcePack; ctx: CopilotContext; io: CopilotIO; actions: CopilotAction[] },
): { draft: BlueprintContent; result: string } {
  const { defaultPack, periodPack, ctx, io, actions } = env;
  let draft = env.draft;

  /** Validate a candidate draft; on success commit it + emit the op. */
  const commit = (candidate: BlueprintContent, op: EditOp): { draft: BlueprintContent; result: string } => {
    const parsed = BlueprintContentSchema.safeParse(candidate);
    if (!parsed.success) {
      return { draft, result: `Tool error: edit rejected — ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
    }
    io.emit({ type: "edit", op });
    actions.push({ kind: "edit", op });
    return { draft: parsed.data, result: "Edit applied." };
  };

  /** Reject familyIds a patch/section would set that are not bound to this blueprint. */
  const rejectUnbound = (familyIds: unknown): string | null => {
    const boundIds = new Set(ctx.families.filter((f) => f.bound).map((f) => f.id));
    const bad = (Array.isArray(familyIds) ? familyIds : []).filter((id: string) => !boundIds.has(id));
    return bad.length ? `Tool error: family not bound to this blueprint: ${bad.join(", ")}` : null;
  };

  switch (name) {
    case "edit_section": {
      const section = draft.sections.find((s) => s.key === args.key);
      if (!section) return { draft, result: `Tool error: no section with key ${args.key}` };
      const patch = compact(args.patch ?? {}) as Partial<BlueprintSection>;
      if (Object.keys(patch).length === 0) return { draft, result: "Tool error: empty patch" };
      if ("familyIds" in patch) {
        const err = rejectUnbound(patch.familyIds);
        if (err) return { draft, result: err };
      }
      const before: Partial<BlueprintSection> = {};
      for (const k of Object.keys(patch) as (keyof BlueprintSection)[]) (before as any)[k] = section[k];
      const candidate = { ...draft, sections: draft.sections.map((s) => (s.key === args.key ? { ...s, ...patch } : s)) };
      return commit(candidate, { type: "edit_section", key: args.key, before, after: patch });
    }
    case "add_section": {
      if (draft.sections.some((s) => s.key === args.section?.key)) {
        return { draft, result: `Tool error: duplicate section key ${args.section?.key}` };
      }
      const unboundErr = rejectUnbound(args.section?.familyIds);
      if (unboundErr) return { draft, result: unboundErr };
      const section = { ...compact(args.section ?? {}), number: 0 } as BlueprintSection;
      const idx = args.afterKey === null || args.afterKey === undefined
        ? draft.sections.length
        : draft.sections.findIndex((s) => s.key === args.afterKey) + 1;
      if (idx === 0 && args.afterKey) return { draft, result: `Tool error: no section with key ${args.afterKey}` };
      const sections = renumber([...draft.sections.slice(0, idx), section, ...draft.sections.slice(idx)]);
      const placed = sections[idx];
      return commit({ ...draft, sections }, { type: "add_section", afterKey: args.afterKey ?? null, section: placed });
    }
    case "remove_section": {
      const idx = draft.sections.findIndex((s) => s.key === args.key);
      if (idx === -1) return { draft, result: `Tool error: no section with key ${args.key}` };
      const removed = draft.sections[idx];
      const afterKey = idx === 0 ? null : draft.sections[idx - 1].key;
      const sections = renumber(draft.sections.filter((s) => s.key !== args.key));
      return commit({ ...draft, sections }, { type: "remove_section", afterKey, removed });
    }
    case "update_masthead": {
      const patch = compact(args.patch ?? {}) as MastheadPatch;
      if (Object.keys(patch).length === 0) return { draft, result: "Tool error: empty patch" };
      const before: MastheadPatch = {};
      for (const k of Object.keys(patch) as (keyof MastheadPatch)[]) before[k] = draft[k];
      return commit({ ...draft, ...patch }, { type: "update_masthead", before, after: patch });
    }
    case "update_global_rules": {
      const rules = Array.isArray(args.rules) ? args.rules.filter((r: unknown) => typeof r === "string") : [];
      return commit({ ...draft, globalRules: rules }, { type: "update_global_rules", before: draft.globalRules, after: rules });
    }
    case "query_sources": {
      const catByKey = new Map(ctx.catalog.map((c) => [c.key, c]));
      if (!args.familyId) {
        // v1.2b tree, plus table/column lines for queryable families.
        const withTables = (f: FamilyInfo): string => {
          const cat = catByKey.get(f.key);
          const extra = cat?.queryable
            ? cat.tables.map((t) => `  ${t.name}(${t.columns.map((c) => `${c.name} ${c.type}`).join(", ")})`)
            : [];
          return [familyLine(f), ...extra].join("\n");
        };
        const bound = ctx.families.filter((f) => f.bound).map(withTables);
        const unbound = ctx.families.filter((f) => !f.bound).map(withTables);
        if (!ctx.families.length) return { draft, result: "No data families in this project." };
        return { draft, result: [...bound, ...(unbound.length ? ["Not bound to this blueprint:", ...unbound] : [])].join("\n") };
      }
      const fam = ctx.families.find((f) => f.id === args.familyId);
      const key = fam?.key ?? args.familyId;
      const cat = fam ? catByKey.get(fam.key) : undefined;
      if (cat?.queryable) {
        if (args.period && !fam!.filedPeriods.includes(args.period)) {
          return { draft, result: `Tool error: no file for ${key} at ${args.period}` };
        }
        const period = fam!.kind === "periodic" ? (args.period ?? fam!.filedPeriods[fam!.filedPeriods.length - 1]) : null;
        const parts = [serializeCatalog([cat])];
        for (const t of cat.tables) {
          const where = period ? ` WHERE _period = '${period}'` : "";
          try {
            parts.push(`-- ${t.name}\n${ctx.runSql(`SELECT * FROM ${t.name}${where} LIMIT 10`)}`);
          } catch (err) {
            parts.push(`-- ${t.name}\nTool error: sql: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return { draft, result: parts.join("\n") };
      }
      // Document families: v1.2b pack behavior, byte-identical error strings.
      if (args.period) {
        const entryId = `${args.familyId}:${args.period}`;
        if (!periodPack.sources.some((s) => s.id === entryId)) {
          return { draft, result: `Tool error: no file for ${key} at ${args.period}` };
        }
        return { draft, result: packForPrompt(periodPack, [entryId], 20) };
      }
      if (!defaultPack.sources.some((s) => s.id === args.familyId)) {
        return { draft, result: `Tool error: no file for ${key}` };
      }
      return { draft, result: packForPrompt(defaultPack, [args.familyId], 20) };
    }
    case "compute":
      return { draft, result: String(computeLocator(String(args.expression ?? ""), defaultPack)) };
    case "run_sql": {
      const sql = String(args.sql ?? "");
      try {
        return { draft, result: ctx.runSql(sql) };
      } catch (err) {
        return { draft, result: `Tool error: sql: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    case "list_runs": {
      const runs = ctx.listRuns();
      if (!runs.length) return { draft, result: "No runs yet." };
      return {
        draft,
        result: runs
          .map((r) => `${r.id} · ${r.createdAt} · ${r.status} · rev ${r.rev}` +
            (r.stats ? ` · ${r.stats.citationCount} citations, ${r.stats.checksFailed} failed checks, ${r.flagCount} flags, ${r.stats.retries} retries` : ""))
          .join("\n"),
      };
    }
    case "get_run_section": {
      const d = ctx.getRunSection(String(args.runId ?? ""), String(args.key ?? ""));
      if (!d) return { draft, result: "Tool error: run or section not found" };
      const parts = [d.text];
      if (d.checkFailures.length) parts.push(`Check failures: ${d.checkFailures.join("; ")}`);
      if (d.retryReasons.length) parts.push(`Retries: ${d.retryReasons.join("; ")}`);
      if (d.steers.length) parts.push(`Steers: ${d.steers.join(" | ")}`);
      if (d.answers.length) parts.push(`Answers: ${d.answers.map((a) => `Q: ${a.question} A: ${a.answer}`).join(" | ")}`);
      if (d.flags.length) parts.push(`Flags: ${d.flags.map((f) => `${f.question} [${f.status}${f.resolution ? `: ${f.resolution}` : ""}]`).join(" | ")}`);
      return { draft, result: parts.join("\n\n") };
    }
    case "list_goldens": {
      const gs = ctx.listGoldens();
      if (!gs.length) return { draft, result: "No goldens yet." };
      return { draft, result: gs.map((g) => `${g.id} · ${g.kind} · ${g.label}${g.note ? ` — ${g.note}` : ""}`).join("\n") };
    }
    case "get_golden": {
      const g = ctx.getGolden(String(args.id ?? ""));
      if (!g) return { draft, result: "Tool error: golden not found" };
      return { draft, result: `${g.description}\n\n${g.text}` };
    }
    case "save_memory": {
      const body = String(args.body ?? "").trim();
      if (!body) return { draft, result: "Tool error: empty memory body" };
      const scope = args.scope === "project" ? "project" : "blueprint";
      const memoryId = ctx.saveMemory(body, scope);
      io.emit({ type: "memory_saved", memoryId, body });
      actions.push({ kind: "memory", memoryId, body });
      return { draft, result: "Memory saved." };
    }
    default:
      return { draft, result: `Tool error: unknown tool ${name}` };
  }
}
