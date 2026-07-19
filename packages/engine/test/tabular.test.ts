import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectIslands, isTabular, readTabular, scanTabular, slugify } from "../src/tabular.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tab-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// ExcelJS's own writer emits `xl/workbook.xml` as the LAST zip entry, but
// ExcelJS.stream.xlsx.WorkbookReader (the mandated reader) assumes the workbook
// part is streamed before the worksheets and throws otherwise. Real-world
// producers (Excel, Google Sheets) always order workbook.xml first, so we
// normalise the fixture's zip ordering to match a genuine upload — this
// exercises the exact production read path. See task-2-report.md for detail.
async function writeXlsx(file: string, build: (ws: ExcelJS.Worksheet, wb: ExcelJS.Workbook) => void): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Report Data");
  build(ws, wb);
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

describe("slugify", () => {
  it("lowercases, collapses, prefixes digits", () => {
    expect(slugify("Report Data")).toBe("report_data");
    expect(slugify("Q1 — Sales!!")).toBe("q1_sales");
    expect(slugify("2026 Summary")).toBe("t_2026_summary");
  });
});

describe("detectIslands", () => {
  const E = null;
  it("splits two tables separated by a blank row, keeps a note as a fragment", () => {
    const grid = [
      ["campaign", "spend"],
      ["brand", 100],
      ["search", 200],
      [E, E],
      ["Note: Q2 excludes agency fees"],
      [E, E],
      ["region", "revenue"],
      ["emea", 900],
    ];
    const out = detectIslands(grid, "sheet1");
    expect(out.tables.map((t) => t.slug)).toEqual(["sheet1", "sheet1_2"]);
    expect(out.tables[0].header).toEqual(["campaign", "spend"]);
    expect(out.tables[0].rows).toEqual([["brand", 100], ["search", 200]]);
    expect(out.tables[1].rows).toEqual([["emea", 900]]);
    expect(out.skipped).toEqual(["Note: Q2 excludes agency fees"]);
  });
  it("splits side-by-side tables on a blank column", () => {
    const grid = [
      ["a", "b", E, "c", "d"],
      [1, 2, E, 3, 4],
      [5, 6, E, 7, 8],
    ];
    const out = detectIslands(grid, "s");
    expect(out.tables.length).toBe(2);
    expect(out.tables[0].header).toEqual(["a", "b"]);
    expect(out.tables[1].header).toEqual(["c", "d"]);
    expect(out.tables[1].rows).toEqual([[3, 4], [7, 8]]);
  });
  it("skips 1-column and 1-row blocks; names empty headers column_N", () => {
    const grid = [
      ["just a title"],
      [E],
      ["h1", E, "h3"],   // island cols 0..2 with a hole in the header
      [1, 2, 3],
    ];
    const out = detectIslands(grid, "s");
    expect(out.skipped).toEqual(["just a title"]);
    expect(out.tables[0].header).toEqual(["h1", "column_2", "h3"]);
  });
  it("renames a source column that slugs to the reserved _period", () => {
    const grid = [
      ["_period", "amount"],
      ["x", 1],
    ];
    expect(detectIslands(grid, "s").tables[0].header).toEqual(["_period_2", "amount"]);
  });
  it("returns nothing for an empty grid", () => {
    expect(detectIslands([], "s")).toEqual({ tables: [], skipped: [] });
  });
});

describe("scanTabular + readTabular", () => {
  it("scans a CSV: header, inferred types, count, sample; single table slugged from the file", async () => {
    const path = join(dir, "ar.csv");
    writeFileSync(path, "invoice,amount,paid\nI-1,100,true\nI-2,250.5,false\nI-3,90,true\n");
    const scan = await scanTabular(path, "text/csv", "ar.csv");
    expect(scan.tables.length).toBe(1);
    expect(scan.tables[0].columns).toEqual([
      { name: "invoice", type: "TEXT" },
      { name: "amount", type: "REAL" },
      { name: "paid", type: "TEXT" },
    ]);
    expect(scan.tables[0].rowCount).toBe(3);
    expect(scan.tables[0].sample[0]).toEqual(["I-1", 100, true]);
    expect(scan.skipped).toEqual([]);
  });
  it("integer-only columns infer INTEGER; empty cells don't affect inference", async () => {
    const path = join(dir, "n.csv");
    writeFileSync(path, "id,qty\n1,5\n2,\n3,7\n");
    const scan = await scanTabular(path, "text/csv", "n.csv");
    expect(scan.tables[0].columns).toEqual([{ name: "id", type: "INTEGER" }, { name: "qty", type: "INTEGER" }]);
  });
  it("readTabular streams CSV rows in batches matching the scan", async () => {
    const path = join(dir, "big.csv");
    const rows = Array.from({ length: 25_000 }, (_, i) => `r${i},${i}`);
    writeFileSync(path, `name,n\n${rows.join("\n")}\n`);
    const batches: number[] = [];
    let cols: string[] = [];
    await readTabular(path, "text/csv", "big.csv", (table) => {
      cols = table.columns.map((c) => c.name);
      return (batch) => { batches.push(batch.length); };
    });
    expect(cols).toEqual(["name", "n"]);
    expect(batches.reduce((a, b) => a + b, 0)).toBe(25_000);
    expect(Math.max(...batches)).toBeLessThanOrEqual(10_000);
  });
  it("scans a messy XLSX via the streaming reader: two islands + note", async () => {
    const path = await writeXlsx("messy.xlsx", (ws) => {
      ws.addRow(["campaign", "spend"]);
      ws.addRow(["brand", 100]);
      ws.addRow([]);
      ws.addRow(["Note: excludes fees"]);
      ws.addRow([]);
      ws.addRow(["region", "revenue"]);
      ws.addRow(["emea", 900]);
    });
    const scan = await scanTabular(path, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "messy.xlsx");
    expect(scan.tables.map((t) => t.slug)).toEqual(["report_data", "report_data_2"]);
    expect(scan.tables[1].columns).toEqual([{ name: "region", type: "TEXT" }, { name: "revenue", type: "INTEGER" }]);
    expect(scan.skipped).toEqual(["Note: excludes fees"]);
    // readTabular agrees with the scan
    const seen: string[] = [];
    await readTabular(path, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "messy.xlsx",
      (t) => { seen.push(t.slug); return () => {}; });
    expect(seen).toEqual(["report_data", "report_data_2"]);
  });
  it("dedupes table slugs across sheets: 'Data' (two islands) vs sibling 'Data (2)'", async () => {
    // Reviewer scenario: sheet "Data" yields data + data_2 (two islands); a
    // sibling sheet "Data (2)" slugs to data_2 at the sheet level, whose single
    // island must not collide with the earlier island's data_2.
    const path = await writeXlsx("dup.xlsx", (ws, wb) => {
      ws.name = "Data";
      ws.addRow(["campaign", "spend"]);
      ws.addRow(["brand", 100]);
      ws.addRow([]);
      ws.addRow(["region", "revenue"]);
      ws.addRow(["emea", 900]);
      const ws2 = wb.addWorksheet("Data (2)");
      ws2.addRow(["metric", "value"]);
      ws2.addRow(["clicks", 5]);
    });
    const mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const scan = await scanTabular(path, mime, "dup.xlsx");
    const slugs = scan.tables.map((t) => t.slug);
    expect(slugs).toEqual(["data", "data_2", "data_2_2"]);
    expect(new Set(slugs).size).toBe(slugs.length); // all distinct
    // readTabular shares the scan pass, so it emits the identical slug set.
    const seen: string[] = [];
    await readTabular(path, mime, "dup.xlsx", (t) => { seen.push(t.slug); return () => {}; });
    expect(seen).toEqual(slugs);
  });
  it("isTabular accepts csv/xlsx, rejects pdf/txt", () => {
    expect(isTabular("text/csv", "a.csv")).toBe(true);
    expect(isTabular("application/octet-stream", "a.xlsx")).toBe(true);
    expect(isTabular("application/pdf", "a.pdf")).toBe(false);
    expect(isTabular("text/plain", "a.txt")).toBe(false);
  });
});
