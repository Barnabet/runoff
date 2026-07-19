import { describe, it, expect, vi } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildSourcePack, packForPrompt } from "../src/sourcePack.js";

// DOCX has no fixture; cover its dispatch branch by mocking the mammoth call.
vi.mock("mammoth", () => ({
  default: {
    extractRawText: vi.fn(async () => ({ value: "Quarterly notes.\nGrowth held steady across channels." })),
  },
}));

// PDFs are text-extracted locally; mock pdf-parse the same way as mammoth.
vi.mock("pdf-parse/lib/pdf-parse.js", () => ({
  default: vi.fn(async () => ({ text: "Extracted PDF body text.\nQuarter over quarter growth." })),
}));

const here = dirname(fileURLToPath(import.meta.url));

describe("buildSourcePack", () => {
  it("skips tabular files entirely — the warehouse owns them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runoff-skip-"));
    const mdPath = join(dir, "notes.md");
    try {
      await writeFile(mdPath, "# Notes\nQuarter over quarter growth held.");
      const pack = await buildSourcePack([
        { id: "famT", name: "spend.csv", mime: "text/csv", path: join(here, "fixtures/spend.csv") },
        { id: "famD", name: "notes.md", mime: "text/markdown", path: mdPath },
      ]);
      expect(pack.sources.map((s) => s.id)).toEqual(["famD"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips an XLSX file by mime and extension", async () => {
    const pack = await buildSourcePack([
      {
        id: "famX",
        name: "kpi.xlsx",
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        path: "/does/not/matter.xlsx",
      },
    ]);
    expect(pack.sources).toEqual([]);
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

  it("extracts PDF text locally with a read-at-run-time summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runoff-pdf-"));
    const path = join(dir, "deck.pdf");
    try {
      await writeFile(path, Buffer.from("%PDF-1.4 minimal", "utf8"));
      const pack = await buildSourcePack([
        { id: "src_deck", name: "deck.pdf", mime: "application/pdf", path },
      ]);
      const s = pack.sources[0];
      expect(s.kind).toBe("pdf");
      expect(s.text).toContain("Extracted PDF body text.");
      expect(s.summary).toContain("PDF");
      expect(s.summary).toContain("(read at run time)");
      expect(packForPrompt(pack, ["src_deck"])).toContain("Quarter over quarter growth");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
