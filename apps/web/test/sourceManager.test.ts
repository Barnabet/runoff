import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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
  const ins = db.sqlite.prepare("INSERT INTO sources (id, project_id, name, stored_filename, mime, size) VALUES (?, 'proj_1', ?, ?, 'text/csv', 1)");
  ins.run("src_a", "a.csv", "sf_a");
  ins.run("src_b", "b.csv", "sf_b");
  ins.run("src_c", "c.pdf", "sf_c");
}

const projCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const srcCtx = (id: string, sourceId: string) => ({ params: Promise.resolve({ id, sourceId }) });

describe("fileSource", () => {
  it("files into an existing periodic family and replaces an occupant", () => {
    const db = makeTestDb(); seedProject(db);
    expect(fileSource(db, { projectId: "proj_1", sourceId: "src_a", familyId: "fam_q", period: "2026-Q1" })).toEqual({ ok: true });
    expect(fileSource(db, { projectId: "proj_1", sourceId: "src_b", familyId: "fam_q", period: "2026-Q1" })).toEqual({ ok: true });
    const rows = db.sqlite.prepare("SELECT id, status FROM sources WHERE family_id='fam_q' ORDER BY id").all();
    expect(rows).toEqual([{ id: "src_a", status: "replaced" }, { id: "src_b", status: "filed" }]);
  });

  it("rejects a period that fails the family's granularity", () => {
    const db = makeTestDb(); seedProject(db);
    expect(fileSource(db, { projectId: "proj_1", sourceId: "src_a", familyId: "fam_q", period: "2026-06" })).toMatchObject({ status: 400 });
    expect(fileSource(db, { projectId: "proj_1", sourceId: "src_a", familyId: "fam_q", period: null })).toMatchObject({ status: 400 });
  });

  it("enforces the constant rules: null period, single live file replaced on refile", () => {
    const db = makeTestDb(); seedProject(db);
    expect(fileSource(db, { projectId: "proj_1", sourceId: "src_c", familyId: "fam_c", period: "2026-Q1" })).toMatchObject({ status: 400 });
    expect(fileSource(db, { projectId: "proj_1", sourceId: "src_c", familyId: "fam_c", period: null })).toEqual({ ok: true });
    expect(fileSource(db, { projectId: "proj_1", sourceId: "src_a", familyId: "fam_c", period: null })).toEqual({ ok: true });
    const live = db.sqlite.prepare("SELECT id FROM sources WHERE family_id='fam_c' AND status='filed'").all();
    expect(live).toEqual([{ id: "src_a" }]);
  });

  it("creates a new family transactionally and rejects duplicate keys", () => {
    const db = makeTestDb(); seedProject(db);
    expect(fileSource(db, { projectId: "proj_1", sourceId: "src_a", newFamily: { key: "ga4", label: "GA4", kind: "periodic", granularity: "month" }, period: "2026-06" })).toEqual({ ok: true });
    expect(fileSource(db, { projectId: "proj_1", sourceId: "src_b", newFamily: { key: "ga4", label: "GA4 again", kind: "periodic", granularity: "month" }, period: "2026-07" })).toMatchObject({ status: 400 });
  });

  it("listProjectSources groups by family with ascending periods and surfaces unfiled rows", () => {
    const db = makeTestDb(); seedProject(db);
    fileSource(db, { projectId: "proj_1", sourceId: "src_b", familyId: "fam_q", period: "2026-Q2" });
    fileSource(db, { projectId: "proj_1", sourceId: "src_a", familyId: "fam_q", period: "2026-Q1" });
    const { families, unfiled } = listProjectSources(db, "proj_1");
    const q = families.find((f) => f.key === "trade_data")!;
    expect(q.filedPeriods).toEqual(["2026-Q1", "2026-Q2"]);
    expect(unfiled.map((u) => u.id)).toEqual(["src_c"]);
  });

  it("surfaces the live file of a constant family and null otherwise", () => {
    const db = makeTestDb(); seedProject(db);
    fileSource(db, { projectId: "proj_1", sourceId: "src_c", familyId: "fam_c", period: null });
    const { families } = listProjectSources(db, "proj_1");
    expect(families.find((f) => f.key === "brand")!.liveFile).toEqual({ sourceId: "src_c", name: "c.pdf" });
    expect(families.find((f) => f.key === "trade_data")!.liveFile).toBeNull();
  });
});

// ---- Routes -----------------------------------------------------------------

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
    expect(JSON.parse(r1.proposal!)).toEqual(proposal);
    expect(r2.proposal).toBeNull();
  });

  it("confirm POST files a source; DELETE removes the row and frees the slot", async () => {
    const confirm = await import("../app/api/projects/[id]/sources/confirm/route");
    const perSource = await import("../app/api/projects/[id]/sources/[sourceId]/route");
    const db = getDb();
    db.sqlite.prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES ('fam_q','proj_1','trade','Trade','periodic','quarter')").run();
    const up = await uploadFiles("proj_1", [new File([new TextEncoder().encode("x")], "a.csv", { type: "text/csv" })]);
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
    const up2 = await uploadFiles("proj_1", [new File([new TextEncoder().encode("y")], "b.csv", { type: "text/csv" })]);
    const { sources: s2 } = (await up2.json()) as { sources: { id: string }[] };
    expect(fileSource(db, { projectId: "proj_1", sourceId: s2[0].id, familyId: "fam_q", period: "2026-Q1" })).toEqual({ ok: true });
  });

  it("PATCH refiles a source into a different slot", async () => {
    const perSource = await import("../app/api/projects/[id]/sources/[sourceId]/route");
    const db = getDb();
    db.sqlite.prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES ('fam_q','proj_1','trade','Trade','periodic','quarter')").run();
    const up = await uploadFiles("proj_1", [new File([new TextEncoder().encode("x")], "a.csv", { type: "text/csv" })]);
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
      new File([new TextEncoder().encode("x")], "a.csv", { type: "text/csv" }),
      new File([new TextEncoder().encode("y")], "b.csv", { type: "text/csv" }),
    ]);
    const { sources } = (await up.json()) as { sources: { id: string }[] };
    fileSource(db, { projectId: "proj_1", sourceId: sources[0].id, familyId: "fam_q", period: "2026-Q1" });
    fileSource(db, { projectId: "proj_1", sourceId: sources[1].id, familyId: "fam_q", period: "2026-Q1" });
    // sources[0] is now 'replaced'.
    const res = await perSource.DELETE(new Request("http://x", { method: "DELETE" }), srcCtx("proj_1", sources[0].id));
    expect(res.status).toBe(400);
  });
});
