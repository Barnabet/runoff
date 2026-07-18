import { describe, it, expect } from "vitest";
import { parseSectionText, spansFromInline } from "../src/dialect.js";

describe("dialect parser", () => {
  it("parses citation markers into cited spans", () => {
    const spans = spansFromInline("Sessions rose [[12.4%|src_ga4|sum(src_ga4.sessions)]] month over month.");
    expect(spans).toEqual([
      { text: "Sessions rose " },
      { text: "12.4%", citation: { sourceId: "src_ga4", locator: "sum(src_ga4.sessions)" } },
      { text: " month over month." },
    ]);
  });

  it("parses paragraphs and tables", () => {
    const raw = [
      "Revenue held steady at [[$1.2M|src_crm|sum(src_crm.revenue)]].",
      "",
      "| Metric | Value |",
      "| --- | --- |",
      "| Spend | [[240,100|src_spend|sum(src_spend.amount)]] |",
    ].join("\n");
    const blocks = parseSectionText(raw);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("paragraph");
    const table = blocks[1];
    if (table.type !== "table") throw new Error("expected table");
    expect(table.columns).toEqual(["Metric", "Value"]);
    expect(table.rows[0].cells[1][0].citation?.sourceId).toBe("src_spend");
  });
});
