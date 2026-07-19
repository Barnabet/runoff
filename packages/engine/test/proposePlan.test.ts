import { describe, it, expect, vi } from "vitest";
import { buildGridSample, proposeParsePlan, isDegenerate } from "../src/proposePlan.js";
import type { ExecReport, ParsePlan } from "@runoff/core";

const VALID: ParsePlan = {
  version: 1,
  tables: [{
    name: "aging",
    anchor: { headerSignature: ["customer", "amount"], minMatch: 2 },
    headerRows: 1, exclude: [], columns: [
      { from: "customer", name: "customer", type: "TEXT" },
      { from: "amount", name: "amount", type: "REAL", parse: "currency" },
    ],
    onPeriodMismatch: "keep",
  }],
};

const clientReturning = (...bodies: string[]) => {
  const create = vi.fn();
  for (const b of bodies) create.mockResolvedValueOnce({ choices: [{ message: { content: b } }] });
  return { client: { chat: { completions: { create } } } as any, create };
};

describe("buildGridSample", () => {
  it("renders sheets with dimensions, numbered rows, truncated cells, and hints; caps at 6000 chars", () => {
    const grids = [{ sheet: "ar_aging", grid: [["a".repeat(50), "b"], ["c", 12]] }];
    const s = buildGridSample(grids, "### detector says hi");
    expect(s).toContain("## sheet: ar_aging (2×2)");
    expect(s).toContain(`R1: ${"a".repeat(20)} | b`);
    expect(s).toContain("R2: c | 12");
    expect(s).toContain("## detector hints");
    expect(s.length).toBeLessThanOrEqual(6000);
  });
});

describe("proposeParsePlan", () => {
  it("returns a validated plan", async () => {
    const { client } = clientReturning(JSON.stringify(VALID));
    const p = await proposeParsePlan({ client, filename: "f.xlsx", gridSample: "s" });
    expect(p).toEqual(VALID);
  });

  it("retries once on invalid output, then null", async () => {
    const { client, create } = clientReturning("{\"nope\":1}", "not json");
    const p = await proposeParsePlan({ client, filename: "f.xlsx", gridSample: "s" });
    expect(p).toBeNull();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("zod-valid but structurally invalid plans (validateParsePlan) also trigger the retry", async () => {
    const dupe = { version: 1, tables: [VALID.tables[0], VALID.tables[0]] };
    const { client, create } = clientReturning(JSON.stringify(dupe), JSON.stringify(VALID));
    const p = await proposeParsePlan({ client, filename: "f.xlsx", gridSample: "s" });
    expect(p).toEqual(VALID);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("amendment context reaches the prompt", async () => {
    const { client, create } = clientReturning(JSON.stringify(VALID));
    await proposeParsePlan({
      client, filename: "f.xlsx", gridSample: "s",
      existingPlan: VALID, fitDetail: ["missing column: aging.amount"], feedback: "amount is now amount_usd",
    });
    const messages = create.mock.calls[0][0].messages;
    const sys = messages[0].content as string;
    const usr = messages[1].content as string;
    expect(sys).toContain("MUST keep every existing logical table name and canonical column name");
    expect(usr).toContain("missing column: aging.amount");
    expect(usr).toContain("amount is now amount_usd");
  });
});

describe("isDegenerate", () => {
  const base: ExecReport["tables"][number] = {
    name: "t", anchor: { sheet: "s", row: 0 }, problems: [], rowsKept: 5,
    rowsExcluded: [], coercionFailures: [], periodMismatches: null, unknownColumns: [],
  };
  it("clean report is not degenerate", () => {
    expect(isDegenerate({ tables: [base] })).toBe(false);
  });
  it("problems, zero kept rows, or a 100%-failure column are degenerate", () => {
    expect(isDegenerate({ tables: [{ ...base, problems: ["unanchored table: t"] }] })).toBe(true);
    expect(isDegenerate({ tables: [{ ...base, rowsKept: 0 }] })).toBe(true);
    expect(isDegenerate({ tables: [{ ...base, rowsKept: 3, coercionFailures: [{ column: "v", count: 3, samples: [] }] }] })).toBe(true);
    expect(isDegenerate({ tables: [{ ...base, rowsKept: 4, coercionFailures: [{ column: "v", count: 3, samples: [] }] }] })).toBe(false);
  });
});
