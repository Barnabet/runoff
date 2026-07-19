import { describe, it, expect } from "vitest";
import type { BlueprintSection } from "@runoff/core";
import { sectionDataBlock, type RunData } from "../src/runData.js";
import type { SourcePack } from "../src/sourcePack.js";

const emptyPack: SourcePack = { sources: [] };

function fam(over: Record<string, unknown> = {}) {
  return {
    id: "famA", key: "ar", label: "AR transactions", kind: "periodic" as const,
    granularity: "quarter" as const, queryable: true, filedPeriods: ["2026-Q1"],
    tables: [{ name: "fam_ar", columns: [{ name: "amount", type: "REAL" as const }], rowCounts: { "2026-Q1": 3 } }],
    ...over,
  };
}

function section(over: Partial<BlueprintSection> = {}): BlueprintSection {
  return {
    key: "s1", number: 1, heading: "H", mode: "auto", instruction: "i",
    familyIds: ["famA"], rules: [], queries: [], ...over,
  } as BlueprintSection;
}

describe("sectionDataBlock", () => {
  it("renders baked query results through formatSqlResult", () => {
    const calls: string[] = [];
    const data: RunData = {
      catalog: [fam()],
      exec: (sql) => { calls.push(sql); return { columns: ["total"], rows: [[123]] }; },
    };
    const out = sectionDataBlock(section({ queries: [{ name: "total", sql: "SELECT SUM(amount) AS total FROM fam_ar WHERE _period = :period" }] }), data, emptyPack);
    expect(out).toContain('### AR transactions (famA)');
    expect(out).toContain("fam_ar(amount REAL) — 3 rows");
    expect(out).toContain("-- total: SELECT SUM(amount) AS total FROM fam_ar WHERE _period = :period");
    expect(out).toContain("total\n123");
    expect(calls).toEqual(["SELECT SUM(amount) AS total FROM fam_ar WHERE _period = :period"]);
  });

  it("synthesizes the default query when no baked query covers the family", () => {
    const calls: string[] = [];
    const data: RunData = { catalog: [fam()], exec: (sql) => { calls.push(sql); return { columns: ["amount"], rows: [[1]] }; } };
    const out = sectionDataBlock(section(), data, emptyPack);
    expect(out).toContain('-- default_fam_ar: SELECT * FROM "fam_ar" WHERE _period = :period LIMIT 40');
    expect(calls).toEqual(['SELECT * FROM "fam_ar" WHERE _period = :period LIMIT 40']);
  });

  it("constant-family default has no _period clause", () => {
    const data: RunData = {
      catalog: [fam({ kind: "constant", granularity: null, filedPeriods: [], tables: [{ name: "fam_ref", columns: [{ name: "region", type: "TEXT" }], rowCounts: { "": 2 } }] })],
      exec: () => ({ columns: ["region"], rows: [["EMEA"]] }),
    };
    const out = sectionDataBlock(section(), data, emptyPack);
    expect(out).toContain('-- default_fam_ref: SELECT * FROM "fam_ref" LIMIT 40');
  });

  it("a baked query that mentions one family table suppresses that family's defaults only", () => {
    const data: RunData = {
      catalog: [fam(), fam({ id: "famB", key: "spend", label: "Spend", tables: [{ name: "fam_spend", columns: [{ name: "amount", type: "REAL" }], rowCounts: { "2026-Q1": 2 } }] })],
      exec: () => ({ columns: ["c"], rows: [[1]] }),
    };
    const out = sectionDataBlock(section({ familyIds: ["famA", "famB"], queries: [{ name: "ar_total", sql: "SELECT COUNT(*) AS c FROM fam_ar" }] }), data, emptyPack);
    expect(out).toContain("-- ar_total:");
    expect(out).not.toContain("default_fam_ar");
    expect(out).toContain("default_fam_spend");
  });

  it("renders `query failed: <message>` when exec throws, and still drafts", () => {
    const data: RunData = { catalog: [fam()], exec: () => { throw new Error("no such column: nope"); } };
    const out = sectionDataBlock(section({ queries: [{ name: "bad", sql: "SELECT nope FROM fam_ar" }] }), data, emptyPack);
    expect(out).toContain("query failed: no such column: nope");
  });

  it("falls back to packForPrompt for non-queryable families", () => {
    const pack: SourcePack = { sources: [{ id: "famDoc", label: "Brand Guide", kind: "document", text: "Voice: plain.", summary: "brand guide" }] };
    const data: RunData = { catalog: [fam({ id: "famDoc", key: "brand", label: "Brand Guide", kind: "constant", granularity: null, queryable: false, tables: [], filedPeriods: [] })], exec: () => { throw new Error("must not be called"); } };
    const out = sectionDataBlock(section({ familyIds: ["famDoc"] }), data, pack);
    expect(out).toContain("### Brand Guide (famDoc)");
    expect(out).toContain("Voice: plain.");
  });
});
