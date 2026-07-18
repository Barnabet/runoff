import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, PERIOD_REGEX, formatPeriod, ClassifyProposalSchema } from "../src/index.js";

function freshDb() {
  return openDb(join(mkdtempSync(join(tmpdir(), "runoff-")), "t.db"));
}

describe("period utilities", () => {
  it("validates canonical periods per granularity", () => {
    expect(PERIOD_REGEX.quarter.test("2026-Q1")).toBe(true);
    expect(PERIOD_REGEX.quarter.test("2026-Q5")).toBe(false);
    expect(PERIOD_REGEX.quarter.test("Q1_2026")).toBe(false);
    expect(PERIOD_REGEX.month.test("2026-06")).toBe(true);
    expect(PERIOD_REGEX.month.test("2026-13")).toBe(false);
    expect(PERIOD_REGEX.year.test("2026")).toBe(true);
    expect(PERIOD_REGEX.year.test("26")).toBe(false);
  });

  it("formats periods for display, auto-detecting granularity", () => {
    expect(formatPeriod("2026-Q1")).toBe("Q1 2026");
    expect(formatPeriod("2026-06")).toBe("Jun 2026");
    expect(formatPeriod("2026")).toBe("2026");
    expect(formatPeriod("garbage")).toBe("garbage"); // unknown shapes pass through
  });

  it("lexicographic MAX is chronological within a granularity", () => {
    expect(["2026-Q1", "2025-Q4", "2026-Q2"].sort().at(-1)).toBe("2026-Q2");
    expect(["2026-09", "2026-10", "2026-02"].sort().at(-1)).toBe("2026-10");
  });
});

describe("v1.2b tables", () => {
  it("creates projects, source_families, blueprint_families; sources has taxonomy columns", () => {
    const db = freshDb();
    const cols = (t: string) =>
      (db.sqlite.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[]).map((c) => c.name);
    expect(cols("projects")).toContain("name");
    expect(cols("source_families")).toEqual(expect.arrayContaining(["project_id", "key", "label", "kind", "granularity"]));
    expect(cols("sources")).toEqual(expect.arrayContaining(["project_id", "family_id", "period", "status", "proposal", "filed_at"]));
    expect(cols("blueprint_families")).toEqual(expect.arrayContaining(["blueprint_id", "family_id"]));
    expect(cols("blueprints")).toContain("project_id");
    expect(cols("runs")).toContain("period");
    expect(cols("memories")).toEqual(expect.arrayContaining(["scope", "project_id"]));
    db.sqlite.close();
  });

  it("enforces one live file per periodic slot via the partial index", () => {
    const db = freshDb();
    db.sqlite.prepare("INSERT INTO projects (id, name) VALUES ('proj_1', 'P')").run();
    db.sqlite
      .prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES ('fam_1','proj_1','trade_data','Trade data','periodic','quarter')")
      .run();
    const ins = db.sqlite.prepare(
      "INSERT INTO sources (id, project_id, family_id, period, name, stored_filename, mime, size, status) VALUES (?, 'proj_1', 'fam_1', '2026-Q1', 'f.csv', 'sf', 'text/csv', 1, ?)",
    );
    ins.run("src_1", "filed");
    expect(() => ins.run("src_2", "filed")).toThrow(/UNIQUE/);
    ins.run("src_3", "replaced"); // replaced rows never collide
    db.sqlite.close();
  });
});

describe("ClassifyProposalSchema", () => {
  it("accepts an existing-family proposal and a new-family proposal", () => {
    expect(
      ClassifyProposalSchema.safeParse({ familyKey: "trade_data", period: "2026-Q1", confidence: "high" }).success,
    ).toBe(true);
    expect(
      ClassifyProposalSchema.safeParse({
        familyKey: "brand_guidelines",
        newFamily: { key: "brand_guidelines", label: "Brand guidelines", kind: "constant", granularity: null },
        period: null,
        confidence: "medium",
      }).success,
    ).toBe(true);
  });
  it("rejects unknown confidence and non-string periods", () => {
    expect(ClassifyProposalSchema.safeParse({ familyKey: "x", period: "2026-Q1", confidence: "sure" }).success).toBe(false);
    expect(ClassifyProposalSchema.safeParse({ familyKey: "x", period: 5, confidence: "high" }).success).toBe(false);
  });
});
