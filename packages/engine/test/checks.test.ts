import { describe, it, expect } from "vitest";
import type { Rule, Block } from "@runoff/core";
import { compileLocator, evaluateAssert, auditCitations, countCitations } from "../src/checks.js";
import type { RunData } from "../src/runData.js";
import { parseSectionText } from "../src/dialect.js";

const CATALOG = [
  {
    id: "famA", key: "ar", label: "AR", kind: "periodic" as const, granularity: "quarter" as const,
    queryable: true, filedPeriods: ["2026-Q1"],
    tables: [{ name: "fam_ar", columns: [{ name: "amount", type: "REAL" as const }, { name: "status", type: "TEXT" as const }], rowCounts: { "2026-Q1": 3 } }],
  },
  {
    id: "famC", key: "ref", label: "Ref", kind: "constant" as const, granularity: null,
    queryable: true, filedPeriods: [],
    tables: [{ name: "fam_ref", columns: [{ name: "share", type: "REAL" as const }], rowCounts: { "": 2 } }],
  },
];

function dataReturning(value: unknown, capture?: string[]): RunData {
  return { catalog: CATALOG, exec: (sql) => { capture?.push(sql); return { columns: ["v"], rows: [[value]] }; } };
}

describe("compileLocator", () => {
  it("compiles a periodic sum with a string filter", () => {
    const { sql, family } = compileLocator("sum(fam_ar.amount where status=paid)", CATALOG);
    expect(family.id).toBe("famA");
    expect(sql).toBe(`SELECT COALESCE(SUM("amount"), 0) FROM "fam_ar" WHERE _period = :period AND lower(CAST("status" AS TEXT)) = lower('paid')`);
  });

  it("numeric filter values get the numeric OR-branch", () => {
    const { sql } = compileLocator("count(fam_ar.amount where status=42)", CATALOG);
    expect(sql).toBe(`SELECT COUNT("amount") FROM "fam_ar" WHERE _period = :period AND ("status" = 42 OR lower(CAST("status" AS TEXT)) = lower('42'))`);
  });

  it("constant tables get no _period clause; count has no COALESCE", () => {
    const { sql } = compileLocator("count(fam_ref.share)", CATALOG);
    expect(sql).toBe(`SELECT COUNT("share") FROM "fam_ref"`);
  });

  it("escapes single quotes in filter values", () => {
    const { sql } = compileLocator("sum(fam_ar.amount where status=o'brien)", CATALOG);
    expect(sql).toContain(`lower('o''brien')`);
  });

  it("throws on a table not in the catalog", () => {
    expect(() => compileLocator("sum(fam_nope.amount)", CATALOG)).toThrow();
  });
});

describe("evaluateAssert (SQL)", () => {
  const rule = (over: Partial<Rule>): Rule => ({ kind: "assert", text: "t", sql: "SELECT SUM(amount) FROM fam_ar WHERE _period = :period", op: ">", value: 0, ...over });

  it("passes and formats the detail from the SQL", () => {
    const out = evaluateAssert(rule({}), dataReturning(1204));
    expect(out.pass).toBe(true);
    expect(out.detail).toBe("SELECT SUM(amount) FROM fam_ar WHERE _period = :period = 1,204 (expected > 0) — pass");
  });

  it("fails with withinPct tolerance semantics", () => {
    const out = evaluateAssert(rule({ op: "==", value: 1000, withinPct: 5 }), dataReturning(1100));
    expect(out.pass).toBe(false);
    expect(out.detail).toContain("within 5%");
  });

  it("missing sql/op/value fails byte-exact", () => {
    expect(evaluateAssert({ kind: "assert", text: "t" }, dataReturning(1)).detail).toBe("assert rule is missing sql/op/value");
  });

  it("non-scalar results fail byte-exact", () => {
    const data: RunData = { catalog: CATALOG, exec: () => ({ columns: ["a", "b"], rows: [[1, 2]] }) };
    expect(evaluateAssert(rule({}), data).detail).toBe("check query must return one numeric value");
    const empty: RunData = { catalog: CATALOG, exec: () => ({ columns: ["a"], rows: [] }) };
    expect(evaluateAssert(rule({}), empty).detail).toBe("check query must return one numeric value");
  });

  it("SQL errors surface as the detail", () => {
    const data: RunData = { catalog: CATALOG, exec: () => { throw new Error("query references :period but no period was provided"); } };
    expect(evaluateAssert(rule({}), data).detail).toBe("query references :period but no period was provided");
  });
});

describe("auditCitations (warehouse)", () => {
  const blocksWith = (locator: string, fig = "1,204", sourceId = "famA") =>
    parseSectionText(`Total was [[${fig}|${sourceId}|${locator}]] this quarter.`);

  it("verifies a matching aggregate citation", () => {
    const calls: string[] = [];
    const audit = auditCitations(blocksWith("sum(fam_ar.amount)"), dataReturning(1204, calls), ["famA"]);
    expect(audit.pass).toBe(true);
    expect(calls[0]).toBe(`SELECT COALESCE(SUM("amount"), 0) FROM "fam_ar" WHERE _period = :period`);
  });

  it("flags a mismatch beyond 0.5%", () => {
    const audit = auditCitations(blocksWith("sum(fam_ar.amount)"), dataReturning(2000), ["famA"]);
    expect(audit.failures).toEqual(["citation mismatch: 1,204 vs computed 2000"]);
  });

  it("flags locator source mismatch when the table belongs to another family", () => {
    const audit = auditCitations(blocksWith("sum(fam_ref.share)", "0.62", "famA"), dataReturning(0.62), ["famA", "famC"]);
    expect(audit.failures).toEqual(["locator source mismatch: cites famA but locator references fam_ref"]);
  });

  it("flags unknown tables and exec failures as unverifiable", () => {
    const bad = auditCitations(blocksWith("sum(fam_nope.amount)"), dataReturning(1), ["famA"]);
    expect(bad.failures).toEqual(["unverifiable locator: sum(fam_nope.amount)"]);
    const throwing: RunData = { catalog: CATALOG, exec: () => { throw new Error("no data ingested yet"); } };
    const audit = auditCitations(blocksWith("sum(fam_ar.amount)"), throwing, ["famA"]);
    expect(audit.failures).toEqual(["unverifiable locator: sum(fam_ar.amount)"]);
  });

  it("leaves quote-reference locators alone and keeps unbound/uncited failures", () => {
    const blocks = parseSectionText(`The guide says [["plain voice"|famDoc|brand guide p.2]] and 500 units.`);
    const audit = auditCitations(blocks, dataReturning(1), ["famDoc"]);
    expect(audit.failures).toEqual(["uncited figure: 500"]);
  });

  it("fails a cited span whose text carries no figure, with a pinned prefix", () => {
    // A live retry produced [[figure|src|max]] — placeholder text rendered to the reader.
    const blocks: Block[] = [{ type: "paragraph", spans: [
      { text: "figure", citation: { sourceId: "famA", locator: "max" } },
    ]}];
    const r = auditCitations(blocks, dataReturning(0), ["famA"]);
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/^cited span has no figure: /);
  });

  it("pins the unbound-source failure prefix", () => {
    const unbound: Block[] = [{ type: "paragraph", spans: [
      { text: "$240,100", citation: { sourceId: "src_other", locator: "x" } },
    ]}];
    const r = auditCitations(unbound, dataReturning(0), ["famA"]);
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/^figure cites unbound source src_other: /);
  });

  it("does not read digits embedded in identifiers like GA4 as figures", () => {
    // "GA4 recorded…" flagged "uncited figure: 4" in a live run — the 4 belongs
    // to the word. The FIGURE lookbehind must keep GA4/Q2 from reading as figures.
    const blocks: Block[] = [{ type: "paragraph", spans: [
      { text: "GA4 recorded strong Q2 growth across channels." },
    ]}];
    expect(auditCitations(blocks, dataReturning(1), ["famA"]).pass).toBe(true);
  });

  it("audits citations inside table cells but not header columns", () => {
    // A digit in a header column ("Q2 Value") must NOT be flagged; a cell figure must be.
    const cited: Block[] = [{ type: "table", columns: ["Metric", "Q2 Value"], rows: [
      { cells: [
        [{ text: "Total" }],
        [{ text: "$240,100", citation: { sourceId: "famA", locator: "sum(fam_ar.amount)" } }],
      ] },
    ]}];
    expect(auditCitations(cited, dataReturning(240100), ["famA"]).pass).toBe(true);
    expect(countCitations(cited)).toBe(1);

    const uncited: Block[] = [{ type: "table", columns: ["Metric", "Value"], rows: [
      { cells: [ [{ text: "Total" }], [{ text: "$240,100" }] ] },
    ]}];
    const r = auditCitations(uncited, dataReturning(240100), ["famA"]);
    expect(r.pass).toBe(false);
    expect(r.failures[0]).toMatch(/^uncited figure: /);
  });

  it("skips recompute for a figure-bearing span whose locator is not an aggregate reference", () => {
    // A non-aggregate locator (e.g. "invoice footnote 3") is not verifiable
    // grammar, so the recompute branch is skipped and the cited figure passes.
    const blocks: Block[] = [{ type: "paragraph", spans: [
      { text: "$240,100", citation: { sourceId: "famA", locator: "invoice footnote 3" } },
    ]}];
    expect(auditCitations(blocks, dataReturning(0), ["famA"]).pass).toBe(true);
  });
});

describe("countCitations", () => {
  it("counts cited spans across paragraphs and table cells", () => {
    const para = parseSectionText(`Total was [[1,204|famA|sum(fam_ar.amount)]] this quarter.`);
    expect(countCitations(para)).toBe(1);

    const table: Block[] = [{ type: "table", columns: ["Metric", "Q2 Value"], rows: [
      { cells: [
        [{ text: "Total" }],
        [{ text: "$240,100", citation: { sourceId: "famA", locator: "sum(fam_ar.amount)" } }],
      ] },
    ]}];
    expect(countCitations(table)).toBe(1);

    // Uncited spans (paragraph text and header columns) do not count.
    const none: Block[] = [{ type: "paragraph", spans: [{ text: "No citations here." }] }];
    expect(countCitations(none)).toBe(0);
  });
});
