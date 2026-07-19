import { describe, it, expect, beforeEach, vi } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BindingInventory, RunDocument } from "@runoff/core";

import { freshDb } from "./helpers";
import { getDb } from "../lib/db";
import { fileSource } from "../lib/sourceManager";

// Mock only the engine's LLM entry points (unify + bind). Verification,
// inventoryFromCitations, and rendering stay real so routes run real SQL.
const { unifyMock, bindMock } = vi.hoisted(() => ({ unifyMock: vi.fn(), bindMock: vi.fn() }));
vi.mock("@runoff/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@runoff/engine")>()),
  unifyGoldenReport: (...a: unknown[]) => unifyMock(...a),
  bindGolden: (...a: unknown[]) => bindMock(...a),
}));
vi.mock("../lib/llm", () => ({ getLlmClient: () => ({}) }));

const { POST: bindRoute } = await import("../app/api/blueprints/[id]/goldens/[goldenId]/bind/route");
const { POST: unifyRoute } = await import("../app/api/blueprints/[id]/goldens/[goldenId]/unify/route");
const { PATCH: patchRoute } = await import("../app/api/goldens/[id]/route");
const { resolveGolden } = await import("../lib/goldens");

const projectId = "proj_1";
let db: ReturnType<typeof getDb>;
let filesDir: string;

const bindCtx = (id: string, goldenId: string) => ({ params: Promise.resolve({ id, goldenId }) });
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body?: unknown) =>
  new Request("http://x", { method: "POST", body: body === undefined ? "{}" : JSON.stringify(body) });
const patch = (body: unknown) => new Request("http://x", { method: "PATCH", body: JSON.stringify(body) });

function seedBlueprint(): void {
  db.sqlite.prepare("INSERT INTO projects (id, name) VALUES (?, 'P')").run(projectId);
  db.sqlite
    .prepare("INSERT INTO blueprints (id, name, client_name, project_id, current_rev) VALUES ('bp_1', 'R', 'C', ?, 1)")
    .run(projectId);
}

function setRevision(sections: { key: string; queries: { name: string; sql: string }[] }[]): void {
  const content = { title: "T", clientName: "C", eyebrow: "", dateline: "", sections, globalRules: [], delivery: { recipient: "", autoDeliverOnClear: false } };
  db.sqlite
    .prepare("INSERT INTO blueprint_revisions (id, blueprint_id, rev, content) VALUES ('rev_1', 'bp_1', 1, ?)")
    .run(JSON.stringify(content));
}

async function seedFamily(key: string, period: string, csv: string): Promise<string> {
  const stored = `${key}_${period}.csv`;
  writeFileSync(join(filesDir, stored), csv);
  const sourceId = `src_${key}_${period}`;
  db.sqlite
    .prepare("INSERT INTO sources (id, project_id, name, stored_filename, mime, size) VALUES (?, ?, ?, ?, 'text/csv', 1)")
    .run(sourceId, projectId, stored, stored);
  const res = await fileSource(db, {
    projectId,
    sourceId,
    newFamily: { key, label: key, kind: "periodic", granularity: "quarter" },
    period,
  });
  if (!("ok" in res)) throw new Error(`seedFamily failed: ${JSON.stringify(res)}`);
  return (db.sqlite.prepare("SELECT id FROM source_families WHERE key = ?").get(key) as { id: string }).id;
}

function insertExemplar(
  id: string,
  opts: {
    name: string;
    mime?: string;
    storedFilename?: string;
    document?: RunDocument;
    period?: string | null;
    bindings?: BindingInventory;
    unifyError?: string;
  },
): void {
  db.sqlite
    .prepare(
      "INSERT INTO goldens (id, blueprint_id, kind, name, mime, stored_filename, period, document, bindings, unify_error) VALUES (?, 'bp_1', 'exemplar', ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      opts.name,
      opts.mime ?? "text/markdown",
      opts.storedFilename ?? null,
      opts.period ?? null,
      opts.document ? JSON.stringify(opts.document) : null,
      opts.bindings ? JSON.stringify(opts.bindings) : null,
      opts.unifyError ?? null,
    );
}

/** Insert a run row + a run-kind golden pointing at it. */
function insertRunGolden(goldenId: string, runId: string, document: RunDocument, period: string): void {
  db.sqlite
    .prepare("INSERT INTO runs (id, blueprint_id, blueprint_rev, status, period, document) VALUES (?, 'bp_1', 1, 'complete', ?, ?)")
    .run(runId, period, JSON.stringify(document));
  db.sqlite
    .prepare("INSERT INTO goldens (id, blueprint_id, kind, run_id, period) VALUES (?, 'bp_1', 'run', ?, ?)")
    .run(goldenId, runId, period);
}

// An exemplar document whose one value span binds to SUM(fam_x.amount).
const revDoc = (): RunDocument => ({
  title: "Q1 Report",
  eyebrow: "E",
  dateline: "D",
  sections: [
    { key: "exec", heading: "Exec", blocks: [{ type: "paragraph", spans: [{ text: "Revenue was " }, { text: "$150" }] }] },
  ],
});

// Stored inventory referencing fam_x with a PLANTED-stale verifiedValue.
const staleInv = (famId: string, stale: number): BindingInventory => ({
  version: 1,
  items: [
    {
      id: "rev",
      kind: "value",
      anchor: { sectionKey: "exec", blockIndex: 0, spanIndex: 1 },
      raw: "$150",
      parsed: 150,
      binding: { familyId: famId, sql: "SELECT SUM(amount) FROM fam_x WHERE _period = :period", verifiedValue: stale, status: "bound" },
      reason: null,
    },
  ],
});

beforeEach(() => {
  freshDb();
  unifyMock.mockReset();
  bindMock.mockReset();
  db = getDb();
  filesDir = process.env.RUNOFF_FILES_DIR!;
  mkdirSync(filesDir, { recursive: true });
  seedBlueprint();
});

describe("bind route", () => {
  it("404s an unknown golden or a golden on another blueprint", async () => {
    const r1 = await bindRoute(post(), bindCtx("bp_1", "nope"));
    expect(r1.status).toBe(404);
    expect(await r1.json()).toEqual({ error: "golden not found" });

    insertExemplar("gold_x", { name: "x.md", document: revDoc(), period: "2026-Q1" });
    const r2 = await bindRoute(post(), bindCtx("bp_other", "gold_x"));
    expect(r2.status).toBe(404);
  });

  it("400s an exemplar that is not unified", async () => {
    insertExemplar("gold_u", { name: "u.md", unifyError: "unify failed: no document produced" });
    const r = await bindRoute(post(), bindCtx("bp_1", "gold_u"));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "golden is not unified" });
    expect(bindMock).not.toHaveBeenCalled();
  });

  it("exemplar + stored inventory + no feedback → re-verify only (no agent), stamps corrected", async () => {
    const famId = await seedFamily("x", "2026-Q1", "amount\n100\n50\n"); // SUM = 150
    insertExemplar("gold_v", { name: "v.md", document: revDoc(), period: "2026-Q1", bindings: staleInv(famId, 999) });

    const r = await bindRoute(post(), bindCtx("bp_1", "gold_v"));
    expect(r.status).toBe(200);
    expect(bindMock).not.toHaveBeenCalled();
    // stale 999 was corrected to the warehouse-computed 150.
    const g = resolveGolden(db, "gold_v")!;
    expect(g.inventory!.items[0].binding).toMatchObject({ status: "bound", verifiedValue: 150 });
  });

  it("exemplar + feedback → agent runs; null agent → 500 and stored bindings unchanged", async () => {
    const famId = await seedFamily("x", "2026-Q1", "amount\n100\n50\n");
    insertExemplar("gold_f", { name: "f.md", document: revDoc(), period: "2026-Q1", bindings: staleInv(famId, 150) });

    bindMock.mockResolvedValueOnce(null);
    const r = await bindRoute(post({ feedback: "bind revenue to fam_x" }), bindCtx("bp_1", "gold_f"));
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: "bind failed: no inventory produced" });
    expect(bindMock).toHaveBeenCalledTimes(1);
    expect(bindMock.mock.calls[0][0]).toMatchObject({ feedback: "bind revenue to fam_x" });
    // failed bind leaves the stored inventory untouched.
    const g = resolveGolden(db, "gold_f")!;
    expect(g.inventory!.items[0].binding).toMatchObject({ verifiedValue: 150 });
  });

  it("run golden + feedback → 400; run golden without feedback → deterministic rebuild (no agent)", async () => {
    await seedFamily("x", "2026-Q1", "amount\n100\n50\n"); // SUM = 150
    setRevision([{ key: "exec", queries: [{ name: "q_x", sql: "SELECT amount FROM fam_x WHERE _period = :period" }] }]);
    const document: RunDocument = {
      title: "Run",
      eyebrow: "E",
      dateline: "D",
      sections: [
        {
          key: "exec",
          heading: "Exec",
          blocks: [
            { type: "paragraph", spans: [{ text: "Revenue was " }, { text: "$150", citation: { sourceId: "s1", locator: "sum(fam_x.amount)" } }] },
          ],
        },
      ],
    };
    insertRunGolden("gold_r", "run_1", document, "2026-Q1");

    const bad = await bindRoute(post({ feedback: "x" }), bindCtx("bp_1", "gold_r"));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "feedback requires an exemplar golden" });
    expect(bindMock).not.toHaveBeenCalled();

    const ok = await bindRoute(post(), bindCtx("bp_1", "gold_r"));
    expect(ok.status).toBe(200);
    expect(bindMock).not.toHaveBeenCalled();
    const g = resolveGolden(db, "gold_r")!;
    expect(g.inventory).not.toBeNull();
    expect(g.inventory!.items.find((i) => i.kind === "value")!.binding).toMatchObject({ status: "bound", verifiedValue: 150 });
  });
});

describe("unify route", () => {
  it("400s a non-exemplar golden", async () => {
    const document = revDoc();
    insertRunGolden("gold_run", "run_2", document, "2026-Q1");
    const r = await unifyRoute(post(), bindCtx("bp_1", "gold_run"));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "only exemplar goldens can be unified" });
    expect(unifyMock).not.toHaveBeenCalled();
  });

  it("exemplar → unify runs, auto-bind chains on success", async () => {
    writeFileSync(join(filesDir, "e_1.md"), "# Q1\nRevenue was $150");
    insertExemplar("gold_e", { name: "e.md", mime: "text/markdown", storedFilename: "e_1.md" });
    unifyMock.mockResolvedValueOnce({ document: revDoc(), period: "2026-Q1" });
    bindMock.mockResolvedValueOnce(null); // auto-bind chain is invoked; we only assert it ran

    const r = await unifyRoute(post(), bindCtx("bp_1", "gold_e"));
    expect(r.status).toBe(200);
    expect(unifyMock).toHaveBeenCalledTimes(1);
    expect(bindMock).toHaveBeenCalledTimes(1); // auto-bind chained
    const { golden } = await r.json();
    expect(golden.document).not.toBeNull();
    expect(golden.period).toBe("2026-Q1");
    expect(golden.unifyError).toBeNull();
  });
});

describe("PATCH period route", () => {
  it("accepts a valid period and re-verifies against it (no agent)", async () => {
    // Document asserts $150; the Q2 warehouse sum is 200 — so re-verifying at
    // the new period recomputes 200 and (honestly) flags a mismatch vs 150.
    const famId = await seedFamily("x", "2026-Q2", "amount\n120\n80\n"); // SUM = 200 at Q2
    insertExemplar("gold_p", { name: "p.md", document: revDoc(), period: "2026-Q1", bindings: staleInv(famId, 150) });

    const r = await patchRoute(patch({ period: "2026-Q2" }), idCtx("gold_p"));
    expect(r.status).toBe(200);
    const { golden } = await r.json();
    expect(golden.period).toBe("2026-Q2");
    expect(bindMock).not.toHaveBeenCalled();
    // re-verify ran against the NEW period → warehouse sum at Q2 = 200 (was stale 150).
    const g = resolveGolden(db, "gold_p")!;
    expect(g.inventory!.items[0].binding).toMatchObject({ status: "mismatch", verifiedValue: 200 });
  });

  it("400s an invalid period", async () => {
    insertExemplar("gold_bad", { name: "b.md", document: revDoc(), period: "2026-Q1" });
    const r = await patchRoute(patch({ period: "garbage" }), idCtx("gold_bad"));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid period: garbage" });
  });

  it("accepts null period", async () => {
    insertExemplar("gold_n", { name: "n.md", document: revDoc(), period: "2026-Q1" });
    const r = await patchRoute(patch({ period: null }), idCtx("gold_n"));
    expect(r.status).toBe(200);
    const { golden } = await r.json();
    expect(golden.period).toBeNull();
  });

  it("404s an unknown golden", async () => {
    const r = await patchRoute(patch({ period: "2026-Q1" }), idCtx("nope"));
    expect(r.status).toBe(404);
  });
});
