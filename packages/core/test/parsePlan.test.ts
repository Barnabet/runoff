import { describe, it, expect } from "vitest";
import {
  ParsePlanSchema, validateParsePlan, planTableName,
  ClassifyProposalSchema, type ParsePlan,
} from "../src/index.js";

const PLAN: ParsePlan = {
  version: 1,
  tables: [
    {
      name: "aging",
      anchor: { sheet: "ar_aging", headerSignature: ["customer", "status", "amount due ($)"], minMatch: 2 },
      headerRows: 1,
      exclude: [{ column: "customer", pattern: "^grand total$" }],
      columns: [
        { from: "customer", name: "customer", type: "TEXT" },
        { from: "amount due ($)", name: "amount_due", type: "REAL", parse: "currency" },
      ],
      onPeriodMismatch: "keep",
    },
  ],
};

describe("ParsePlanSchema", () => {
  it("accepts a valid plan and defaults onPeriodMismatch", () => {
    const { onPeriodMismatch, ...rest } = PLAN.tables[0];
    const r = ParsePlanSchema.safeParse({ version: 1, tables: [rest] });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.tables[0].onPeriodMismatch).toBe("keep");
  });

  it("rejects bad logical names and _period canonicals", () => {
    expect(ParsePlanSchema.safeParse({
      version: 1,
      tables: [{ ...PLAN.tables[0], name: "Bad Name" }],
    }).success).toBe(false);
  });
});

describe("validateParsePlan", () => {
  it("passes the reference plan", () => {
    expect(() => validateParsePlan(PLAN)).not.toThrow();
  });

  it("rejects duplicate table names", () => {
    expect(() => validateParsePlan({ version: 1, tables: [PLAN.tables[0], PLAN.tables[0]] }))
      .toThrow("duplicate table name: aging");
  });

  it("rejects duplicate canonical or from per table", () => {
    const t = { ...PLAN.tables[0], columns: [...PLAN.tables[0].columns, { from: "x", name: "customer", type: "TEXT" as const }] };
    expect(() => validateParsePlan({ version: 1, tables: [t] })).toThrow("duplicate column name: aging.customer");
  });

  it("rejects _period canonical", () => {
    const t = { ...PLAN.tables[0], columns: [{ from: "p", name: "_period", type: "TEXT" as const }] };
    expect(() => validateParsePlan({ version: 1, tables: [t] })).toThrow();
  });

  it("rejects unknown references and non-date periodColumn", () => {
    expect(() => validateParsePlan({
      version: 1,
      tables: [{ ...PLAN.tables[0], exclude: [{ column: "nope", pattern: "x" }] }],
    })).toThrow("unknown column reference: aging.nope");
    expect(() => validateParsePlan({
      version: 1,
      tables: [{ ...PLAN.tables[0], periodColumn: "customer" }],
    })).toThrow("periodColumn must have parse \"date\": aging.customer");
  });

  it("rejects invalid regex patterns", () => {
    expect(() => validateParsePlan({
      version: 1,
      tables: [{ ...PLAN.tables[0], exclude: [{ column: null, pattern: "(" }] }],
    })).toThrow("invalid pattern: aging.(");
  });
});

describe("planTableName", () => {
  it("single-table plan collapses to fam_<key>", () => {
    expect(planTableName("ar_aging", PLAN, "aging")).toBe("fam_ar_aging");
  });
  it("multi-table plan suffixes the logical name", () => {
    const multi = { version: 1 as const, tables: [PLAN.tables[0], { ...PLAN.tables[0], name: "totals" }] };
    expect(planTableName("ar_aging", multi, "totals")).toBe("fam_ar_aging__totals");
  });
});

describe("ClassifyProposal plan fields", () => {
  it("accepts plan/planStatus/preview/report", () => {
    const r = ClassifyProposalSchema.safeParse({
      familyKey: "ar_aging", period: "2026-Q2", confidence: "high",
      plan: PLAN, planStatus: "proposed",
      preview: { tables: [{ name: "aging", columns: ["customer"], rows: [["Acme"]] }] },
      report: { tables: [{ name: "aging", anchor: { sheet: "ar_aging", row: 2 }, problems: [], rowsKept: 6, rowsExcluded: [], coercionFailures: [], periodMismatches: null, unknownColumns: [] }] },
    });
    expect(r.success).toBe(true);
  });
});
