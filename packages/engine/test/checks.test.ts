import { describe, it, expect } from "vitest";
import { evaluateAssert, auditCitations, countCitations } from "../src/checks.js";
import type { SourcePack } from "../src/sourcePack.js";
import type { Block } from "@runoff/core";

const pack: SourcePack = { sources: [{
  id: "src_spend", label: "spend_june.csv", kind: "table", summary: "",
  tables: [{ name: "spend_june", columns: ["channel", "amount"], rows: [
    { channel: "search", amount: 120050 }, { channel: "social", amount: 120050 },
  ]}],
}]};

describe("evaluateAssert", () => {
  it("passes a true comparison with tolerance", () => {
    expect(evaluateAssert("sum(src_spend.amount) <= 250000", pack).pass).toBe(true);
    expect(evaluateAssert("sum(src_spend.amount) == 240000 within 1%", pack).pass).toBe(true);
    expect(evaluateAssert("count(src_spend.channel) == 3", pack).pass).toBe(false);
  });
  it("reports unparseable expressions as failures", () => {
    const r = evaluateAssert("spend looks reasonable", pack);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("unparseable");
  });
});

describe("auditCitations", () => {
  const cited: Block[] = [{ type: "paragraph", spans: [
    { text: "Total spend was " },
    { text: "$240,100", citation: { sourceId: "src_spend", locator: "sum(src_spend.amount)" } },
  ]}];
  it("passes cited + recomputable figures", () => {
    expect(auditCitations(cited, pack, ["src_spend"]).pass).toBe(true);
    expect(countCitations(cited)).toBe(1);
  });
  it("fails uncited figures and mismatched recomputation", () => {
    const uncited: Block[] = [{ type: "paragraph", spans: [{ text: "Spend was $999,999." }] }];
    expect(auditCitations(uncited, pack, ["src_spend"]).pass).toBe(false);
    const wrong: Block[] = [{ type: "paragraph", spans: [
      { text: "$999,999", citation: { sourceId: "src_spend", locator: "sum(src_spend.amount)" } },
    ]}];
    const r = auditCitations(wrong, pack, ["src_spend"]);
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toContain("mismatch");
  });
});
