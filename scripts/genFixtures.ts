/**
 * One-off generator for the committed messy-XLSX fixture (two islands + note).
 *
 * exceljs writes `xl/workbook.xml` LAST in the zip, but the engine's streaming
 * WorkbookReader needs it early (it crashes on "reading 'sheets'" otherwise), so
 * the generated buffer is re-packed with jszip in canonical part order before it
 * is written to disk. Mirrors `writeXlsx` in packages/engine/test/tabular.test.ts.
 *
 * Run once: `pnpm tsx scripts/genFixtures.ts` — the produced .xlsx is committed.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";

const HERE = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
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

  // Re-pack so the streaming reader finds xl/workbook.xml before the worksheets.
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

  const path = join(HERE, "fixtures", "regional_summary.xlsx");
  writeFileSync(path, await out.generateAsync({ type: "nodebuffer" }));
  console.log("wrote scripts/fixtures/regional_summary.xlsx");
}
main();
