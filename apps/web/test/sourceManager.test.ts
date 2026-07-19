import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { applySchema, attachWarehouse, detachWarehouse, warehousePath } from "@runoff/core";
import { freshDb } from "./helpers";
import { getDb } from "../lib/db";
import { fileSource, listProjectSources } from "../lib/sourceManager";

// classifySource is mocked so no network/LLM call happens; buildSourcePack /
// packForPrompt (used by readContentSample) stay real so readContentSample
// still parses the on-disk sample file.
const { classifyMock } = vi.hoisted(() => ({ classifyMock: vi.fn() }));
vi.mock("@runoff/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@runoff/engine")>()),
  classifySource: (...args: unknown[]) => classifyMock(...args),
}));
// The LLM client is constructed but never used (classifySource is mocked).
vi.mock("../lib/llm", () => ({ getLlmClient: () => ({}) }));

beforeEach(() => {
  freshDb();
  classifyMock.mockReset();
});

function makeTestDb() {
  return getDb();
}

function seedProject(db: ReturnType<typeof makeTestDb>) {
  db.sqlite.prepare("INSERT INTO projects (id, name) VALUES ('proj_1','P')").run();
  db.sqlite.prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES ('fam_q','proj_1','trade_data','Trade data','periodic','quarter')").run();
  db.sqlite.prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES ('fam_c','proj_1','brand','Brand','constant',NULL)").run();
  // fileSource now scans+ingests tabular files, so each seeded (.csv-named)
  // source needs a real, non-empty table on disk.
  const filesDir = process.env.RUNOFF_FILES_DIR!;
  mkdirSync(filesDir, { recursive: true });
  writeFileSync(join(filesDir, "sf_a"), "a,b\n1,2\n");
  writeFileSync(join(filesDir, "sf_b"), "a,b\n3,4\n");
  writeFileSync(join(filesDir, "sf_c"), "a,b\n5,6\n");
  const ins = db.sqlite.prepare("INSERT INTO sources (id, project_id, name, stored_filename, mime, size) VALUES (?, 'proj_1', ?, ?, 'text/csv', 1)");
  ins.run("src_a", "a.csv", "sf_a");
  ins.run("src_b", "b.csv", "sf_b");
  ins.run("src_c", "c.pdf", "sf_c");
}

const projCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const srcCtx = (id: string, sourceId: string) => ({ params: Promise.resolve({ id, sourceId }) });

describe("fileSource", () => {
  it("files into an existing periodic family and replaces an occupant", async () => {
    const db = makeTestDb(); seedProject(db);
    expect(await fileSource(db, { projectId: "proj_1", sourceId: "src_a", familyId: "fam_q", period: "2026-Q1" })).toEqual({ ok: true });
    expect(await fileSource(db, { projectId: "proj_1", sourceId: "src_b", familyId: "fam_q", period: "2026-Q1" })).toEqual({ ok: true });
    const rows = db.sqlite.prepare("SELECT id, status FROM sources WHERE family_id='fam_q' ORDER BY id").all();
    expect(rows).toEqual([{ id: "src_a", status: "replaced" }, { id: "src_b", status: "filed" }]);
  });

  it("rejects a period that fails the family's granularity", async () => {
    const db = makeTestDb(); seedProject(db);
    expect(await fileSource(db, { projectId: "proj_1", sourceId: "src_a", familyId: "fam_q", period: "2026-06" })).toMatchObject({ status: 400 });
    expect(await fileSource(db, { projectId: "proj_1", sourceId: "src_a", familyId: "fam_q", period: null })).toMatchObject({ status: 400 });
  });

  it("enforces the constant rules: null period, single live file replaced on refile", async () => {
    const db = makeTestDb(); seedProject(db);
    expect(await fileSource(db, { projectId: "proj_1", sourceId: "src_c", familyId: "fam_c", period: "2026-Q1" })).toMatchObject({ status: 400 });
    expect(await fileSource(db, { projectId: "proj_1", sourceId: "src_c", familyId: "fam_c", period: null })).toEqual({ ok: true });
    expect(await fileSource(db, { projectId: "proj_1", sourceId: "src_a", familyId: "fam_c", period: null })).toEqual({ ok: true });
    const live = db.sqlite.prepare("SELECT id FROM sources WHERE family_id='fam_c' AND status='filed'").all();
    expect(live).toEqual([{ id: "src_a" }]);
  });

  it("creates a new family transactionally and rejects duplicate keys", async () => {
    const db = makeTestDb(); seedProject(db);
    expect(await fileSource(db, { projectId: "proj_1", sourceId: "src_a", newFamily: { key: "ga4", label: "GA4", kind: "periodic", granularity: "month" }, period: "2026-06" })).toEqual({ ok: true });
    expect(await fileSource(db, { projectId: "proj_1", sourceId: "src_b", newFamily: { key: "ga4", label: "GA4 again", kind: "periodic", granularity: "month" }, period: "2026-07" })).toMatchObject({ status: 400 });
  });

  it("does not create the new family when the period fails validation, then succeeds on retry", async () => {
    const db = makeTestDb(); seedProject(db);
    expect(await fileSource(db, { projectId: "proj_1", sourceId: "src_a", newFamily: { key: "ga4", label: "GA4", kind: "periodic", granularity: "month" }, period: "bad" })).toMatchObject({ status: 400 });
    // The failed attempt must NOT have committed an orphan family row.
    expect(db.sqlite.prepare("SELECT id FROM source_families WHERE project_id='proj_1' AND key='ga4'").get()).toBeUndefined();
    // Retrying with a valid period now succeeds (no "already exists" collision).
    expect(await fileSource(db, { projectId: "proj_1", sourceId: "src_a", newFamily: { key: "ga4", label: "GA4", kind: "periodic", granularity: "month" }, period: "2026-06" })).toEqual({ ok: true });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM source_families WHERE project_id='proj_1' AND key='ga4'").get()).toEqual({ n: 1 });
  });

  it("listProjectSources groups by family with ascending periods and surfaces unfiled rows", async () => {
    const db = makeTestDb(); seedProject(db);
    await fileSource(db, { projectId: "proj_1", sourceId: "src_b", familyId: "fam_q", period: "2026-Q2" });
    await fileSource(db, { projectId: "proj_1", sourceId: "src_a", familyId: "fam_q", period: "2026-Q1" });
    const { families, unfiled } = listProjectSources(db, "proj_1");
    const q = families.find((f) => f.key === "trade_data")!;
    expect(q.filedPeriods).toEqual(["2026-Q1", "2026-Q2"]);
    // filedEntries carry the per-period sourceId + name (ascending) so the UI can
    // wire refile/delete on each periodic cell.
    expect(q.filedEntries).toEqual([
      { period: "2026-Q1", sourceId: "src_a", name: "a.csv" },
      { period: "2026-Q2", sourceId: "src_b", name: "b.csv" },
    ]);
    expect(unfiled.map((u) => u.id)).toEqual(["src_c"]);
  });

  it("surfaces the live file of a constant family and null otherwise; constants have no filedEntries", async () => {
    const db = makeTestDb(); seedProject(db);
    await fileSource(db, { projectId: "proj_1", sourceId: "src_c", familyId: "fam_c", period: null });
    const { families } = listProjectSources(db, "proj_1");
    const brand = families.find((f) => f.key === "brand")!;
    expect(brand.liveFile).toEqual({ sourceId: "src_c", name: "c.pdf" });
    expect(brand.filedEntries).toEqual([]);
    expect(families.find((f) => f.key === "trade_data")!.liveFile).toBeNull();
  });
});

describe("fileSource — warehouse ingestion", () => {
  const projectId = "proj_1";
  let db: ReturnType<typeof makeTestDb>;
  let filesDir: string;

  beforeEach(() => {
    db = makeTestDb();
    db.sqlite.prepare("INSERT INTO projects (id, name) VALUES (?, 'P')").run(projectId);
    filesDir = process.env.RUNOFF_FILES_DIR!;
    mkdirSync(filesDir, { recursive: true });
  });

  function addSource(id: string, name: string, storedFilename: string, mime = "text/csv") {
    db.sqlite
      .prepare("INSERT INTO sources (id, project_id, name, stored_filename, mime, size) VALUES (?, ?, ?, ?, ?, 1)")
      .run(id, projectId, name, storedFilename, mime);
  }

  it("confirm of a CSV ingests rows into the warehouse under fam_<key>", async () => {
    writeFileSync(join(filesDir, "s1.csv"), "campaign,spend\nbrand,100\nsearch,200\n");
    addSource("s1", "s1.csv", "s1.csv");
    const res = await fileSource(db, { projectId, sourceId: "s1", newFamily: { key: "spend", label: "Spend", kind: "periodic", granularity: "quarter" }, period: "2026-Q1" });
    expect(res).toEqual({ ok: true });
    attachWarehouse(db.sqlite, projectId);
    const rows = db.sqlite.prepare("SELECT campaign, spend, _period FROM wh.fam_spend ORDER BY campaign").all();
    detachWarehouse(db.sqlite);
    expect(rows).toEqual([
      { campaign: "brand", spend: 100, _period: "2026-Q1" },
      { campaign: "search", spend: 200, _period: "2026-Q1" },
    ]);
  });

  it("refiling a period swaps only that period's warehouse rows", async () => {
    writeFileSync(join(filesDir, "q1.csv"), "campaign,spend\nbrand,100\n");
    writeFileSync(join(filesDir, "q2.csv"), "campaign,spend\nsearch,200\n");
    writeFileSync(join(filesDir, "q1b.csv"), "campaign,spend\nvideo,999\n");
    addSource("q1", "q1.csv", "q1.csv");
    addSource("q2", "q2.csv", "q2.csv");
    addSource("q1b", "q1b.csv", "q1b.csv");
    await fileSource(db, { projectId, sourceId: "q1", newFamily: { key: "sp", label: "Sp", kind: "periodic", granularity: "quarter" }, period: "2026-Q1" });
    const famId = (db.sqlite.prepare("SELECT id FROM source_families WHERE key='sp'").get() as { id: string }).id;
    await fileSource(db, { projectId, sourceId: "q2", familyId: famId, period: "2026-Q2" });
    await fileSource(db, { projectId, sourceId: "q1b", familyId: famId, period: "2026-Q1" });
    attachWarehouse(db.sqlite, projectId);
    const rows = db.sqlite.prepare("SELECT campaign, _period FROM wh.fam_sp ORDER BY _period").all();
    detachWarehouse(db.sqlite);
    expect(rows).toEqual([
      { campaign: "video", _period: "2026-Q1" },
      { campaign: "search", _period: "2026-Q2" },
    ]);
    // the Q1 occupant was marked replaced, not deleted
    expect(db.sqlite.prepare("SELECT status FROM sources WHERE id = ?").get("q1")).toEqual({ status: "replaced" });
  });

  it("a tabular file with no detectable tables is rejected 400 without writes", async () => {
    writeFileSync(join(filesDir, "empty.csv"), "\n");
    addSource("empty", "empty.csv", "empty.csv");
    const res = await fileSource(db, { projectId, sourceId: "empty", newFamily: { key: "e", label: "E", kind: "periodic", granularity: "quarter" }, period: "2026-Q1" });
    expect(res).toEqual({ error: "no tables detected in file", status: 400 });
    // the source row is still unfiled and no family row was created
    expect(db.sqlite.prepare("SELECT status FROM sources WHERE id = ?").get("empty")).toEqual({ status: "unfiled" });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM source_families WHERE key = 'e'").get()).toEqual({ n: 0 });
  });

  it("a corrupt file whose scan rejects returns ingest failed 500 without throwing or writing", async () => {
    // Garbage bytes at a .xlsx path make scanTabular's zip reader reject; the
    // rejection must surface as the contractual 500, not escape as an exception.
    writeFileSync(join(filesDir, "bad.xlsx"), "not a real xlsx zip");
    addSource("bad", "bad.xlsx", "bad.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const res = await fileSource(db, { projectId, sourceId: "bad", newFamily: { key: "corrupt", label: "C", kind: "periodic", granularity: "quarter" }, period: "2026-Q1" });
    expect(res).toMatchObject({ error: expect.stringMatching(/^ingest failed: /), status: 500 });
    // no family row created and the source stayed unfiled (no status change)
    expect(db.sqlite.prepare("SELECT status FROM sources WHERE id = ?").get("bad")).toEqual({ status: "unfiled" });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM source_families WHERE key = 'corrupt'").get()).toEqual({ n: 0 });
  });

  it("an ingest failure mid-transaction rolls back app-DB writes", async () => {
    // Force readTabular to throw after a successful scan:
    const engine = await import("@runoff/engine");
    const spy = vi.spyOn(engine, "readTabular").mockRejectedValueOnce(new Error("boom"));
    writeFileSync(join(filesDir, "ok.csv"), "a,b\n1,2\n");
    addSource("ok", "ok.csv", "ok.csv");
    const res = await fileSource(db, { projectId, sourceId: "ok", newFamily: { key: "roll", label: "R", kind: "periodic", granularity: "quarter" }, period: "2026-Q1" });
    expect(res).toEqual({ error: "ingest failed: boom", status: 500 });
    expect(db.sqlite.prepare("SELECT status FROM sources WHERE id = ?").get("ok")).toEqual({ status: "unfiled" });
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM source_families WHERE key = 'roll'").get()).toEqual({ n: 0 });
    spy.mockRestore();
  });

  it("non-tabular files (pdf/txt) file without touching the warehouse", async () => {
    db.sqlite.prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES ('fam_brand', ?, 'brand', 'Brand', 'constant', NULL)").run(projectId);
    writeFileSync(join(filesDir, "doc.pdf"), "just prose, no table");
    addSource("doc", "doc.pdf", "doc.pdf", "application/pdf");
    const res = await fileSource(db, { projectId, sourceId: "doc", familyId: "fam_brand", period: null });
    expect(res).toEqual({ ok: true });
    // additionally assert no warehouse file was created
    expect(existsSync(warehousePath(projectId))).toBe(false);
  });
});

// ---- Routes -----------------------------------------------------------------

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Build a valid .xlsx in-memory, then reorder the zip so workbook.xml streams
// before the worksheets (the mandated WorkbookReader assumes that order — see
// the engine tabular tests). Returns a File ready to POST at the upload route.
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

async function uploadFiles(id: string, files: File[]): Promise<Response> {
  const route = await import("../app/api/projects/[id]/sources/route");
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  return route.POST(new Request("http://x", { method: "POST", body: fd }), projCtx(id));
}

describe("source manager routes", () => {
  beforeEach(() => {
    getDb().sqlite.prepare("INSERT INTO projects (id, name) VALUES ('proj_1','P')").run();
  });

  it("upload POST stores an unfiled row and writes the file", async () => {
    const file = new File([new TextEncoder().encode("a,b\n1,2\n")], "spend.csv", { type: "text/csv" });
    const res = await uploadFiles("proj_1", [file]);
    expect(res.status).toBe(200);
    const { sources } = (await res.json()) as { sources: { id: string; status: string; storedFilename: string }[] };
    expect(sources).toHaveLength(1);
    expect(sources[0].status).toBe("unfiled");
    expect(sources[0].id).toMatch(/^src_/);

    const row = getDb().sqlite.prepare("SELECT status, project_id AS projectId FROM sources WHERE id = ?").get(sources[0].id) as { status: string; projectId: string };
    expect(row).toEqual({ status: "unfiled", projectId: "proj_1" });
    expect(existsSync(join(process.env.RUNOFF_FILES_DIR!, sources[0].storedFilename))).toBe(true);
  });

  it("upload POST rejects a file over 100MB with 413 and inserts no row", async () => {
    // A real 100MB+ buffer is impractical; the handler reads `.size` before
    // buffering, so spoof it and assert the cap fires before any write/INSERT.
    // Feed the FormData straight to the handler (a real multipart round-trip
    // re-materialises the File and would drop the spoofed size).
    const route = await import("../app/api/projects/[id]/sources/route");
    const file = new File([new TextEncoder().encode("a,b\n1,2\n")], "huge.csv", { type: "text/csv" });
    Object.defineProperty(file, "size", { value: 101 * 1024 * 1024 });
    const fd = new FormData();
    fd.append("files", file);
    const req = { formData: async () => fd } as unknown as Request;
    const res = await route.POST(req, projCtx("proj_1"));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "file exceeds 100MB limit" });
    expect(getDb().sqlite.prepare("SELECT COUNT(*) AS n FROM sources").get()).toEqual({ n: 0 });
  });

  it("classify POST enriches the proposal with detected tables, skippedFragments, and drift", async () => {
    const classify = await import("../app/api/projects/[id]/sources/classify/route");
    const db = getDb();
    // An existing periodic family plus a pre-existing warehouse table whose
    // columns differ from the fixture — so drift is non-empty.
    db.sqlite.prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES ('fam_s','proj_1','spend','Spend','periodic','quarter')").run();
    attachWarehouse(db.sqlite, "proj_1");
    applySchema(db.sqlite, true, [{ name: "fam_spend__report_data", columns: [{ name: "campaign", type: "TEXT" }, { name: "budget", type: "INTEGER" }] }]);
    detachWarehouse(db.sqlite);

    // Two islands (report_data, report_data_2) plus a one-row note fragment.
    const file = await xlsxFile("messy.xlsx", (ws) => {
      ws.addRow(["campaign", "spend"]);
      ws.addRow(["brand", 100]);
      ws.addRow([]);
      ws.addRow(["Note: excludes agency fees"]);
      ws.addRow([]);
      ws.addRow(["region", "revenue"]);
      ws.addRow(["emea", 900]);
    });
    const up = await uploadFiles("proj_1", [file]);
    const { sources } = (await up.json()) as { sources: { id: string }[] };
    const src = sources[0];

    classifyMock.mockResolvedValueOnce({ familyKey: "spend", period: "2026-Q1", confidence: "high" as const });
    const res = await classify.POST(new Request("http://x", { method: "POST", body: JSON.stringify({ sourceIds: [src.id] }) }), projCtx("proj_1"));
    expect(res.status).toBe(200);

    const stored = db.sqlite.prepare("SELECT proposal FROM sources WHERE id = ?").get(src.id) as { proposal: string };
    const proposal = JSON.parse(stored.proposal) as { tables: { name: string; columns: string[]; rowCount: number }[]; skippedFragments: number; drift: string[] };
    expect(proposal.tables).toEqual([
      { name: "fam_spend__report_data", columns: ["campaign", "spend"], rowCount: 1 },
      { name: "fam_spend__report_data_2", columns: ["region", "revenue"], rowCount: 1 },
    ]);
    expect(proposal.skippedFragments).toBe(1);
    expect(proposal.drift.length).toBeGreaterThan(0);
    expect(proposal.drift).toContain("new table: fam_spend__report_data_2");
  });

  it("GET lists a project's families and unfiled rows; 404 for a missing project", async () => {
    const route = await import("../app/api/projects/[id]/sources/route");
    await uploadFiles("proj_1", [new File([new TextEncoder().encode("x")], "a.csv", { type: "text/csv" })]);
    const res = await route.GET(new Request("http://x"), projCtx("proj_1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { families: unknown[]; unfiled: unknown[] };
    expect(body.unfiled).toHaveLength(1);
    expect(Array.isArray(body.families)).toBe(true);

    const missing = await route.GET(new Request("http://x"), projCtx("proj_none"));
    expect(missing.status).toBe(404);
  });

  it("classify POST persists a mocked proposal and leaves NULL when the mock returns null", async () => {
    const classify = await import("../app/api/projects/[id]/sources/classify/route");
    const up = await uploadFiles("proj_1", [
      new File([new TextEncoder().encode("a,b\n1,2\n")], "one.csv", { type: "text/csv" }),
      new File([new TextEncoder().encode("c,d\n3,4\n")], "two.csv", { type: "text/csv" }),
    ]);
    const { sources } = (await up.json()) as { sources: { id: string }[] };
    const [s1, s2] = sources;

    const proposal = { familyKey: "trade_data", period: "2026-Q1", confidence: "high" as const };
    classifyMock.mockResolvedValueOnce(proposal).mockResolvedValueOnce(null);

    const res = await classify.POST(new Request("http://x", { method: "POST", body: JSON.stringify({ sourceIds: [s1.id, s2.id] }) }), projCtx("proj_1"));
    expect(res.status).toBe(200);
    expect(classifyMock).toHaveBeenCalledTimes(2);

    const db = getDb();
    const r1 = db.sqlite.prepare("SELECT proposal FROM sources WHERE id = ?").get(s1.id) as { proposal: string | null };
    const r2 = db.sqlite.prepare("SELECT proposal FROM sources WHERE id = ?").get(s2.id) as { proposal: string | null };
    // one.csv is tabular, so the stored proposal is enriched from the scan: a
    // single table (no warehouse yet → empty drift, no skipped fragments).
    expect(JSON.parse(r1.proposal!)).toEqual({
      ...proposal,
      tables: [{ name: "fam_trade_data", columns: ["a", "b"], rowCount: 1 }],
      skippedFragments: 0,
      drift: [],
    });
    expect(r2.proposal).toBeNull();
  });

  it("confirm POST files a source; DELETE removes the row and frees the slot", async () => {
    const confirm = await import("../app/api/projects/[id]/sources/confirm/route");
    const perSource = await import("../app/api/projects/[id]/sources/[sourceId]/route");
    const db = getDb();
    db.sqlite.prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES ('fam_q','proj_1','trade','Trade','periodic','quarter')").run();
    const up = await uploadFiles("proj_1", [new File([new TextEncoder().encode("a,b\n1,2\n")], "a.csv", { type: "text/csv" })]);
    const { sources } = (await up.json()) as { sources: { id: string; storedFilename: string }[] };
    const src = sources[0];

    const okRes = await confirm.POST(new Request("http://x", { method: "POST", body: JSON.stringify({ sourceId: src.id, familyId: "fam_q", period: "2026-Q1" }) }), projCtx("proj_1"));
    expect(okRes.status).toBe(200);
    expect(db.sqlite.prepare("SELECT status FROM sources WHERE id = ?").get(src.id)).toEqual({ status: "filed" });

    const del = await perSource.DELETE(new Request("http://x", { method: "DELETE" }), srcCtx("proj_1", src.id));
    expect(del.status).toBe(200);
    expect(db.sqlite.prepare("SELECT id FROM sources WHERE id = ?").get(src.id)).toBeUndefined();
    expect(existsSync(join(process.env.RUNOFF_FILES_DIR!, src.storedFilename))).toBe(false);
    // Slot is free: a new source can take 2026-Q1.
    const up2 = await uploadFiles("proj_1", [new File([new TextEncoder().encode("a,b\n3,4\n")], "b.csv", { type: "text/csv" })]);
    const { sources: s2 } = (await up2.json()) as { sources: { id: string }[] };
    expect(await fileSource(db, { projectId: "proj_1", sourceId: s2[0].id, familyId: "fam_q", period: "2026-Q1" })).toEqual({ ok: true });
  });

  it("PATCH refiles a source into a different slot", async () => {
    const perSource = await import("../app/api/projects/[id]/sources/[sourceId]/route");
    const db = getDb();
    db.sqlite.prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES ('fam_q','proj_1','trade','Trade','periodic','quarter')").run();
    const up = await uploadFiles("proj_1", [new File([new TextEncoder().encode("a,b\n1,2\n")], "a.csv", { type: "text/csv" })]);
    const { sources } = (await up.json()) as { sources: { id: string }[] };
    const src = sources[0];

    const res = await perSource.PATCH(new Request("http://x", { method: "PATCH", body: JSON.stringify({ familyId: "fam_q", period: "2026-Q2" }) }), srcCtx("proj_1", src.id));
    expect(res.status).toBe(200);
    expect(db.sqlite.prepare("SELECT period, status FROM sources WHERE id = ?").get(src.id)).toEqual({ period: "2026-Q2", status: "filed" });
  });

  it("DELETE refuses to remove a replaced row (400)", async () => {
    const perSource = await import("../app/api/projects/[id]/sources/[sourceId]/route");
    const db = getDb();
    db.sqlite.prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES ('fam_q','proj_1','trade','Trade','periodic','quarter')").run();
    const up = await uploadFiles("proj_1", [
      new File([new TextEncoder().encode("a,b\n1,2\n")], "a.csv", { type: "text/csv" }),
      new File([new TextEncoder().encode("a,b\n3,4\n")], "b.csv", { type: "text/csv" }),
    ]);
    const { sources } = (await up.json()) as { sources: { id: string }[] };
    await fileSource(db, { projectId: "proj_1", sourceId: sources[0].id, familyId: "fam_q", period: "2026-Q1" });
    await fileSource(db, { projectId: "proj_1", sourceId: sources[1].id, familyId: "fam_q", period: "2026-Q1" });
    // sources[0] is now 'replaced'.
    const res = await perSource.DELETE(new Request("http://x", { method: "DELETE" }), srcCtx("proj_1", sources[0].id));
    expect(res.status).toBe(400);
  });
});
