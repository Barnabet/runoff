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

  // Task 9 embeds these failure strings verbatim in retry feedback — pin their prefixes.
  it("pins the uncited-figure failure prefix", () => {
    const uncited: Block[] = [{ type: "paragraph", spans: [{ text: "Spend was $999,999." }] }];
    const r = auditCitations(uncited, pack, ["src_spend"]);
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/^uncited figure: /);
  });

  it("pins the unbound-source failure prefix", () => {
    const unbound: Block[] = [{ type: "paragraph", spans: [
      { text: "$240,100", citation: { sourceId: "src_other", locator: "x" } },
    ]}];
    const r = auditCitations(unbound, pack, ["src_spend"]);
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/^figure cites unbound source src_other: /);
  });

  it("does not read digits embedded in identifiers like GA4 as figures", () => {
    // "GA4 recorded…" flagged "uncited figure: 4" in a live run — the 4 belongs to the word.
    const blocks: Block[] = [{ type: "paragraph", spans: [
      { text: "GA4 recorded strong Q2 growth across channels." },
    ]}];
    expect(auditCitations(blocks, pack, ["src_spend"]).pass).toBe(true);
  });

  it("fails a cited span whose text carries no figure, with a pinned prefix", () => {
    // A live retry produced [[figure|src|max]] — placeholder text rendered to the reader.
    const blocks: Block[] = [{ type: "paragraph", spans: [
      { text: "figure", citation: { sourceId: "src_spend", locator: "max" } },
    ]}];
    const r = auditCitations(blocks, pack, ["src_spend"]);
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/^cited span has no figure: /);
  });

  it("audits citations inside table cells but not header columns", () => {
    // A digit in a header column ("Q2 Value") must NOT be flagged; a cell figure must be.
    const cited: Block[] = [{ type: "table", columns: ["Metric", "Q2 Value"], rows: [
      { cells: [
        [{ text: "Total" }],
        [{ text: "$240,100", citation: { sourceId: "src_spend", locator: "sum(src_spend.amount)" } }],
      ] },
    ]}];
    expect(auditCitations(cited, pack, ["src_spend"]).pass).toBe(true);
    expect(countCitations(cited)).toBe(1);

    const uncited: Block[] = [{ type: "table", columns: ["Metric", "Value"], rows: [
      { cells: [ [{ text: "Total" }], [{ text: "$240,100" }] ] },
    ]}];
    const r = auditCitations(uncited, pack, ["src_spend"]);
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/^uncited figure: /);
  });
});

describe("aggregation type guard", () => {
  // CSV/XLSX parsing can leak null/boolean into numeric columns — they must not corrupt sums.
  const leaky: SourcePack = { sources: [{
    id: "src_spend", label: "spend.csv", kind: "table", summary: "",
    tables: [{ name: "spend", columns: ["channel", "amount"], rows: [
      { channel: "search", amount: 120050 },
      { channel: "social", amount: 120050 },
      { channel: null as unknown as string, amount: null as unknown as number },
      { channel: "promo", amount: true as unknown as number },
    ]}],
  }]};

  it("ignores null/boolean cells in sum and avg", () => {
    expect(evaluateAssert("sum(src_spend.amount) == 240100", leaky).pass).toBe(true);
    expect(evaluateAssert("avg(src_spend.amount) == 120050", leaky).pass).toBe(true);
    expect(evaluateAssert("max(src_spend.amount) == 120050", leaky).pass).toBe(true);
    // count counts non-empty cells: 3 non-null channels ("search", "social", "promo").
    expect(evaluateAssert("count(src_spend.channel) == 3", leaky).pass).toBe(true);
  });
});
