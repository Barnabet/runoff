import { describe, it, expect, beforeEach, vi } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import type { ParsePlan } from "@runoff/core";
import { runWarehouseSql } from "@runoff/core";
import { freshDb } from "./helpers";
import { getDb } from "../lib/db";
import { fileSource } from "../lib/sourceManager";

// proposeParsePlan is mocked (the replan route drives it through planForUpload);
// the executor + loaders stay real so plans run against the on-disk fixtures.
const { proposeMock } = vi.hoisted(() => ({ proposeMock: vi.fn() }));
vi.mock("@runoff/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@runoff/engine")>()),
  proposeParsePlan: (...args: unknown[]) => proposeMock(...args),
}));
// The LLM client is constructed but never used (proposeParsePlan is mocked).
vi.mock("../lib/llm", () => ({ getLlmClient: () => ({}) }));

const projectId = "proj_1";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
let db: ReturnType<typeof getDb>;
let filesDir: string;

beforeEach(() => {
  freshDb();
  proposeMock.mockReset();
  db = getDb();
  db.sqlite.prepare("INSERT INTO projects (id, name) VALUES (?, 'P')").run(projectId);
  filesDir = process.env.RUNOFF_FILES_DIR!;
  mkdirSync(filesDir, { recursive: true });
});

const srcCtx = (id: string, sourceId: string) => ({ params: Promise.resolve({ id, sourceId }) });

function addSource(id: string, name: string, storedFilename: string, opts: { mime?: string; proposal?: unknown } = {}) {
  db.sqlite
    .prepare("INSERT INTO sources (id, project_id, name, stored_filename, mime, size, proposal) VALUES (?, ?, ?, ?, ?, 1, ?)")
    .run(id, projectId, name, storedFilename, opts.mime ?? XLSX_MIME, opts.proposal === undefined ? null : JSON.stringify(opts.proposal));
}

// Build a valid .xlsx on disk under `storedFilename`, workbook.xml re-packed
// first (the mandated WorkbookReader assumes that order).
async function writeXlsx(storedFilename: string, build: (ws: ExcelJS.Worksheet) => void): Promise<void> {
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
  writeFileSync(join(filesDir, storedFilename), Buffer.from((await out.generateAsync({ type: "arraybuffer" })) as ArrayBuffer));
}

// A messy aging file: title row, header, two clean rows with currency, a total.
function writeAgingFile(storedFilename: string): Promise<void> {
  return writeXlsx(storedFilename, (ws) => {
    ws.addRow(["AR Aging Report"]);
    ws.addRow(["Customer", "Amount Due ($)"]);
    ws.addRow(["Acme", "$1,000.00"]);
    ws.addRow(["Beta", "$2,500.50"]);
    ws.addRow(["Grand Total", "$3,500.50"]);
  });
}

const AGING_PLAN: ParsePlan = {
  version: 1,
  tables: [{
    name: "aging",
    anchor: { headerSignature: ["customer", "amount due ($)"], minMatch: 2 },
    headerRows: 1,
    exclude: [{ column: "customer", pattern: "^grand total$" }],
    columns: [
      { from: "Customer", name: "customer", type: "TEXT" },
      { from: "Amount Due ($)", name: "amount_due", type: "REAL", parse: "currency" },
    ],
    onPeriodMismatch: "keep",
  }],
};

describe("fileSource — plan path", () => {
  it("executes a proposal plan end-to-end: currency coerced, total excluded, plan/report persisted", async () => {
    await writeAgingFile("aging.xlsx");
    addSource("s1", "aging.xlsx", "aging.xlsx", { proposal: { plan: AGING_PLAN } });
    const res = await fileSource(db, {
      projectId, sourceId: "s1",
      newFamily: { key: "aging", label: "Aging", kind: "periodic", granularity: "quarter" },
      period: "2026-Q1",
    });
    expect(res).toEqual({ ok: true });

    const out = runWarehouseSql(projectId, "SELECT COUNT(*) AS n, SUM(amount_due) AS s FROM fam_aging WHERE _period = :period", { period: "2026-Q1" });
    expect(out.rows[0]).toEqual([2, 3500.5]); // Grand Total row excluded; currency coerced

    const fam = db.sqlite.prepare("SELECT parse_plan AS p FROM source_families WHERE key = 'aging'").get() as { p: string | null };
    expect(JSON.parse(fam.p!)).toEqual(AGING_PLAN);
    const src = db.sqlite.prepare("SELECT parse_report AS r FROM sources WHERE id = 's1'").get() as { r: string | null };
    expect(JSON.parse(src.r!).tables[0].rowsKept).toBe(2);
  });

  it("reuses the family's stored plan when the source row proposal has no plan", async () => {
    await writeAgingFile("aging2.xlsx");
    db.sqlite
      .prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity, parse_plan) VALUES ('fam_st', ?, 'aging', 'Aging', 'periodic', 'quarter', ?)")
      .run(projectId, JSON.stringify(AGING_PLAN));
    addSource("s1", "aging2.xlsx", "aging2.xlsx"); // proposal NULL
    const res = await fileSource(db, { projectId, sourceId: "s1", familyId: "fam_st", period: "2026-Q1" });
    expect(res).toEqual({ ok: true });

    const out = runWarehouseSql(projectId, "SELECT COUNT(*) AS n, SUM(amount_due) AS s FROM fam_aging WHERE _period = :period", { period: "2026-Q1" });
    expect(out.rows[0]).toEqual([2, 3500.5]);
  });

  it("honours a periodMismatch: \"exclude\" override, dropping out-of-period rows", async () => {
    await writeXlsx("dated.xlsx", (ws) => {
      ws.addRow(["Customer", "Amount Due ($)", "Date"]);
      ws.addRow(["Acme", "$100.00", "2026-01-15"]);
      ws.addRow(["Beta", "$200.00", "2026-02-20"]);
      ws.addRow(["Gamma", "$300.00", "2026-04-15"]); // Q2 — out of slot
    });
    const plan: ParsePlan = {
      version: 1,
      tables: [{
        name: "aging",
        anchor: { headerSignature: ["customer", "amount due ($)", "date"], minMatch: 3 },
        headerRows: 1,
        exclude: [],
        columns: [
          { from: "Customer", name: "customer", type: "TEXT" },
          { from: "Amount Due ($)", name: "amount_due", type: "REAL", parse: "currency" },
          { from: "Date", name: "txn_date", type: "TEXT", parse: "date" },
        ],
        periodColumn: "txn_date",
        onPeriodMismatch: "keep",
      }],
    };
    addSource("s1", "dated.xlsx", "dated.xlsx", { proposal: { plan } });
    const res = await fileSource(db, {
      projectId, sourceId: "s1",
      newFamily: { key: "aging", label: "Aging", kind: "periodic", granularity: "quarter" },
      period: "2026-Q1",
      periodMismatch: "exclude",
    });
    expect(res).toEqual({ ok: true });

    const out = runWarehouseSql(projectId, "SELECT customer FROM fam_aging WHERE _period = :period ORDER BY customer", { period: "2026-Q1" });
    expect(out.rows.map((r) => r[0])).toEqual(["Acme", "Beta"]); // Gamma (Q2) dropped
  });

  it("rolls back with `ingest failed: plan produced no rows` when every row is excluded", async () => {
    await writeAgingFile("aging3.xlsx");
    const plan: ParsePlan = {
      ...AGING_PLAN,
      tables: [{ ...AGING_PLAN.tables[0], exclude: [{ column: null, pattern: "." }] }],
    };
    addSource("s1", "aging3.xlsx", "aging3.xlsx", { proposal: { plan } });
    const res = await fileSource(db, {
      projectId, sourceId: "s1",
      newFamily: { key: "aging", label: "Aging", kind: "periodic", granularity: "quarter" },
      period: "2026-Q1",
    });
    expect(res).toEqual({ error: "ingest failed: plan produced no rows", status: 500 });
    expect(db.sqlite.prepare("SELECT status FROM sources WHERE id = 's1'").get()).toEqual({ status: "unfiled" });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM source_families WHERE key = 'aging'").get()).toEqual({ n: 0 });
  });

  it("rolls back with `ingest failed: unanchored table: <name>` when the signature matches nothing", async () => {
    await writeAgingFile("aging4.xlsx");
    const plan: ParsePlan = {
      ...AGING_PLAN,
      tables: [{ ...AGING_PLAN.tables[0], anchor: { headerSignature: ["zzz", "qqq"], minMatch: 2 } }],
    };
    addSource("s1", "aging4.xlsx", "aging4.xlsx", { proposal: { plan } });
    const res = await fileSource(db, {
      projectId, sourceId: "s1",
      newFamily: { key: "aging", label: "Aging", kind: "periodic", granularity: "quarter" },
      period: "2026-Q1",
    });
    expect(res).toEqual({ error: "ingest failed: unanchored table: aging", status: 500 });
    expect(db.sqlite.prepare("SELECT status FROM sources WHERE id = 's1'").get()).toEqual({ status: "unfiled" });
  });

  it("plan-less family ingest still produces the v1.3b island-path result", async () => {
    writeFileSync(join(filesDir, "plain.csv"), "campaign,spend\nbrand,100\nsearch,200\n");
    addSource("s1", "plain.csv", "plain.csv", { mime: "text/csv" }); // no proposal.plan, no stored plan
    const res = await fileSource(db, {
      projectId, sourceId: "s1",
      newFamily: { key: "spend", label: "Spend", kind: "periodic", granularity: "quarter" },
      period: "2026-Q1",
    });
    expect(res).toEqual({ ok: true });
    const out = runWarehouseSql(projectId, "SELECT campaign, spend FROM fam_spend WHERE _period = :period ORDER BY campaign", { period: "2026-Q1" });
    expect(out.rows).toEqual([["brand", 100], ["search", 200]]);
    // island path does NOT persist a plan or report
    expect(db.sqlite.prepare("SELECT parse_plan AS p FROM source_families WHERE key = 'spend'").get()).toEqual({ p: null });
    expect(db.sqlite.prepare("SELECT parse_report AS r FROM sources WHERE id = 's1'").get()).toEqual({ r: null });
  });
});

describe("replan route", () => {
  const REVISED_PLAN: ParsePlan = {
    version: 1,
    tables: [{
      name: "sales",
      anchor: { headerSignature: ["customer", "amount"], minMatch: 2 },
      headerRows: 1,
      exclude: [{ column: "customer", pattern: "^total$" }],
      columns: [
        { from: "customer", name: "customer", type: "TEXT" },
        { from: "amount", name: "amount", type: "INTEGER" },
      ],
      onPeriodMismatch: "keep",
    }],
  };
  const STORED_PLAN: ParsePlan = {
    ...REVISED_PLAN,
    tables: [{ ...REVISED_PLAN.tables[0], exclude: [] }],
  };

  async function seedSalesSource(): Promise<void> {
    await writeXlsx("sales.xlsx", (ws) => {
      ws.addRow(["customer", "amount"]);
      ws.addRow(["cust_a", 10]);
      ws.addRow(["cust_b", 20]);
    });
    addSource("s1", "sales.xlsx", "sales.xlsx", {
      proposal: { newFamily: { key: "sales", label: "Sales", kind: "periodic", granularity: "quarter" }, period: "2026-Q1", plan: STORED_PLAN, planStatus: "proposed" },
    });
  }

  it("revises the plan with feedback and returns 200 with the updated proposal", async () => {
    const route = await import("../app/api/projects/[id]/sources/[sourceId]/replan/route");
    await seedSalesSource();
    proposeMock.mockResolvedValueOnce(REVISED_PLAN);
    const res = await route.POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ feedback: "drop the total row" }) }),
      srcCtx(projectId, "s1"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposal: { plan: ParsePlan; planStatus: string } };
    expect(body.proposal.plan).toEqual(REVISED_PLAN);
    expect(body.proposal.planStatus).toBe("amended");
    const stored = db.sqlite.prepare("SELECT proposal FROM sources WHERE id = 's1'").get() as { proposal: string };
    expect(JSON.parse(stored.proposal).plan).toEqual(REVISED_PLAN);
  });

  it("returns 500 `replan failed: no plan produced` and leaves the proposal intact when the proposer yields nothing", async () => {
    const route = await import("../app/api/projects/[id]/sources/[sourceId]/replan/route");
    await seedSalesSource();
    proposeMock.mockResolvedValue(null);
    const res = await route.POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ feedback: "nope" }) }),
      srcCtx(projectId, "s1"),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "replan failed: no plan produced" });
    const stored = db.sqlite.prepare("SELECT proposal FROM sources WHERE id = 's1'").get() as { proposal: string };
    expect(JSON.parse(stored.proposal).plan).toEqual(STORED_PLAN); // unchanged
  });
});
