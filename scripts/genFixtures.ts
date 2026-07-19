/**
 * One-off generator for the committed messy-XLSX fixtures.
 *
 * exceljs writes `xl/workbook.xml` LAST in the zip, but the engine's streaming
 * WorkbookReader needs it early (it crashes on "reading 'sheets'" otherwise), so
 * each generated buffer is re-packed with jszip in canonical part order before it
 * is written to disk. Mirrors `writeXlsx` in packages/engine/test/tabular.test.ts.
 *
 * Run once: `pnpm tsx scripts/genFixtures.ts` — the produced .xlsx files are committed.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Serialize an exceljs workbook and re-pack it so the streaming reader finds
 * `xl/workbook.xml` before the worksheets, then write it to scripts/fixtures.
 */
async function repack(wb: ExcelJS.Workbook, outName: string): Promise<void> {
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

  const path = join(HERE, "fixtures", outName);
  writeFileSync(path, await out.generateAsync({ type: "nodebuffer" }));
  console.log(`wrote scripts/fixtures/${outName}`);
}

async function main(): Promise<void> {
  // Fixture 1: two islands + a note row (regional_summary).
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Regional Summary");
  ws.addRow(["region", "revenue", "orders"]);
  ws.addRow(["EMEA", 412000, 1830]);
  ws.addRow(["AMER", 655000, 2410]);
  ws.addRow(["APAC", 238000, 990]);
  ws.addRow([]);
  ws.addRow(["Note: revenue is net of returns"]);
  ws.addRow([]);
  ws.addRow(["channel", "share"]);
  ws.addRow(["online", 0.62]);
  ws.addRow(["retail", 0.38]);
  await repack(wb, "regional_summary.xlsx");

  // Fixture 2: messy AR-aging — glued title (no blank below), a Grand Total row
  // whose amount equals the data sum (so an unexcluded total doubles it), currency
  // strings, and a second wide "Monthly Totals" sheet begging to be unpivoted.
  const wb2 = new ExcelJS.Workbook();
  const aging = wb2.addWorksheet("AR Aging");
  aging.addRow(["AR Aging Report — Q2 2026"]);          // glued title, NO blank row below
  aging.addRow(["Customer", "Status", "Amount Due ($)", "Days Outstanding"]);
  aging.addRow(["Acme Corp", "open", "$12,400.50", 31]);
  aging.addRow(["Beta Industries", "open", "$8,250.00", 62]);
  aging.addRow(["Gamma LLC", "paid", "$15,000.00", 12]);
  aging.addRow(["Delta Retail", "open", "$4,100.25", 95]);
  aging.addRow(["Epsilon & Co", "disputed", "$18,749.25", 47]);
  aging.addRow(["Zeta Group", "open", "$2,500.00", 8]);
  aging.addRow(["Grand Total", "", "$61,000.00", ""]);
  const monthly = wb2.addWorksheet("Monthly Totals");
  monthly.addRow(["Region", "Apr 2026", "May 2026", "Jun 2026"]);
  monthly.addRow(["EMEA", "$7,200.00", "$8,100.00", "$6,950.00"]);
  monthly.addRow(["AMER", "$11,400.00", "$10,050.00", "$12,300.00"]);
  monthly.addRow(["APAC", "$3,000.00", "$2,000.00", "$0.00"]);
  await repack(wb2, "ar_aging_q2_2026.xlsx");
}
main();
