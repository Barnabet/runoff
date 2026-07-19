import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { executeParsePlan, fitParsePlan, loadGrids, type SheetGrid } from "../src/parsePlan.js";
import type { ParsePlan } from "@runoff/core";

const g = (sheet: string, grid: unknown[][]): SheetGrid => ({ sheet, grid });

const AGING: ParsePlan = {
  version: 1,
  tables: [{
    name: "aging",
    anchor: { sheet: "ar_aging", headerSignature: ["customer", "status", "amount due ($)"], minMatch: 2 },
    headerRows: 1,
    exclude: [{ column: "customer", pattern: "^grand total$" }],
    columns: [
      { from: "customer", name: "customer", type: "TEXT" },
      { from: "status", name: "status", type: "TEXT" },
      { from: "amount due ($)", name: "amount_due", type: "REAL" },
    ],
    onPeriodMismatch: "keep",
  }],
};

const MESSY_GRID: unknown[][] = [
  ["AR Aging Report — Q2 2026"],                       // glued title, no blank row below
  ["Customer", "Status", "Amount Due ($)"],
  ["Acme", "open", 1200],
  ["Beta", "paid", 800],
  ["Customer", "Status", "Amount Due ($)"],            // repeated page header
  ["Gamma", "open", 400],
  ["Grand Total", "", 2400],
];

describe("anchoring + region", () => {
  it("anchors by signature past a glued title; title never corrupts the header", () => {
    const { tables, report } = executeParsePlan([g("ar_aging", MESSY_GRID)], AGING, null, null);
    expect(report.tables[0].anchor).toEqual({ sheet: "ar_aging", row: 1 });
    expect(tables[0].columns.map((c) => c.name)).toEqual(["customer", "status", "amount_due"]);
    expect(report.tables[0].problems).toEqual([]);
  });

  it("drops repeated headers and excluded totals, counting them with samples", () => {
    const { tables, report } = executeParsePlan([g("ar_aging", MESSY_GRID)], AGING, null, null);
    expect(tables[0].rows.map((r) => r[0])).toEqual(["Acme", "Beta", "Gamma"]);
    expect(report.tables[0].rowsKept).toBe(3);
    expect(report.tables[0].rowsExcluded).toEqual([
      { pattern: "^grand total$", count: 1, samples: ["Grand Total |  | 2400"] },
    ]);
  });

  it("anchors on a renamed sheet (hint mismatch is not a failure)", () => {
    const { report } = executeParsePlan([g("totally_new_name", MESSY_GRID)], AGING, null, null);
    expect(report.tables[0].anchor).toEqual({ sheet: "totally_new_name", row: 1 });
  });

  it("region ends at 2 consecutive blank rows", () => {
    const grid = [
      ["Customer", "Status", "Amount Due ($)"],
      ["Acme", "open", 1],
      [null, null, null],
      [null, null, null],
      ["Footer note that is not data", "", ""],
    ];
    const { tables } = executeParsePlan([g("s", grid)], AGING, null, null);
    expect(tables[0].rows).toHaveLength(1);
  });

  it("single blank row inside a table is skipped, not terminal", () => {
    const grid = [
      ["Customer", "Status", "Amount Due ($)"],
      ["Acme", "open", 1],
      [null, null, null],
      ["Beta", "paid", 2],
    ];
    const { tables } = executeParsePlan([g("s", grid)], AGING, null, null);
    expect(tables[0].rows).toHaveLength(2);
  });

  it("merges 2-row headers before matching columns", () => {
    const plan: ParsePlan = {
      version: 1,
      tables: [{
        name: "t",
        anchor: { headerSignature: ["region"], minMatch: 1 },
        headerRows: 2,
        exclude: [],
        columns: [
          { from: "region", name: "region", type: "TEXT" },
          { from: "2026 q1", name: "q1", type: "REAL" },
        ],
        onPeriodMismatch: "keep",
      }],
    };
    const grid = [
      ["Region", "2026", null],
      [null, "Q1", "Q2"],
      ["EMEA", 10, 20],
    ];
    const { tables, report } = executeParsePlan([g("s", grid)], plan, null, null);
    expect(tables[0].rows).toEqual([["EMEA", 10]]);
    expect(report.tables[0].unknownColumns).toEqual(["Q2"]);
  });

  it("region stops where another table's anchor begins", () => {
    const plan: ParsePlan = {
      version: 1,
      tables: [
        { name: "a", anchor: { headerSignature: ["region", "revenue"], minMatch: 2 }, headerRows: 1, exclude: [],
          columns: [{ from: "region", name: "region", type: "TEXT" }, { from: "revenue", name: "revenue", type: "REAL" }], onPeriodMismatch: "keep" },
        { name: "b", anchor: { headerSignature: ["channel", "share"], minMatch: 2 }, headerRows: 1, exclude: [],
          columns: [{ from: "channel", name: "channel", type: "TEXT" }, { from: "share", name: "share", type: "REAL" }], onPeriodMismatch: "keep" },
      ],
    };
    const grid = [
      ["Region", "Revenue"],
      ["EMEA", 10],
      ["Channel", "Share"],   // no blank row between the tables
      ["online", 0.6],
    ];
    const { tables } = executeParsePlan([g("s", grid)], plan, null, null);
    expect(tables[0].rows).toEqual([["EMEA", 10]]);
    expect(tables[1].rows).toEqual([["online", 0.6]]);
  });
});

describe("problems", () => {
  it("unanchored table produces no rows and the byte-exact problem line", () => {
    const { tables, report } = executeParsePlan([g("s", [["nothing", "here"]])], AGING, null, null);
    expect(report.tables[0].problems).toEqual(["unanchored table: aging"]);
    expect(tables[0].rows).toEqual([]);
  });

  it("missing mapped column is a problem; table yields no rows", () => {
    const grid = [["Customer", "Status"], ["Acme", "open"]];
    const { tables, report } = executeParsePlan([g("s", grid)], AGING, null, null);
    expect(report.tables[0].problems).toEqual(["missing column: aging.amount due ($)"]);
    expect(tables[0].rows).toEqual([]);
  });
});

describe("fitParsePlan", () => {
  it("fit / partial / no_fit with byte-exact detail", () => {
    expect(fitParsePlan([g("ar_aging", MESSY_GRID)], AGING).verdict).toBe("fit");
    const partial = fitParsePlan([g("s", [["Customer", "Status"], ["x", "y"]])], AGING);
    expect(partial.verdict).toBe("partial");
    expect(partial.detail).toContain("missing column: aging.amount due ($)");
    const nofit = fitParsePlan([g("s", [["a", "b"], ["c", "d"]])], AGING);
    expect(nofit.verdict).toBe("no_fit");
    expect(nofit.detail).toContain("unanchored table: aging");
  });

  it("reports unknown columns as info without degrading fit", () => {
    const grid = [["Customer", "Status", "Amount Due ($)", "Mystery"], ["a", "b", 1, 2]];
    const fit = fitParsePlan([g("s", grid)], AGING);
    expect(fit.verdict).toBe("fit");
    expect(fit.detail).toContain("unknown column: Mystery");
  });
});

describe("coercions", () => {
  const plan = (parse: "number" | "currency" | "percent" | "date" | undefined, type: "TEXT" | "INTEGER" | "REAL" = "REAL"): ParsePlan => ({
    version: 1,
    tables: [{
      name: "t",
      anchor: { headerSignature: ["k", "v"], minMatch: 2 },
      headerRows: 1, exclude: [],
      columns: [
        { from: "k", name: "k", type: "TEXT" },
        { from: "v", name: "v", type, ...(parse ? { parse } : {}) },
      ],
      onPeriodMismatch: "keep",
    }],
  });
  const run = (p: ParsePlan, v: unknown) =>
    executeParsePlan([g("s", [["k", "v"], ["a", v]])], p, null, null);

  it("currency strips symbols and separators", () => {
    expect(run(plan("currency"), "$1,234.56").tables[0].rows[0][1]).toBe(1234.56);
    expect(run(plan("currency"), "1 234,56 €").tables[0].rows[0][1]).toBe(123456); // separators stripped; EU decimals out of scope
  });

  it("number handles thousands separators; '007' maps to 7 only with parse", () => {
    expect(run(plan("number"), "12,000").tables[0].rows[0][1]).toBe(12000);
    expect(run(plan(undefined, "TEXT"), "007").tables[0].rows[0][1]).toBe("007");
    expect(run(plan("number"), "007").tables[0].rows[0][1]).toBe(7);
  });

  it("percent: strings divide by 100, XLSX numerics pass through", () => {
    expect(run(plan("percent"), "12%").tables[0].rows[0][1]).toBe(0.12);
    expect(run(plan("percent"), "12").tables[0].rows[0][1]).toBe(0.12);
    expect(run(plan("percent"), 0.12).tables[0].rows[0][1]).toBe(0.12);
  });

  it("date: Date instances and each pinned string format → YYYY-MM-DD", () => {
    expect(run(plan("date", "TEXT"), new Date(Date.UTC(2026, 4, 7))).tables[0].rows[0][1]).toBe("2026-05-07");
    expect(run(plan("date", "TEXT"), "2026-05-07").tables[0].rows[0][1]).toBe("2026-05-07");
    expect(run(plan("date", "TEXT"), "2026/5/7").tables[0].rows[0][1]).toBe("2026-05-07");
    expect(run(plan("date", "TEXT"), "5/7/2026").tables[0].rows[0][1]).toBe("2026-05-07"); // US month-first
    expect(run(plan("date", "TEXT"), "7 May 2026").tables[0].rows[0][1]).toBe("2026-05-07");
    expect(run(plan("date", "TEXT"), "May 7, 2026").tables[0].rows[0][1]).toBe("2026-05-07");
  });

  it("date: Excel serials in range coerce; small integers still fail; ISO datetime truncates", () => {
    // 46149 = 2026-05-07 (Excel 1900 serial, Dec 30 1899 epoch).
    expect(run(plan("date", "TEXT"), 46149).tables[0].rows[0][1]).toBe("2026-05-07");
    expect(run(plan("date", "TEXT"), "2026-05-07T00:00:00.000Z").tables[0].rows[0][1]).toBe("2026-05-07");
    const smallInt = run(plan("date", "TEXT"), 7);
    expect(smallInt.tables[0].rows[0][1]).toBeNull(); // ordinary integer, not a serial date
    expect(smallInt.report.tables[0].coercionFailures[0].column).toBe("v");
  });

  it("failed coercions become NULL and are counted with samples", () => {
    const { tables, report } = run(plan("number"), "n/a");
    expect(tables[0].rows[0][1]).toBeNull();
    expect(report.tables[0].coercionFailures).toEqual([{ column: "v", count: 1, samples: ["n/a"] }]);
  });

  it("empty cells are NULL and never counted as failures", () => {
    const { report } = run(plan("number"), "   ");
    expect(report.tables[0].coercionFailures).toEqual([]);
  });
});

describe("unpivot", () => {
  const WIDE: ParsePlan = {
    version: 1,
    tables: [{
      name: "monthly",
      anchor: { headerSignature: ["region"], minMatch: 1 },
      headerRows: 1, exclude: [],
      columns: [{ from: "region", name: "region", type: "TEXT" }],
      unpivot: { keep: ["region"], valuePattern: "^[a-z]{3} \\d{4}$", keyColumn: "month", valueColumn: "amount", valueType: "REAL", valueParse: "currency" },
      onPeriodMismatch: "keep",
    }],
  };
  const grid = [
    ["Region", "Apr 2026", "May 2026", "Note"],
    ["EMEA", "$10.00", "$20.00", "x"],
    ["AMER", "$5.00", null, "y"],
  ];

  it("melts matched columns into key/value rows; empty values skipped; key keeps raw casing", () => {
    const { tables, report } = executeParsePlan([g("s", grid)], WIDE, null, null);
    expect(tables[0].columns.map((c) => c.name)).toEqual(["region", "month", "amount"]);
    expect(tables[0].rows).toEqual([
      ["EMEA", "Apr 2026", 10],
      ["EMEA", "May 2026", 20],
      ["AMER", "Apr 2026", 5],
    ]);
    expect(report.tables[0].unknownColumns).toEqual(["Note"]);
    expect(report.tables[0].rowsKept).toBe(3);
  });

  it("a NEW month column fits the pattern without any plan change", () => {
    const grid2 = [["Region", "Jun 2026"], ["EMEA", "$7.00"]];
    const { tables } = executeParsePlan([g("s", grid2)], WIDE, null, null);
    expect(tables[0].rows).toEqual([["EMEA", "Jun 2026", 7]]);
  });
});

describe("period validation", () => {
  const P: ParsePlan = {
    version: 1,
    tables: [{
      name: "tx",
      anchor: { headerSignature: ["id", "booked"], minMatch: 2 },
      headerRows: 1, exclude: [],
      columns: [
        { from: "id", name: "id", type: "TEXT" },
        { from: "booked", name: "booked", type: "TEXT", parse: "date" },
      ],
      periodColumn: "booked",
      onPeriodMismatch: "keep",
    }],
  };
  const grid = [
    ["Id", "Booked"],
    ["a", "2026-05-01"],   // Q2 — matches
    ["b", "2026-07-09"],   // Q3 — mismatch
    ["c", "bogus"],        // unparseable date — mismatch AND coercion failure
  ];

  it("derivePeriod covers all three granularities", async () => {
    const { derivePeriod } = await import("../src/parsePlan.js");
    expect(derivePeriod("2026-05-07", "quarter")).toBe("2026-Q2");
    expect(derivePeriod("2026-05-07", "month")).toBe("2026-05");
    expect(derivePeriod("2026-05-07", "year")).toBe("2026");
  });

  it("keep: mismatches counted with samples, rows kept", () => {
    const { tables, report } = executeParsePlan([g("s", grid)], P, "2026-Q2", "quarter");
    expect(tables[0].rows).toHaveLength(3);
    expect(report.tables[0].periodMismatches).toEqual({ count: 2, samples: ["b | 2026-07-09", "c | bogus"] });
  });

  it("exclude: mismatched rows dropped", () => {
    const excl: ParsePlan = { version: 1, tables: [{ ...P.tables[0], onPeriodMismatch: "exclude" }] };
    const { tables, report } = executeParsePlan([g("s", grid)], excl, "2026-Q2", "quarter");
    expect(tables[0].rows.map((r) => r[0])).toEqual(["a"]);
    expect(report.tables[0].periodMismatches?.count).toBe(2);
  });

  it("no slot period (constant/preview without period) → validation skipped", () => {
    const { report } = executeParsePlan([g("s", grid)], P, null, null);
    expect(report.tables[0].periodMismatches).toBeNull();
  });
});

// Repack an exceljs workbook so the streaming WorkbookReader finds workbook.xml
// before the worksheets (it crashes otherwise). Mirrors scripts/genFixtures.ts.
async function writeXlsx(dir: string, file: string, build: (ws: ExcelJS.Worksheet) => void): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Report Data");
  build(ws);
  const raw = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  const src = await JSZip.loadAsync(raw);
  const rank = (n: string): number =>
    n === "[Content_Types].xml" ? 0 :
    n === "xl/workbook.xml" ? 1 :
    n === "xl/_rels/workbook.xml.rels" ? 2 :
    n === "xl/sharedStrings.xml" ? 3 :
    n === "xl/styles.xml" ? 4 :
    n.startsWith("xl/worksheets/") ? 8 : 6;
  const names = Object.keys(src.files).filter((n) => !src.files[n].dir).sort((a, b) => rank(a) - rank(b));
  const out = new JSZip();
  for (const n of names) out.file(n, await src.files[n].async("nodebuffer"));
  const path = join(dir, file);
  writeFileSync(path, await out.generateAsync({ type: "nodebuffer" }));
  return path;
}

describe("date coercion through loadGrids (genuine XLSX date cells)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "parseplan-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const DATED: ParsePlan = {
    version: 1,
    tables: [{
      name: "tx",
      anchor: { headerSignature: ["when", "amt"], minMatch: 2 },
      headerRows: 1, exclude: [],
      columns: [
        { from: "when", name: "when", type: "TEXT", parse: "date" },
        { from: "amt", name: "amt", type: "REAL" },
      ],
      periodColumn: "when",
      onPeriodMismatch: "keep",
    }],
  };

  it("a real date-typed cell (Excel serial) coerces to ISO and derives its period", async () => {
    // exceljs stores a JS Date as a date-typed cell; the streaming reader (no
    // styles cache) emits it as a raw serial number, which coerceCell must accept.
    const path = await writeXlsx(dir, "dated.xlsx", (ws) => {
      ws.addRow(["when", "amt"]);
      ws.addRow([new Date(Date.UTC(2026, 4, 7)), 5]); // 2026-05-07 → Q2
    });
    const grids = await loadGrids(path, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "dated.xlsx");
    const { tables, report } = executeParsePlan(grids, DATED, "2026-Q2", "quarter");
    expect(tables[0].rows).toEqual([["2026-05-07", 5]]);
    expect(report.tables[0].coercionFailures).toEqual([]);
    expect(report.tables[0].periodMismatches).toEqual({ count: 0, samples: [] });
  });
});
