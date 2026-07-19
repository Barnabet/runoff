import { describe, expect, it } from "vitest";
import type { RunDocument, SqlResult, SubmittedItem } from "@runoff/core";
import {
  boundnessLine, inventoryFromCitations, parseSpanNumber, renderGoldenForPrompt, verifyInventory,
} from "../src/goldenBinding.js";

const execOf = (map: Record<string, SqlResult | Error>) => (sql: string): SqlResult => {
  const hit = map[sql];
  if (!hit) throw new Error(`no such table: ${sql}`);
  if (hit instanceof Error) throw hit;
  return hit;
};
const val = (over: Partial<SubmittedItem>): SubmittedItem => ({
  id: "total", kind: "value", anchor: { sectionKey: "s", blockIndex: 0, spanIndex: 0 },
  raw: "$4.2M", parsed: 4200000, binding: { familyId: "fam_1", sql: "Q1" }, reason: null, ...over,
});
const inv = (items: SubmittedItem[]) => ({ version: 1 as const, items });

describe("parseSpanNumber", () => {
  it("handles currency, commas, suffixes, percents", () => {
    expect(parseSpanNumber("$4,215,332")).toBe(4215332);
    expect(parseSpanNumber("$4.2M")).toBe(4200000);
    expect(parseSpanNumber("3.1K")).toBe(3100);
    expect(parseSpanNumber("12.5%")).toBe(0.125);
    expect(parseSpanNumber("EMEA")).toBeNull();
  });
});

describe("verifyInventory", () => {
  it("stamps bound within 1% tolerance, mismatch outside", () => {
    const out = verifyInventory(inv([
      val({}),                                                     // 4215332 vs parsed 4200000 → 0.36% → bound
      val({ id: "count", raw: "6", parsed: 6, binding: { familyId: "fam_1", sql: "Q2" } }),
    ]), execOf({ Q1: { columns: ["v"], rows: [[4215332]] }, Q2: { columns: ["v"], rows: [[7]] } }), "2026-Q1");
    expect(out.items[0].binding?.status).toBe("bound");
    expect(out.items[0].binding?.verifiedValue).toBe(4215332);
    expect(out.items[1].binding?.status).toBe("mismatch");
    expect(out.items[1].reason).toBe("value mismatch"); // schema requires a reason when status ≠ bound
  });
  it("single-value rule, sql errors, no-period rule", () => {
    const out = verifyInventory(inv([
      val({ id: "wide", binding: { familyId: "fam_1", sql: "WIDE" } }),
      val({ id: "boom", binding: { familyId: "fam_1", sql: "BOOM" } }),
      val({ id: "np", binding: { familyId: "fam_1", sql: "SELECT SUM(x) WHERE _period = :period" } }),
    ]), execOf({ WIDE: { columns: ["a", "b"], rows: [[1, 2]] }, BOOM: new Error("no such column: x") }), null);
    expect(out.items[0].binding?.status).toBe("error");
    expect(out.items[0].reason).toBe("sql did not return a single value");
    expect(out.items[1].binding?.status).toBe("error");
    expect(out.items[1].reason).toBe("sql error: no such column: x");
    expect(out.items[2].binding?.status).toBe("error");
    expect(out.items[2].reason).toBe("golden has no period");
  });
  it("string equality and existence binding", () => {
    const out = verifyInventory(inv([
      val({ id: "top", raw: "EMEA", parsed: "EMEA", binding: { familyId: "fam_1", sql: "TOP" } }),
      val({ id: "exists", raw: "shown", parsed: null, binding: { familyId: "fam_1", sql: "TOP" } }),
    ]), execOf({ TOP: { columns: ["r"], rows: [["emea "]] } }), "2026-Q1");
    expect(out.items[0].binding?.status).toBe("bound");
    expect(out.items[1].binding?.status).toBe("bound");
  });
  it("table rule: col/row counts, byte-exact reasons", () => {
    const tbl = (id: string, sql: string): SubmittedItem =>
      ({ id, kind: "table", anchor: { sectionKey: "s", blockIndex: 1, spanIndex: null }, raw: "status table",
         parsed: null, binding: { familyId: "fam_1", sql }, reason: null });
    const doc: RunDocument = { title: "", eyebrow: "", dateline: "", sections: [
      { key: "s", heading: "S", blocks: [
        { type: "paragraph", spans: [{ text: "x" }] },
        { type: "table", columns: ["status", "total"], rows: [{ cells: [[], []] }, { cells: [[], []] }] },
      ] } ] };
    const out = verifyInventory(inv([tbl("t1", "T_OK"), tbl("t2", "T_COLS"), tbl("t3", "T_ROWS")]),
      execOf({
        T_OK: { columns: ["a", "b"], rows: [[1, 1], [2, 2]] },
        T_COLS: { columns: ["a", "b", "c"], rows: [[1, 1, 1]] },
        T_ROWS: { columns: ["a", "b"], rows: [[1, 1]] },
      }), "2026-Q1", doc);
    expect(out.items[0].binding?.status).toBe("bound");
    expect(out.items[0].binding?.verifiedValue).toBe(2);
    expect(out.items[1].binding?.status).toBe("mismatch");
    expect(out.items[1].reason).toBe("column count 3 ≠ 2");
    expect(out.items[2].binding?.status).toBe("mismatch");
    expect(out.items[2].reason).toBe("row count 1 ≠ 2");
  });
  it("unbound items pass through; boundness line derives", () => {
    const out = verifyInventory(inv([val({}), val({ id: "u", binding: null, reason: "no candidate" })]),
      execOf({ Q1: { columns: ["v"], rows: [[4200000]] } }), "2026-Q1");
    expect(out.items[1].binding).toBeNull();
    expect(boundnessLine(out)).toBe("1/2 bound, 0 mismatch, 1 unbound");
    expect(boundnessLine({ version: 1, items: [] })).toBe("nothing to bind");
    expect(boundnessLine(null)).toBe("not yet bound");
  });
});

describe("inventoryFromCitations", () => {
  const catalog = [{ id: "fam_ar", key: "ar_transactions", label: "AR", kind: "periodic", granularity: "quarter",
    tables: [{ name: "fam_ar_transactions", columns: [{ name: "amount", type: "REAL" }], rowCount: 10 }], periods: ["2026-Q1"] }] as never;
  const doc: RunDocument = { title: "t", eyebrow: "", dateline: "", sections: [
    { key: "summary", heading: "S", blocks: [
      { type: "paragraph", spans: [
        { text: "Total " },
        { text: "50,855,755", citation: { sourceId: "fam_ar", locator: "sum(fam_ar_transactions.amount)" } },
      ] },
      { type: "table", columns: ["status", "total"], rows: [{ cells: [[], []] }] },
    ] } ] };
  it("spans with citations become value items via compileLocator; tables use covering queries", () => {
    const out = inventoryFromCitations(doc, catalog, (key) =>
      key === "summary" ? [{ name: "by_status", sql: "SELECT status, SUM(amount) FROM fam_ar_transactions WHERE _period = :period GROUP BY status" }] : []);
    const v = out.items.find((i) => i.kind === "value");
    expect(v?.id).toBe("summary_b0_s1");
    expect(v?.parsed).toBe(50855755);
    expect(v?.binding?.familyId).toBe("fam_ar");
    expect(v?.binding?.sql).toContain("SUM");
    const t = out.items.find((i) => i.kind === "table");
    expect(t?.id).toBe("summary_b1");
    expect(t?.binding?.sql).toContain("GROUP BY status");
  });
  it("uncovered tables and unparseable locators are unbound with reasons", () => {
    const bad: RunDocument = JSON.parse(JSON.stringify(doc));
    (bad.sections[0].blocks[0] as { spans: { citation?: object }[] }).spans[1].citation = { sourceId: "fam_ar", locator: "garbage!!" };
    const out = inventoryFromCitations(bad, catalog, () => []);
    expect(out.items[0].binding).toBeNull();
    expect(out.items[0].reason).toContain("unparseable expression");
    expect(out.items[1].binding).toBeNull();
    expect(out.items[1].reason).toBe("no query covers this table");
  });
});

describe("renderGoldenForPrompt", () => {
  it("renders doc with annotations and boundness; inert without document", () => {
    const doc: RunDocument = { title: "AR", eyebrow: "", dateline: "", sections: [
      { key: "s", heading: "Summary", blocks: [{ type: "paragraph", spans: [{ text: "Total " }, { text: "$4.2M" }] }] } ] };
    const bound = renderGoldenForPrompt({ label: "ar review", note: null, period: "2026-Q1", document: doc, unifyError: null,
      inventory: { version: 1, items: [{ id: "total", kind: "value", anchor: { sectionKey: "s", blockIndex: 0, spanIndex: 1 },
        raw: "$4.2M", parsed: 4200000, binding: { familyId: "fam_ar", sql: "SELECT SUM(amount) FROM fam_ar_transactions WHERE _period = :period", verifiedValue: 4215332, status: "bound" }, reason: null }] } });
    expect(bound).toContain("## Summary");
    expect(bound).toContain("«$4.2M ← fam_ar: SELECT SUM(amount) FROM fam_ar_transactions WHERE _period = :period»");
    expect(bound).toContain("boundness: 1/1 bound, 0 mismatch, 0 unbound");
    const inert = renderGoldenForPrompt({ label: "raw", note: null, period: null, document: null, inventory: null, unifyError: "unify failed: boom" });
    expect(inert).toBe('golden "raw" is not unified (unify failed: boom)');
  });
});
