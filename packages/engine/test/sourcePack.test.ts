import { describe, it, expect, vi } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";
import { buildSourcePack, packForPrompt } from "../src/sourcePack.js";

// DOCX has no fixture; cover its dispatch branch by mocking the mammoth call.
vi.mock("mammoth", () => ({
  default: {
    extractRawText: vi.fn(async () => ({ value: "Quarterly notes.\nGrowth held steady across channels." })),
  },
}));

const here = dirname(fileURLToPath(import.meta.url));

describe("buildSourcePack", () => {
  it("parses CSV into a typed table with summary", async () => {
    const pack = await buildSourcePack([
      { id: "src_spend", name: "spend_june.csv", mime: "text/csv", path: join(here, "fixtures/spend.csv") },
    ]);
    const s = pack.sources[0];
    expect(s.kind).toBe("table");
    expect(s.tables![0].columns).toEqual(["date", "channel", "amount"]);
    expect(s.tables![0].rows[0].amount).toBe(120050);
    expect(s.summary).toContain("2 rows");
    expect(packForPrompt(pack, ["src_spend"])).toContain("spend_june.csv");
  });

  it("summarizes numeric columns and truncates rows in packForPrompt", async () => {
    const pack = await buildSourcePack([
      { id: "src_spend", name: "spend_june.csv", mime: "text/csv", path: join(here, "fixtures/spend.csv") },
    ]);
    expect(pack.sources[0].summary).toBe(
      "spend_june.csv — 2 rows · columns: date, channel, amount (sum 240,100)",
    );
    const prompt = packForPrompt(pack, ["src_spend"], 1);
    expect(prompt).toContain("date,channel,amount");
    expect(prompt).toContain("1 more rows");
  });

  it("round-trips an XLSX workbook into one table per worksheet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runoff-xlsx-"));
    const path = join(dir, "kpi.xlsx");
    try {
      const wb = new ExcelJS.Workbook();
      const sheet = wb.addWorksheet("Q2");
      sheet.addRow(["month", "revenue"]);
      sheet.addRow(["apr", 1000]);
      sheet.addRow(["may", 2500]);
      await wb.xlsx.writeFile(path);

      const pack = await buildSourcePack([
        {
          id: "src_kpi",
          name: "kpi.xlsx",
          mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          path,
        },
      ]);
      const s = pack.sources[0];
      expect(s.kind).toBe("table");
      expect(s.tables![0].name).toBe("Q2");
      expect(s.tables![0].columns).toEqual(["month", "revenue"]);
      expect(s.tables![0].rows).toHaveLength(2);
      expect(s.tables![0].rows[0]).toEqual({ month: "apr", revenue: 1000 });
      expect(s.summary).toContain("revenue (sum 3,500)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("extracts DOCX text via mammoth (dispatch by mime)", async () => {
    const pack = await buildSourcePack([
      {
        id: "src_notes",
        name: "notes.docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        path: "/does/not/matter.docx",
      },
    ]);
    const s = pack.sources[0];
    expect(s.kind).toBe("document");
    expect(s.text).toContain("Quarterly notes.");
    expect(s.summary).toContain("document");
    expect(packForPrompt(pack, ["src_notes"])).toContain("Growth held steady");
  });

  it("packs a PDF as base64 with a read-at-run-time summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runoff-pdf-"));
    const path = join(dir, "deck.pdf");
    try {
      await writeFile(path, Buffer.from("%PDF-1.4 minimal", "utf8"));
      const pack = await buildSourcePack([
        { id: "src_deck", name: "deck.pdf", mime: "application/pdf", path },
      ]);
      const s = pack.sources[0];
      expect(s.kind).toBe("pdf");
      expect(s.pdfBase64).toBe(Buffer.from("%PDF-1.4 minimal", "utf8").toString("base64"));
      expect(s.summary).toContain("PDF");
      expect(s.summary).toContain("(read at run time)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
