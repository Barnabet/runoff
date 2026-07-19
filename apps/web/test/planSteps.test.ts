import { describe, it, expect } from "vitest";
import type { ParsePlan } from "@runoff/core";
import { renderPlanSteps } from "../lib/planSteps";

// A plan exercising every feature: anchor, 2-row header, exclude with a named
// column and a null (any-cell) column, plain + parsed columns, unpivot, and a
// period check in both `keep` and `exclude` modes across two tables.
const PLAN: ParsePlan = {
  version: 1,
  tables: [
    {
      name: "aging",
      anchor: { sheet: "ar_aging", headerSignature: ["customer", "status", "amount due ($)"], minMatch: 2 },
      headerRows: 2,
      exclude: [
        { column: "status", pattern: "^total" },
        { column: null, pattern: "subtotal" },
      ],
      columns: [
        { from: "customer", name: "customer", type: "TEXT" },
        { from: "amount due ($)", name: "amount_due", type: "REAL", parse: "currency" },
        { from: "as of", name: "as_of", type: "TEXT", parse: "date" },
      ],
      periodColumn: "as_of",
      onPeriodMismatch: "keep",
    },
    {
      name: "regions",
      anchor: { headerSignature: ["region"], minMatch: 1 },
      headerRows: 1,
      exclude: [],
      columns: [
        { from: "region", name: "region", type: "TEXT" },
        { from: "period", name: "period_date", type: "TEXT", parse: "date" },
      ],
      unpivot: {
        keep: ["region"],
        valuePattern: "q[1-4]",
        keyColumn: "quarter",
        valueColumn: "amount",
        valueType: "REAL",
      },
      periodColumn: "period_date",
      onPeriodMismatch: "exclude",
    },
  ],
};

describe("renderPlanSteps", () => {
  it("renders the pinned plain-language line array for every plan feature", () => {
    expect(renderPlanSteps(PLAN)).toEqual([
      "table aging: anchored by 3-cell header signature (min 2)",
      "header: rows 1–2 merged",
      "excluding rows where status matches /^total/i",
      "excluding rows where any cell matches /subtotal/i",
      "customer → customer (TEXT)",
      "amount due ($) → amount_due (currency)",
      "as of → as_of (date)",
      "period check: as_of vs slot (keep mismatches)",
      "table regions: anchored by 1-cell header signature (min 1)",
      "header: 1 row",
      "region → region (TEXT)",
      "period → period_date (date)",
      "unpivot: headers matching /q[1-4]/i → quarter/amount",
      "period check: period_date vs slot (exclude mismatches)",
    ]);
  });
});
