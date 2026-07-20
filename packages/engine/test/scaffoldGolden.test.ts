import { describe, expect, it } from "vitest";
import { buildScaffoldDigest, renderScaffoldDigest, type ScaffoldGoldenInput } from "../src/scaffoldGolden.js";

const doc = {
  title: "AR Review", eyebrow: "", dateline: "",
  sections: [
    { key: "overview", heading: "Overview", blocks: [
      { type: "paragraph" as const, spans: [{ text: "Total AR is " }, { text: "$4.2M" }, { text: " across " }, { text: "1,204" }, { text: " invoices." }] },
      { type: "table" as const, columns: ["status", "amount"], rows: [{ cells: [[{ text: "open" }], [{ text: "$1M" }]] }, { cells: [[{ text: "paid" }], [{ text: "$3M" }]] }] },
    ] },
    { key: "empty_sec", heading: "Notes", blocks: [{ type: "paragraph" as const, spans: [{ text: "No figures here." }] }] },
  ],
};

const item = (over: Record<string, unknown>) => ({
  kind: "value", raw: "x", parsed: 1, reason: null,
  anchor: { sectionKey: "overview", blockIndex: 0, spanIndex: 1 },
  binding: { familyId: "fam_ar", sql: "SELECT 1", verifiedValue: 1, status: "bound" },
  ...over,
});

const golden = (items: unknown[]): ScaffoldGoldenInput => ({
  id: "g1", label: "AR exemplar", period: "2026-Q1",
  document: doc as never, inventory: { version: 1, items } as never,
});

describe("buildScaffoldDigest", () => {
  it("groups lifted queries by anchor section, in document order", () => {
    const d = buildScaffoldDigest(golden([
      item({ id: "total", raw: "$4.2M", binding: { familyId: "fam_ar", sql: "SELECT SUM(amount) FROM fam_ar WHERE _period = :period", verifiedValue: 4200000, status: "bound" } }),
      item({ id: "tbl", kind: "table", parsed: null, anchor: { sectionKey: "overview", blockIndex: 1, spanIndex: null }, raw: "table: status, amount",
        binding: { familyId: "fam_ar", sql: "SELECT status, SUM(amount) FROM fam_ar GROUP BY status", verifiedValue: 2, status: "bound" } }),
    ]));
    expect(d.sections.map((s) => s.key)).toEqual(["overview", "empty_sec"]);
    expect(d.sections[0].queries).toEqual([
      { name: "total", sql: "SELECT SUM(amount) FROM fam_ar WHERE _period = :period", provenance: "verified" },
      { name: "tbl", sql: "SELECT status, SUM(amount) FROM fam_ar GROUP BY status", provenance: "verified" },
    ]);
    expect(d.boundness).toBe("2/2 bound, 0 mismatch, 0 unbound");
  });

  it("lifts mismatch SQL with verified-mismatch provenance plus a warning; unbound/error become warnings only", () => {
    const d = buildScaffoldDigest(golden([
      item({ id: "stale", raw: "$4.2M", binding: { familyId: "fam_ar", sql: "SELECT SUM(x) FROM fam_ar", verifiedValue: 3981102, status: "mismatch" } }),
      item({ id: "orphan", raw: "12", binding: null, reason: "no matching family", anchor: { sectionKey: "overview", blockIndex: 0, spanIndex: 3 } }),
      item({ id: "broken", raw: "7", reason: "sql error: boom", anchor: { sectionKey: "overview", blockIndex: 0, spanIndex: 4 },
        binding: { familyId: "fam_ar", sql: "SELECT bad", verifiedValue: null, status: "error" } }),
    ]));
    const s = d.sections[0];
    expect(s.queries).toEqual([{ name: "stale", sql: "SELECT SUM(x) FROM fam_ar", provenance: "verified-mismatch" }]);
    expect(s.warnings).toEqual([
      '"$4.2M" mismatches current data (golden says $4.2M · data 3981102)',
      '"12" has no data backing (no matching family)',
      '"7" has no data backing (sql error: boom)',
    ]);
  });

  it("flags sections with no lifted queries", () => {
    const d = buildScaffoldDigest(golden([]));
    expect(d.sections[0].warnings).toEqual(["no verified queries in this section"]);
    expect(d.sections[1].warnings).toEqual(["no verified queries in this section"]);
  });

  it("renders prose with spaces between spans, tables header-only, capped at 1500 chars", () => {
    const d = buildScaffoldDigest(golden([]));
    expect(d.sections[0].prose).toBe(
      "Total AR is  $4.2M  across  1,204  invoices.\n[table 2 cols × 2 rows: status | amount]",
    );
    const longDoc = { ...doc, sections: [{ key: "big", heading: "B", blocks: [{ type: "paragraph" as const, spans: [{ text: "x".repeat(2000) }] }] }] };
    const d2 = buildScaffoldDigest({ ...golden([]), document: longDoc as never });
    expect(d2.sections[0].prose).toHaveLength(1501); // 1500 + trailing …
    expect(d2.sections[0].prose.endsWith("…")).toBe(true);
  });

  it("defensively dedupes repeated lifted names", () => {
    const d = buildScaffoldDigest(golden([
      item({ id: "dup" }),
      item({ id: "dup", anchor: { sectionKey: "overview", blockIndex: 0, spanIndex: 3 } }),
    ]));
    expect(d.sections[0].queries.map((q) => q.name)).toEqual(["dup", "dup_2"]);
  });
});

describe("renderScaffoldDigest", () => {
  it("renders the exact digest format", () => {
    const d = buildScaffoldDigest(golden([
      item({ id: "total", raw: "$4.2M", binding: { familyId: "fam_ar", sql: "SELECT SUM(amount) FROM fam_ar", verifiedValue: 4200000, status: "bound" } }),
    ]));
    const text = renderScaffoldDigest(d);
    expect(text.startsWith('SCAFFOLD DIGEST — golden "AR exemplar" (period 2026-Q1, 1/1 bound, 0 mismatch, 0 unbound)')).toBe(true);
    expect(text).toContain("## section: overview — Overview");
    expect(text).toContain("prose:\nTotal AR is  $4.2M  across  1,204  invoices.");
    expect(text).toContain("queries:\n  total: SELECT SUM(amount) FROM fam_ar  [verified]");
    expect(text).toContain("## section: empty_sec — Notes");
    expect(text).toContain("warnings:\n  - no verified queries in this section");
  });
  it("renders period none for a period-less golden", () => {
    const d = buildScaffoldDigest({ ...golden([]), period: null });
    expect(renderScaffoldDigest(d)).toContain("(period none,");
  });
});
