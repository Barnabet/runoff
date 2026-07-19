import { describe, it, expect } from "vitest";
import { BlueprintContentSchema, BlueprintSectionSchema, RuleSchema, SectionQuerySchema } from "../src/types/blueprint.js";
import { blocksToPlainText, countWords, type Block } from "../src/types/document.js";

describe("domain types", () => {
  it("validates a blueprint content document", () => {
    const bp = {
      title: "Monthly Performance Report", clientName: "Meridian Retail Group",
      eyebrow: "PREPARED FOR MERIDIAN RETAIL GROUP · JULY 2026", dateline: "July 2026",
      sections: [{ key: "exec", number: 2, heading: "Executive summary", mode: "review",
        instruction: "Summarize the month.", familyIds: ["src_a"], queries: [],
        rules: [{ kind: "assert", text: "spend within budget", sql: "SELECT SUM(spend) FROM fam_src_a", op: "<=", value: 250000 }] }],
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

const baseSection = {
  key: "s1", number: 1, heading: "H", mode: "auto", instruction: "i",
  familyIds: [], rules: [], queries: [],
};

describe("v1.3b blueprint schema", () => {
  it("requires queries on sections (empty array ok)", () => {
    expect(BlueprintSectionSchema.safeParse(baseSection).success).toBe(true);
    const { queries: _q, ...withoutQueries } = baseSection;
    expect(BlueprintSectionSchema.safeParse(withoutQueries).success).toBe(false);
  });

  it("validates query names as identifiers", () => {
    expect(SectionQuerySchema.safeParse({ name: "total_paid", sql: "SELECT 1" }).success).toBe(true);
    expect(SectionQuerySchema.safeParse({ name: "Total Paid", sql: "SELECT 1" }).success).toBe(false);
    expect(SectionQuerySchema.safeParse({ name: "2total", sql: "SELECT 1" }).success).toBe(false);
  });

  it("accepts SQL assert rules and rejects the old expression field via strictness of use", () => {
    expect(RuleSchema.safeParse({ kind: "assert", text: "t", sql: "SELECT 1", op: ">", value: 0 }).success).toBe(true);
    expect(RuleSchema.safeParse({ kind: "style", text: "t" }).success).toBe(true);
    // expression is no longer part of the schema shape (zod strips unknown keys;
    // assert the parsed output does not carry it)
    const parsed = RuleSchema.parse({ kind: "assert", text: "t", sql: "SELECT 1", op: ">", value: 0, expression: "sum(x.y) > 0" });
    expect("expression" in parsed).toBe(false);
  });
});
