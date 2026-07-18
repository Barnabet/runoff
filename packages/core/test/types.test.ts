import { describe, it, expect } from "vitest";
import { BlueprintContentSchema } from "../src/types/blueprint.js";
import { blocksToPlainText, countWords, type Block } from "../src/types/document.js";

describe("domain types", () => {
  it("validates a blueprint content document", () => {
    const bp = {
      title: "Monthly Performance Report", clientName: "Meridian Retail Group",
      eyebrow: "PREPARED FOR MERIDIAN RETAIL GROUP · JULY 2026", dateline: "July 2026",
      sections: [{ key: "exec", number: 2, heading: "Executive summary", mode: "review",
        instruction: "Summarize the month.", familyIds: ["src_a"],
        rules: [{ kind: "assert", text: "spend within budget", expression: "sum(src_a.spend) <= 250000" }] }],
      globalRules: ["Cite every figure."],
      delivery: { recipient: "reports@meridianretail.com", autoDeliverOnClear: true },
    };
    expect(BlueprintContentSchema.parse(bp).sections[0].mode).toBe("review");
  });

  it("counts words and flattens blocks", () => {
    const blocks: Block[] = [
      { type: "paragraph", spans: [{ text: "Sessions rose " }, { text: "12.4%", citation: { sourceId: "src_a", locator: "sum(src_a.sessions)" } }] },
      { type: "table", columns: ["Metric", "Value"], rows: [{ cells: [[{ text: "Spend" }], [{ text: "240,100" }]] }] },
    ];
    expect(countWords(blocks)).toBeGreaterThan(3);
    expect(blocksToPlainText(blocks)).toContain("12.4%");
  });
});
