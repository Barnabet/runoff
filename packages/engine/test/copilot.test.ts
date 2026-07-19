import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BlueprintContent } from "@runoff/core";
import { copilotTurn, type CopilotContext, type CopilotEvent, type FamilyInfo } from "../src/copilot.js";
import type { CatalogFamily } from "../src/catalogFormat.js";
import { makeFakeClient, type FakeTurn } from "./fakeClient.js";

const content: BlueprintContent = {
  title: "Monthly Performance Report",
  clientName: "Meridian Retail",
  eyebrow: "Marketing Performance",
  dateline: "June 2026",
  sections: [
    { key: "exec", number: 1, heading: "Executive summary", mode: "auto", instruction: "Summarize.", familyIds: [], rules: [] },
    { key: "budget", number: 2, heading: "Budget", mode: "auto", instruction: "Cover spend.", familyIds: ["src_data"], rules: [] },
  ],
  globalRules: [],
  delivery: { recipient: "ops@example.com", autoDeliverOnClear: false },
};

function ctx(overrides: Partial<CopilotContext> = {}): CopilotContext {
  return {
    families: [],
    defaultFiles: [],
    periodFiles: [],
    catalog: [],
    runSql: () => { throw new Error("no data ingested yet"); },
    listRuns: () => [],
    getRunSection: () => null,
    listGoldens: () => [],
    getGolden: () => null,
    saveMemory: () => "mem_1",
    ...overrides,
  };
}

function famInfo(over: Partial<FamilyInfo> & { key: string }): FamilyInfo {
  return {
    id: `fam_${over.key}`,
    label: over.key,
    kind: "periodic",
    granularity: "quarter",
    filedPeriods: ["2026-Q1"],
    hasLiveFile: false,
    bound: false,
    ...over,
  };
}

function catFam(over: Partial<CatalogFamily> & { key: string }): CatalogFamily {
  return {
    id: `fam_${over.key}`,
    label: over.key,
    kind: "periodic",
    granularity: "quarter",
    queryable: false,
    tables: [],
    filedPeriods: [],
    ...over,
  };
}

function collect() {
  const events: CopilotEvent[] = [];
  return { events, io: { emit: (e: CopilotEvent) => events.push(e) } };
}

/**
 * Wrap the fake client so tests can read back the tool RESULT strings the loop
 * feeds to the model. `messages` is mutated in place by copilotTurn, so
 * capturing any `create` call's array reference exposes every `role: "tool"`
 * message written before the turn ended.
 */
function recording(script: FakeTurn[][]): { client: any; toolResults: () => string[] } {
  const base = makeFakeClient(script);
  const inner = base.chat.completions.create;
  let messages: any[] = [];
  base.chat.completions.create = async (params: any) => {
    messages = params.messages;
    return inner(params);
  };
  return {
    client: base,
    toolResults: () => messages.filter((m) => m.role === "tool").map((m) => m.content as string),
  };
}

describe("copilotTurn", () => {
  it("applies a valid edit_section patch: emits the op, updates the draft, returns actions", async () => {
    const client = makeFakeClient([
      [
        { toolUse: { name: "edit_section", input: { key: "exec", patch: { instruction: "Summarize the quarter in three sentences." } } } },
      ],
      [{ text: "Tightened the exec summary instruction." }],
    ]);
    const { events, io } = collect();
    const res = await copilotTurn({
      client, draft: content, selectedKey: "exec", message: "tighten the exec instruction",
      thread: [], memories: [], ctx: ctx(), io,
    });

    const edit = events.find((e) => e.type === "edit");
    expect(edit && edit.type === "edit" && edit.op.type === "edit_section" && edit.op.key === "exec").toBe(true);
    if (edit?.type === "edit" && edit.op.type === "edit_section") {
      expect(edit.op.before.instruction).toBe("Summarize.");
      expect(edit.op.after.instruction).toBe("Summarize the quarter in three sentences.");
    }
    expect(res.draft.sections[0].instruction).toBe("Summarize the quarter in three sentences.");
    expect(res.reply).toBe("Tightened the exec summary instruction.");
    expect(res.actions.some((a) => a.kind === "edit")).toBe(true);
    // Every executed tool announces itself first.
    expect(events.some((e) => e.type === "tool_activity")).toBe(true);
  });

  it("rejects an invalid patch as a tool error: no op, draft unchanged, loop continues", async () => {
    const client = makeFakeClient([
      [{ toolUse: { name: "edit_section", input: { key: "exec", patch: { mode: "bogus" } } } }],
      [{ text: "That mode is not valid." }],
    ]);
    const { events, io } = collect();
    const res = await copilotTurn({
      client, draft: content, selectedKey: null, message: "break it",
      thread: [], memories: [], ctx: ctx(), io,
    });
    expect(events.some((e) => e.type === "edit")).toBe(false);
    expect(res.draft.sections[0].instruction).toBe("Summarize.");
    expect(res.reply).toBe("That mode is not valid.");
  });

  it("add_section inserts after the anchor and renumbers; remove_section carries afterKey", async () => {
    const client = makeFakeClient([
      [
        {
          toolUse: {
            name: "add_section",
            input: {
              afterKey: "exec",
              section: { key: "kpis", heading: "KPI summary", mode: "auto", instruction: "Key metrics.", familyIds: [], rules: [] },
            },
          },
        },
      ],
      [{ toolUse: { name: "remove_section", input: { key: "budget" } } }],
      [{ text: "Done." }],
    ]);
    const { events, io } = collect();
    const res = await copilotTurn({
      client, draft: content, selectedKey: null, message: "restructure",
      thread: [], memories: [], ctx: ctx(), io,
    });
    expect(res.draft.sections.map((s) => s.key)).toEqual(["exec", "kpis"]);
    expect(res.draft.sections.map((s) => s.number)).toEqual([1, 2]);
    const removeOp = events.find((e) => e.type === "edit" && e.op.type === "remove_section");
    if (removeOp?.type === "edit" && removeOp.op.type === "remove_section") {
      expect(removeOp.op.afterKey).toBe("kpis"); // budget's predecessor at removal time
      expect(removeOp.op.removed.key).toBe("budget");
    } else {
      expect.unreachable("remove_section op not emitted");
    }
  });

  it("save_memory passes the chosen scope to ctx and emits memory_saved", async () => {
    let saved = "";
    let savedScope = "";
    const client = makeFakeClient([
      [{ toolUse: { name: "save_memory", input: { body: "Always use GBP.", scope: "project" } } }],
      [{ text: "Noted." }],
    ]);
    const { events, io } = collect();
    await copilotTurn({
      client, draft: content, selectedKey: null, message: "remember that",
      thread: [], memories: [],
      ctx: ctx({ saveMemory: (b, s) => { saved = b; savedScope = s; return "mem_42"; } }), io,
    });
    expect(saved).toBe("Always use GBP.");
    expect(savedScope).toBe("project");
    expect(events.find((e) => e.type === "memory_saved")).toEqual({
      type: "memory_saved", memoryId: "mem_42", body: "Always use GBP.",
    });
  });

  it("save_memory defaults a missing or invalid scope to blueprint", async () => {
    const scopes: string[] = [];
    const client = makeFakeClient([
      [{ toolUse: { name: "save_memory", input: { body: "No scope." } } }],
      [{ toolUse: { name: "save_memory", input: { body: "Bad scope.", scope: "global" } } }],
      [{ text: "Noted." }],
    ]);
    const { io } = collect();
    await copilotTurn({
      client, draft: content, selectedKey: null, message: "remember that",
      thread: [], memories: [],
      ctx: ctx({ saveMemory: (_b, s) => { scopes.push(s); return "mem_1"; } }), io,
    });
    expect(scopes).toEqual(["blueprint", "blueprint"]);
  });

  it("streams text deltas and caps the tool loop at 12 iterations with a wrap-up", async () => {
    // 13 scripted tool turns; fake client repeats its last script entry, so
    // iteration 13 would also tool-call — the cap must inject the wrap-up nudge
    // and accept the next text turn instead.
    const toolTurn = [{ toolUse: { name: "query_sources", input: {} } }] as any;
    const script = Array.from({ length: 13 }, () => toolTurn);
    script.push([{ text: "Here is what I found." }]);
    const client = makeFakeClient(script);
    const { events, io } = collect();
    const res = await copilotTurn({
      client, draft: content, selectedKey: null, message: "dig around",
      thread: [], memories: [], ctx: ctx(), io,
    });
    expect(res.reply).toBe("Here is what I found.");
    expect(events.filter((e) => e.type === "text_delta").length).toBeGreaterThan(0);
    // Exactly 12 tool-executing rounds run before the wrap-up nudge fires.
    expect(events.filter((e) => e.type === "tool_activity").length).toBe(12);
  });

  it("hard-stops after one nudge when the model keeps calling tools forever", async () => {
    // The fake client repeats its last script entry forever, so every turn is a
    // tool call. After 12 tool rounds the loop nudges once; the next turn is
    // still a tool call, so the loop must terminate instead of re-nudging.
    const client = makeFakeClient([[{ toolUse: { name: "query_sources", input: {} } }]]);
    const { events, io } = collect();
    const res = await copilotTurn({
      client, draft: content, selectedKey: null, message: "loop forever",
      thread: [], memories: [], ctx: ctx(), io,
    });
    // Resolved (did not hang) with a bounded number of tool rounds.
    expect(res).toBeDefined();
    expect(events.filter((e) => e.type === "tool_activity").length).toBe(12);
  });

  const FAMILIES: FamilyInfo[] = [
    { id: "fam_rev", key: "revenue", label: "Revenue", kind: "periodic", granularity: "quarter", filedPeriods: ["2026-Q1", "2026-Q2"], hasLiveFile: false, bound: true },
    { id: "fam_ref", key: "pricebook", label: "Price book", kind: "constant", granularity: null, filedPeriods: [], hasLiveFile: true, bound: true },
    { id: "fam_un", key: "leftover", label: "Leftover", kind: "periodic", granularity: "month", filedPeriods: [], hasLiveFile: false, bound: false },
  ];

  it("query_sources with no args returns the family tree; unbound families under a trailer", async () => {
    const { client, toolResults } = recording([
      [{ toolUse: { name: "query_sources", input: {} } }],
      [{ text: "There you go." }],
    ]);
    const { io } = collect();
    await copilotTurn({
      client, draft: content, selectedKey: null, message: "what data is there",
      thread: [], memories: [], ctx: ctx({ families: FAMILIES }), io,
    });
    const tree = toolResults()[0];
    expect(tree).toContain("revenue · periodic · quarter · periods: 2026-Q1 ✓, 2026-Q2 ✓");
    expect(tree).toContain("pricebook · constant · live file ✓");
    expect(tree).toContain("Not bound to this blueprint:");
    expect(tree).toContain("leftover · periodic · month · no data yet");
    // Bound families precede the trailer, which precedes the unbound family.
    expect(tree.indexOf("revenue")).toBeLessThan(tree.indexOf("Not bound to this blueprint:"));
    expect(tree.indexOf("Not bound to this blueprint:")).toBeLessThan(tree.indexOf("leftover"));
  });

  it("query_sources inspects the default file by familyId, a period entry by {familyId, period}, and errors on an unknown period", async () => {
    const dir = mkdtempSync(join(tmpdir(), "copilot-src-"));
    writeFileSync(join(dir, "q1.csv"), "channel,amount\nsearch,100\n");
    writeFileSync(join(dir, "q2.csv"), "channel,amount\nsearch,250\n");
    const defaultFiles = [{ id: "fam_rev", name: "Revenue", mime: "text/csv", path: join(dir, "q2.csv") }];
    const periodFiles = [
      { familyId: "fam_rev", period: "2026-Q1", file: { id: "fam_rev", name: "Revenue", mime: "text/csv", path: join(dir, "q1.csv") } },
      { familyId: "fam_rev", period: "2026-Q2", file: { id: "fam_rev", name: "Revenue", mime: "text/csv", path: join(dir, "q2.csv") } },
    ];
    const { client, toolResults } = recording([
      [{ toolUse: { name: "query_sources", input: { familyId: "fam_rev", period: null } } }],
      [{ toolUse: { name: "query_sources", input: { familyId: "fam_rev", period: "2026-Q1" } } }],
      [{ toolUse: { name: "query_sources", input: { familyId: "fam_rev", period: "2026-Q4" } } }],
      [{ text: "Done inspecting." }],
    ]);
    const { io } = collect();
    await copilotTurn({
      client, draft: content, selectedKey: null, message: "inspect revenue",
      thread: [], memories: [], ctx: ctx({ families: FAMILIES, defaultFiles, periodFiles }), io,
    });
    const [def, q1, bad] = toolResults();
    expect(def).toContain("250"); // default resolution = latest period (Q2)
    expect(q1).toContain("100"); // period-addressed Q1
    expect(q1).not.toContain("250");
    expect(bad).toBe("Tool error: no file for revenue at 2026-Q4");
  });

  it("edit_section rejects familyIds not bound to the blueprint; the draft is unchanged", async () => {
    const { client, toolResults } = recording([
      [{ toolUse: { name: "edit_section", input: { key: "budget", patch: { familyIds: ["fam_unbound"] } } } }],
      [{ text: "That family is not bound." }],
    ]);
    const { events, io } = collect();
    const res = await copilotTurn({
      client, draft: content, selectedKey: null, message: "bind leftover",
      thread: [], memories: [], ctx: ctx({ families: FAMILIES }), io,
    });
    expect(toolResults()[0]).toBe("Tool error: family not bound to this blueprint: fam_unbound");
    expect(events.some((e) => e.type === "edit")).toBe(false);
    expect(res.draft.sections[1].familyIds).toEqual(["src_data"]); // unchanged
  });

  it("run_sql returns the executor's formatted result", async () => {
    const calls: string[] = [];
    const { client, toolResults } = recording([
      [{ toolUse: { name: "run_sql", input: { sql: "SELECT a, b FROM fam_x" } } }],
      [{ text: "Here are the rows." }],
    ]);
    const { io } = collect();
    await copilotTurn({
      client, draft: content, selectedKey: null, message: "run a query",
      thread: [], memories: [],
      ctx: ctx({ runSql: (sql: string) => { calls.push(sql); return "a | b\n1 | 2"; } }), io,
    });
    expect(calls).toEqual(["SELECT a, b FROM fam_x"]);
    expect(toolResults()[0]).toBe("a | b\n1 | 2");
  });

  it("run_sql result at core's cap passes through the clamp intact, truncation line and all", async () => {
    // formatSqlResult caps its output at 10_000 chars and appends a contractual
    // "… truncated at N of M rows" line. The loop's tool-result clamp must not
    // clip such a result — doing so would drop the truncation line and leave a
    // mangled trailing number the model could read as real data.
    const truncLine = "… truncated at 200 of 500 rows";
    const stub = "x".repeat(9_500 - truncLine.length) + truncLine;
    expect(stub.length).toBe(9_500);
    const { client, toolResults } = recording([
      [{ toolUse: { name: "run_sql", input: { sql: "SELECT * FROM fam_x" } } }],
      [{ text: "Here are the rows." }],
    ]);
    const { io } = collect();
    await copilotTurn({
      client, draft: content, selectedKey: null, message: "run a big query",
      thread: [], memories: [],
      ctx: ctx({ runSql: () => stub }), io,
    });
    expect(toolResults()[0]).toBe(stub);
    expect(toolResults()[0].endsWith(truncLine)).toBe(true);
  });

  it("run_sql failures surface as byte-exact Tool error strings", async () => {
    const { client, toolResults } = recording([
      [{ toolUse: { name: "run_sql", input: { sql: "SELECT 1" } } }],
      [{ text: "No data yet." }],
    ]);
    const { io } = collect();
    await copilotTurn({
      client, draft: content, selectedKey: null, message: "run a query",
      thread: [], memories: [],
      ctx: ctx({ runSql: () => { throw new Error("no data ingested yet"); } }), io,
    });
    expect(toolResults()[0]).toBe("Tool error: sql: no data ingested yet");
  });

  it("query_sources tree appends table lines for queryable families", async () => {
    const { client, toolResults } = recording([
      [{ toolUse: { name: "query_sources", input: {} } }],
      [{ text: "There you go." }],
    ]);
    const { io } = collect();
    await copilotTurn({
      client, draft: content, selectedKey: null, message: "what data is there",
      thread: [], memories: [],
      ctx: ctx({
        families: [famInfo({ key: "spend", bound: true })],
        catalog: [catFam({ key: "spend", queryable: true, tables: [{ name: "fam_spend", columns: [{ name: "amount", type: "REAL" }], rowCounts: { "2026-Q1": 2 } }] })],
      }), io,
    });
    const tree = toolResults()[0];
    expect(tree).toContain("spend · periodic");
    expect(tree).toContain("fam_spend(amount REAL)");
  });

  it("query_sources inspect on a queryable family returns schema + a 10-row sample via runSql", async () => {
    const calls: string[] = [];
    const cat = catFam({ id: "fam_1", key: "spend", queryable: true, tables: [{ name: "fam_spend", columns: [{ name: "amount", type: "REAL" }], rowCounts: { "2026-Q1": 2 } }] });
    const fams = [famInfo({ id: "fam_1", key: "spend", kind: "periodic", filedPeriods: ["2026-Q1"], bound: true })];
    const { client, toolResults } = recording([
      [{ toolUse: { name: "query_sources", input: { familyId: "fam_1", period: "2026-Q1" } } }],
      [{ toolUse: { name: "query_sources", input: { familyId: "fam_1", period: "2026-Q3" } } }],
      [{ text: "Done inspecting." }],
    ]);
    const { io } = collect();
    await copilotTurn({
      client, draft: content, selectedKey: null, message: "inspect spend",
      thread: [], memories: [],
      ctx: ctx({ families: fams, catalog: [cat], runSql: (sql: string) => { calls.push(sql); return "amount\n1"; } }), io,
    });
    expect(calls).toEqual(["SELECT * FROM fam_spend WHERE _period = '2026-Q1' LIMIT 10"]);
    const [ok, miss] = toolResults();
    expect(ok).toContain("amount\n1");
    expect(miss).toBe("Tool error: no file for spend at 2026-Q3");
  });

  it("compute still evaluates over the default pack (ids = family ids)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "copilot-compute-"));
    writeFileSync(join(dir, "q2.csv"), "channel,amount\nsearch,250\ndisplay,90\n");
    const defaultFiles = [{ id: "fam_rev", name: "Revenue", mime: "text/csv", path: join(dir, "q2.csv") }];
    const { client, toolResults } = recording([
      [{ toolUse: { name: "compute", input: { expression: "sum(fam_rev.amount)" } } }],
      [{ text: "Computed." }],
    ]);
    const { io } = collect();
    await copilotTurn({
      client, draft: content, selectedKey: null, message: "sum revenue",
      thread: [], memories: [], ctx: ctx({ families: FAMILIES, defaultFiles }), io,
    });
    expect(toolResults()[0]).toBe("340");
  });
});
