import { describe, expect, it, vi } from "vitest";
import type { RunDocument } from "@runoff/core";
import { bindGolden, renderDocForBinding } from "../src/bindGolden.js";

const DOC: RunDocument = { title: "AR", eyebrow: "", dateline: "", sections: [
  { key: "summary", heading: "Summary", blocks: [
    { type: "paragraph", spans: [{ text: "Total " }, { text: "$4.2M" }] },
    { type: "table", columns: ["status", "total"], rows: [{ cells: [[{ text: "open" }], [{ text: "1" }]] }] },
  ] } ] };
const CATALOG = [{ id: "fam_ar", key: "ar", label: "AR", kind: "periodic", granularity: "quarter",
  queryable: true, tables: [{ name: "fam_ar", columns: [{ name: "amount", type: "REAL" }], rowCounts: { "2026-Q1": 10 } }], filedPeriods: ["2026-Q1"] }] as never;

const ITEMS = [
  { id: "total", kind: "value", anchor: { sectionKey: "summary", blockIndex: 0, spanIndex: 1 },
    raw: "$4.2M", parsed: 4200000, binding: { familyId: "fam_ar", sql: "SELECT SUM(amount) FROM fam_ar WHERE _period = :period" }, reason: null },
];
const toolMsg = (name: string, args: object) => ({
  choices: [{ finish_reason: "tool_calls", message: { content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
});
const client = (...responses: object[]) => {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(r);
  return { client: { chat: { completions: { create } } } as never, create };
};

describe("renderDocForBinding", () => {
  it("exposes anchors: section keys, block and span indexes", () => {
    const out = renderDocForBinding(DOC);
    expect(out).toContain("## section: summary");
    expect(out).toContain('[b0.s1] "$4.2M"');
    expect(out).toContain("[b1] table (2 cols × 1 rows): status | total");
  });
});

describe("bindGolden", () => {
  it("runs sql probes then accepts a valid submit", async () => {
    const { client: c, create } = client(
      toolMsg("run_sql", { sql: "SELECT SUM(amount) FROM fam_ar WHERE _period = :period" }),
      toolMsg("submit_inventory", { version: 1, items: ITEMS }),
    );
    const runSql = vi.fn().mockReturnValue("v\n4215332");
    const out = await bindGolden({ client: c, catalog: CATALOG, runSql, document: DOC, period: "2026-Q1", siblings: [] });
    expect(out?.items[0].id).toBe("total");
    expect(runSql).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
  });
  it("invalid submit gets a byte-exact tool error and the loop continues", async () => {
    const bad = [{ ...ITEMS[0], anchor: { sectionKey: "nope", blockIndex: 0, spanIndex: 1 } }];
    const { client: c, create } = client(
      toolMsg("submit_inventory", { version: 1, items: bad }),
      toolMsg("submit_inventory", { version: 1, items: ITEMS }),
    );
    const out = await bindGolden({ client: c, catalog: CATALOG, runSql: vi.fn(), document: DOC, period: "2026-Q1", siblings: [] });
    expect(out).not.toBeNull();
    const secondCallMessages = create.mock.calls[1][0].messages;
    const toolResult = secondCallMessages.findLast((m: { role: string }) => m.role === "tool");
    expect(toolResult.content).toBe("Tool error: invalid inventory: unknown section: nope");
  });
  it("sibling patterns, prior inventory, and feedback reach the prompt", async () => {
    const { client: c, create } = client(toolMsg("submit_inventory", { version: 1, items: ITEMS }));
    await bindGolden({
      client: c, catalog: CATALOG, runSql: vi.fn(), document: DOC, period: "2026-Q2",
      siblings: [{ period: "2026-Q1", inventory: { version: 1, items: [{ ...ITEMS[0],
        binding: { ...ITEMS[0].binding, verifiedValue: 4215332, status: "bound" } }] } as never }],
      priorInventory: { version: 1, items: ITEMS } as never, feedback: "the count is wrong",
    });
    const sys = String(create.mock.calls[0][0].messages[0].content);
    expect(sys).toContain("verified binding patterns");
    expect(sys).toContain("SELECT SUM(amount) FROM fam_ar WHERE _period = :period");
    expect(sys).toContain("the count is wrong");
    expect(sys).toContain("keep existing item ids");
  });
  it("returns null after cap + nudge without a valid submit", async () => {
    const probe = toolMsg("run_sql", { sql: "SELECT 1" });
    const { client: c, create } = client(...Array.from({ length: 18 }, () => probe));
    const out = await bindGolden({ client: c, catalog: CATALOG, runSql: vi.fn().mockReturnValue("ok"), document: DOC, period: null, siblings: [] });
    expect(out).toBeNull();
    expect(create.mock.calls.length).toBeLessThanOrEqual(18); // 16 rounds + nudge round, hard stop
  });
  it("client throw yields null", async () => {
    const create = vi.fn().mockRejectedValue(new Error("boom"));
    const out = await bindGolden({ client: { chat: { completions: { create } } } as never, catalog: CATALOG,
      runSql: vi.fn(), document: DOC, period: null, siblings: [] });
    expect(out).toBeNull();
  });
});
