import { describe, expect, it } from "vitest";
import { serializeCatalog, type CatalogFamily } from "../src/catalogFormat.js";

const FAMS: CatalogFamily[] = [
  {
    id: "fam_1", key: "marketing_spend", label: "Marketing spend", kind: "periodic", granularity: "quarter",
    queryable: true, filedPeriods: ["2026-Q1", "2026-Q2"],
    tables: [{
      name: "fam_marketing_spend",
      columns: [{ name: "campaign", type: "TEXT" }, { name: "spend", type: "REAL" }],
      rowCounts: { "2026-Q1": 598, "2026-Q2": 606 },
    }],
  },
  { id: "fam_2", key: "brand_guidelines", label: "Brand guidelines", kind: "constant", granularity: null, queryable: false, tables: [], filedPeriods: [] },
];

describe("serializeCatalog", () => {
  it("renders the spec's two-line-per-table shape", () => {
    const out = serializeCatalog(FAMS);
    expect(out).toBe(
      'marketing_spend — "Marketing spend" (periodic, quarter; filed: 2026-Q1, 2026-Q2)\n' +
      "  fam_marketing_spend(campaign TEXT, spend REAL) — 1,204 rows (2026-Q1: 598, 2026-Q2: 606)\n" +
      'brand_guidelines — "Brand guidelines" (constant) — document, not queryable',
    );
  });
  it("marks a queryable constant family's counts without periods", () => {
    const out = serializeCatalog([{ ...FAMS[0], key: "rates", label: "Rates", kind: "constant", granularity: null, filedPeriods: [], tables: [{ name: "fam_rates", columns: [{ name: "code", type: "TEXT" }], rowCounts: { "": 12 } }] }]);
    expect(out).toBe('rates — "Rates" (constant)\n  fam_rates(code TEXT) — 12 rows');
  });
  it("shows a queryable family with zero rows as a gap, not an error", () => {
    const out = serializeCatalog([{ ...FAMS[0], tables: [{ ...FAMS[0].tables[0], rowCounts: {} }] }]);
    expect(out).toContain("fam_marketing_spend(campaign TEXT, spend REAL) — 0 rows");
  });
});
