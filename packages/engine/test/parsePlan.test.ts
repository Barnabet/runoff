import { describe, it, expect } from "vitest";
import { executeParsePlan, fitParsePlan, type SheetGrid } from "../src/parsePlan.js";
import type { ParsePlan } from "@runoff/core";

const g = (sheet: string, grid: unknown[][]): SheetGrid => ({ sheet, grid });

const AGING: ParsePlan = {
  version: 1,
  tables: [{
    name: "aging",
    anchor: { sheet: "ar_aging", headerSignature: ["customer", "status", "amount due ($)"], minMatch: 2 },
    headerRows: 1,
    exclude: [{ column: "customer", pattern: "^grand total$" }],
    columns: [
      { from: "customer", name: "customer", type: "TEXT" },
      { from: "status", name: "status", type: "TEXT" },
      { from: "amount due ($)", name: "amount_due", type: "REAL" },
    ],
    onPeriodMismatch: "keep",
  }],
};

const MESSY_GRID: unknown[][] = [
  ["AR Aging Report — Q2 2026"],                       // glued title, no blank row below
  ["Customer", "Status", "Amount Due ($)"],
  ["Acme", "open", 1200],
  ["Beta", "paid", 800],
  ["Customer", "Status", "Amount Due ($)"],            // repeated page header
  ["Gamma", "open", 400],
  ["Grand Total", "", 2400],
];

describe("anchoring + region", () => {
  it("anchors by signature past a glued title; title never corrupts the header", () => {
    const { tables, report } = executeParsePlan([g("ar_aging", MESSY_GRID)], AGING, null, null);
    expect(report.tables[0].anchor).toEqual({ sheet: "ar_aging", row: 1 });
    expect(tables[0].columns.map((c) => c.name)).toEqual(["customer", "status", "amount_due"]);
    expect(report.tables[0].problems).toEqual([]);
  });

  it("drops repeated headers and excluded totals, counting them with samples", () => {
    const { tables, report } = executeParsePlan([g("ar_aging", MESSY_GRID)], AGING, null, null);
    expect(tables[0].rows.map((r) => r[0])).toEqual(["Acme", "Beta", "Gamma"]);
    expect(report.tables[0].rowsKept).toBe(3);
    expect(report.tables[0].rowsExcluded).toEqual([
      { pattern: "^grand total$", count: 1, samples: ["Grand Total |  | 2400"] },
    ]);
  });

  it("anchors on a renamed sheet (hint mismatch is not a failure)", () => {
    const { report } = executeParsePlan([g("totally_new_name", MESSY_GRID)], AGING, null, null);
    expect(report.tables[0].anchor).toEqual({ sheet: "totally_new_name", row: 1 });
  });

  it("region ends at 2 consecutive blank rows", () => {
    const grid = [
      ["Customer", "Status", "Amount Due ($)"],
      ["Acme", "open", 1],
      [null, null, null],
      [null, null, null],
      ["Footer note that is not data", "", ""],
    ];
    const { tables } = executeParsePlan([g("s", grid)], AGING, null, null);
    expect(tables[0].rows).toHaveLength(1);
  });

  it("single blank row inside a table is skipped, not terminal", () => {
    const grid = [
      ["Customer", "Status", "Amount Due ($)"],
      ["Acme", "open", 1],
      [null, null, null],
      ["Beta", "paid", 2],
    ];
    const { tables } = executeParsePlan([g("s", grid)], AGING, null, null);
    expect(tables[0].rows).toHaveLength(2);
  });

  it("merges 2-row headers before matching columns", () => {
    const plan: ParsePlan = {
      version: 1,
      tables: [{
        name: "t",
        anchor: { headerSignature: ["region"], minMatch: 1 },
        headerRows: 2,
        exclude: [],
        columns: [
          { from: "region", name: "region", type: "TEXT" },
          { from: "2026 q1", name: "q1", type: "REAL" },
        ],
        onPeriodMismatch: "keep",
      }],
    };
    const grid = [
      ["Region", "2026", null],
      [null, "Q1", "Q2"],
      ["EMEA", 10, 20],
    ];
    const { tables, report } = executeParsePlan([g("s", grid)], plan, null, null);
    expect(tables[0].rows).toEqual([["EMEA", 10]]);
    expect(report.tables[0].unknownColumns).toEqual(["Q2"]);
  });

  it("region stops where another table's anchor begins", () => {
    const plan: ParsePlan = {
      version: 1,
      tables: [
        { name: "a", anchor: { headerSignature: ["region", "revenue"], minMatch: 2 }, headerRows: 1, exclude: [],
          columns: [{ from: "region", name: "region", type: "TEXT" }, { from: "revenue", name: "revenue", type: "REAL" }], onPeriodMismatch: "keep" },
        { name: "b", anchor: { headerSignature: ["channel", "share"], minMatch: 2 }, headerRows: 1, exclude: [],
          columns: [{ from: "channel", name: "channel", type: "TEXT" }, { from: "share", name: "share", type: "REAL" }], onPeriodMismatch: "keep" },
      ],
    };
    const grid = [
      ["Region", "Revenue"],
      ["EMEA", 10],
      ["Channel", "Share"],   // no blank row between the tables
      ["online", 0.6],
    ];
    const { tables } = executeParsePlan([g("s", grid)], plan, null, null);
    expect(tables[0].rows).toEqual([["EMEA", 10]]);
    expect(tables[1].rows).toEqual([["online", 0.6]]);
  });
});

describe("problems", () => {
  it("unanchored table produces no rows and the byte-exact problem line", () => {
    const { tables, report } = executeParsePlan([g("s", [["nothing", "here"]])], AGING, null, null);
    expect(report.tables[0].problems).toEqual(["unanchored table: aging"]);
    expect(tables[0].rows).toEqual([]);
  });

  it("missing mapped column is a problem; table yields no rows", () => {
    const grid = [["Customer", "Status"], ["Acme", "open"]];
    const { tables, report } = executeParsePlan([g("s", grid)], AGING, null, null);
    expect(report.tables[0].problems).toEqual(["missing column: aging.amount due ($)"]);
    expect(tables[0].rows).toEqual([]);
  });
});

describe("fitParsePlan", () => {
  it("fit / partial / no_fit with byte-exact detail", () => {
    expect(fitParsePlan([g("ar_aging", MESSY_GRID)], AGING).verdict).toBe("fit");
    const partial = fitParsePlan([g("s", [["Customer", "Status"], ["x", "y"]])], AGING);
    expect(partial.verdict).toBe("partial");
    expect(partial.detail).toContain("missing column: aging.amount due ($)");
    const nofit = fitParsePlan([g("s", [["a", "b"], ["c", "d"]])], AGING);
    expect(nofit.verdict).toBe("no_fit");
    expect(nofit.detail).toContain("unanchored table: aging");
  });

  it("reports unknown columns as info without degrading fit", () => {
    const grid = [["Customer", "Status", "Amount Due ($)", "Mystery"], ["a", "b", 1, 2]];
    const fit = fitParsePlan([g("s", grid)], AGING);
    expect(fit.verdict).toBe("fit");
    expect(fit.detail).toContain("unknown column: Mystery");
  });
});
