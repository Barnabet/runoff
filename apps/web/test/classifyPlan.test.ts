import { describe, it, expect, beforeEach, vi } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import type { ParsePlan } from "@runoff/core";
import { freshDb } from "./helpers";
import { getDb } from "../lib/db";

// classifySource and proposeParsePlan are both mocked so no LLM call happens;
// loadGrids / scanTabular / executeParsePlan / fitParsePlan stay real so the
// plan actually runs against the on-disk fixture.
const { classifyMock, proposeMock } = vi.hoisted(() => ({ classifyMock: vi.fn(), proposeMock: vi.fn() }));
vi.mock("@runoff/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@runoff/engine")>()),
  classifySource: (...args: unknown[]) => classifyMock(...args),
  proposeParsePlan: (...args: unknown[]) => proposeMock(...args),
}));
// The LLM client is constructed but never used (both engine calls are mocked).
vi.mock("../lib/llm", () => ({ getLlmClient: () => ({}) }));

beforeEach(() => {
  freshDb();
  classifyMock.mockReset();
  proposeMock.mockReset();
  getDb().sqlite.prepare("INSERT INTO projects (id, name) VALUES ('proj_1','P')").run();
});

const projCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// A plan that cleanly parses the customer/amount fixture into one table.
const GOOD_PLAN: ParsePlan = {
  version: 1,
  tables: [{
    name: "sales",
    anchor: { headerSignature: ["customer", "amount"], minMatch: 2 },
    headerRows: 1,
    exclude: [],
    columns: [
      { from: "customer", name: "customer", type: "TEXT" },
      { from: "amount", name: "amount", type: "INTEGER" },
    ],
    onPeriodMismatch: "keep",
  }],
};

// A structurally valid plan whose signature anchors nothing → degenerate.
const BAD_PLAN: ParsePlan = {
  version: 1,
  tables: [{
    name: "sales",
    anchor: { headerSignature: ["zzz", "qqq"], minMatch: 2 },
    headerRows: 1,
    exclude: [],
    columns: [{ from: "zzz", name: "z", type: "TEXT" }],
    onPeriodMismatch: "keep",
  }],
};

// Build a valid .xlsx in-memory, then reorder the zip so workbook.xml streams
// before the worksheets (the mandated WorkbookReader assumes that order).
async function xlsxFile(name: string, build: (ws: ExcelJS.Worksheet, wb: ExcelJS.Workbook) => void): Promise<File> {
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
  const bytes = (await out.generateAsync({ type: "arraybuffer" })) as ArrayBuffer;
  return new File([bytes], name, { type: XLSX_MIME });
}

// customer/amount table with 10 data rows so the 8-row preview cap truncates.
function salesFile(name = "sales.xlsx"): Promise<File> {
  return xlsxFile(name, (ws) => {
    ws.addRow(["customer", "amount"]);
    for (let i = 1; i <= 10; i++) ws.addRow([`cust_${i}`, i * 10]);
  });
}

async function uploadFiles(id: string, files: File[]): Promise<{ id: string }[]> {
  const route = await import("../app/api/projects/[id]/sources/route");
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  const res = await route.POST(new Request("http://x", { method: "POST", body: fd }), projCtx(id));
  return (await res.json()).sources as { id: string }[];
}

async function classify(id: string, sourceIds: string[]): Promise<Response> {
  const route = await import("../app/api/projects/[id]/sources/classify/route");
  return route.POST(new Request("http://x", { method: "POST", body: JSON.stringify({ sourceIds }) }), projCtx(id));
}

function storedProposal(sourceId: string): Record<string, unknown> {
  const row = getDb().sqlite.prepare("SELECT proposal FROM sources WHERE id = ?").get(sourceId) as { proposal: string | null };
  expect(row.proposal).not.toBeNull();
  return JSON.parse(row.proposal!) as Record<string, unknown>;
}

describe("classify plan integration", () => {
  it("fresh proposal: proposes a plan, attaches preview/report, calls the proposer once", async () => {
    const [src] = await uploadFiles("proj_1", [await salesFile()]);
    classifyMock.mockResolvedValueOnce({ newFamily: { key: "sales", label: "Sales", kind: "periodic", granularity: "quarter" }, period: "2026-Q1", confidence: "high" as const });
    proposeMock.mockResolvedValueOnce(GOOD_PLAN);

    expect((await classify("proj_1", [src.id])).status).toBe(200);
    expect(proposeMock).toHaveBeenCalledTimes(1);

    const p = storedProposal(src.id) as any;
    expect(p.plan).toEqual(GOOD_PLAN);
    expect(p.planStatus).toBe("proposed");
    expect(p.preview.tables[0].rows.length).toBeLessThanOrEqual(8);
    expect(p.report.tables[0].rowsKept).toBe(10);
    expect(p.tables).toEqual([{ name: "fam_sales", columns: ["customer", "amount"], rowCount: 10 }]);
  });

  it("stored-plan fit path: reuses the stored plan with zero LLM calls", async () => {
    getDb().sqlite
      .prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity, parse_plan) VALUES ('fam_s','proj_1','sales','Sales','periodic','quarter',?)")
      .run(JSON.stringify(GOOD_PLAN));
    const [src] = await uploadFiles("proj_1", [await salesFile()]);
    classifyMock.mockResolvedValueOnce({ familyKey: "sales", period: "2026-Q1", confidence: "high" as const });

    expect((await classify("proj_1", [src.id])).status).toBe(200);
    expect(proposeMock).not.toHaveBeenCalled();

    const p = storedProposal(src.id) as any;
    expect(p.planStatus).toBe("stored");
    expect(p.plan).toEqual(GOOD_PLAN);
    expect(p.report.tables[0].rowsKept).toBe(10);
  });

  it("self-check round: a degenerate first plan triggers a second propose", async () => {
    const [src] = await uploadFiles("proj_1", [await salesFile()]);
    classifyMock.mockResolvedValueOnce({ newFamily: { key: "sales", label: "Sales", kind: "periodic", granularity: "quarter" }, period: "2026-Q1", confidence: "high" as const });
    proposeMock.mockResolvedValueOnce(BAD_PLAN).mockResolvedValueOnce(GOOD_PLAN);

    expect((await classify("proj_1", [src.id])).status).toBe(200);
    expect(proposeMock).toHaveBeenCalledTimes(2);

    const p = storedProposal(src.id) as any;
    expect(p.planStatus).toBe("proposed");
    expect(p.plan).toEqual(GOOD_PLAN);
    expect(p.report.tables[0].problems).toEqual([]);
    expect(p.report.tables[0].rowsKept).toBe(10);
  });

  it("proposer null: keeps a plan-less classify proposal (byte-identical v1.3b enrichment)", async () => {
    const [src] = await uploadFiles("proj_1", [await salesFile()]);
    classifyMock.mockResolvedValueOnce({ newFamily: { key: "sales", label: "Sales", kind: "periodic", granularity: "quarter" }, period: "2026-Q1", confidence: "high" as const });
    proposeMock.mockResolvedValue(null);

    expect((await classify("proj_1", [src.id])).status).toBe(200);
    expect(proposeMock).toHaveBeenCalled();

    const p = storedProposal(src.id) as any;
    expect(p.plan).toBeUndefined();
    expect(p.planStatus).toBeUndefined();
    expect(p.preview).toBeUndefined();
    // The classify proposal itself is intact, with scan-based enrichment.
    expect(p.newFamily.key).toBe("sales");
    expect(p.tables).toEqual([{ name: "fam_sales", columns: ["customer", "amount"], rowCount: 10 }]);
  });
});
