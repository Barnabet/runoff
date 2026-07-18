import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GET as listBlueprints, POST as createBlueprint } from "../app/api/blueprints/route";
import { GET as getBlueprint, PATCH as patchBlueprint } from "../app/api/blueprints/[id]/route";
import { POST as saveRevision } from "../app/api/blueprints/[id]/revisions/route";
import { GET as listSources, POST as uploadSource } from "../app/api/sources/route";
import { DELETE as deleteSource, POST as refreshSource } from "../app/api/sources/[id]/route";
import { getDb } from "../lib/db";
import type { BlueprintContent } from "@runoff/core";

// A fresh temp DB + files dir per test; clear the cached connection getDb()
// memoises on globalThis so each test opens its own database.
const PROJECT_ID = "proj_test";

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-web-"));
  process.env.RUNOFF_DB = join(dir, "runoff.db");
  process.env.RUNOFF_FILES_DIR = join(dir, "files");
  (globalThis as unknown as { __runoffDb?: unknown }).__runoffDb = undefined;
  getDb().sqlite.prepare("INSERT INTO projects (id, name) VALUES (?, 'Test Project')").run(PROJECT_ID);
});

function jsonReq(body: unknown, method = "POST"): Request {
  return new Request("http://x", { method, body: JSON.stringify(body) });
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** GET /api/blueprints scoped to the fixture project. */
function listBps(): Promise<Response> {
  return listBlueprints(new Request(`http://x/api/blueprints?projectId=${PROJECT_ID}`));
}

async function makeBlueprint(name = "R", clientName = "C"): Promise<string> {
  const res = await createBlueprint(jsonReq({ name, clientName, projectId: PROJECT_ID }));
  expect(res.status).toBe(200);
  return (await res.json()).id as string;
}

async function makeSource(origName = "spend.csv", type = "text/csv", label = "Spend Data"): Promise<string> {
  const file = new File([new TextEncoder().encode("a,b\n1,2\n")], origName, { type });
  const fd = new FormData();
  fd.set("file", file);
  fd.set("name", label);
  const res = await uploadSource(new Request("http://x/api/sources", { method: "POST", body: fd }));
  expect(res.status).toBe(200);
  return (await res.json()).id as string;
}

const validContent: BlueprintContent = {
  title: "R2",
  clientName: "C",
  eyebrow: "",
  dateline: "",
  sections: [],
  globalRules: [],
  delivery: { recipient: "", autoDeliverOnClear: false },
};

describe("POST /api/blueprints + GET /api/blueprints", () => {
  it("creates a blueprint and lists it with lastRun null", async () => {
    const id = await makeBlueprint("R", "C");
    expect(id).toMatch(/^bp_[0-9a-f]{12}$/);

    const { blueprints } = await (await listBps()).json();
    expect(blueprints).toHaveLength(1);
    const b = blueprints[0];
    expect(b.id).toBe(id);
    expect(b.name).toBe("R");
    expect(b.clientName).toBe("C");
    expect(b.currentRev).toBe(1);
    expect(b.sourceCount).toBe(0);
    expect(b.lastRun).toBeNull();
  });

  it("rejects a blueprint with no name (400)", async () => {
    const res = await createBlueprint(jsonReq({ clientName: "C" }));
    expect(res.status).toBe(400);
  });

  it("reports lastRun with openFlags count when a run + open flags exist", async () => {
    const id = await makeBlueprint();
    const db = getDb();
    const runId = "run_fixture1";
    db.sqlite
      .prepare(
        "INSERT INTO runs (id, blueprint_id, blueprint_rev, status, finished_at, created_at) VALUES (?, ?, 1, 'complete', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')",
      )
      .run(runId, id);
    db.sqlite
      .prepare("INSERT INTO flags (id, run_id, code, section_key, question, options, status) VALUES ('flag_a', ?, 'F1', 'body', 'q', '[]', 'open')")
      .run(runId);
    db.sqlite
      .prepare("INSERT INTO flags (id, run_id, code, section_key, question, options, status) VALUES ('flag_b', ?, 'F2', 'body', 'q', '[]', 'resolved')")
      .run(runId);

    const { blueprints } = await (await listBps()).json();
    const b = blueprints[0];
    expect(b.lastRun).not.toBeNull();
    expect(b.lastRun.id).toBe(runId);
    expect(b.lastRun.status).toBe("complete");
    expect(b.lastRun.finishedAt).toBe("2026-01-02T00:00:00Z");
    expect(b.lastRun.openFlags).toBe(1);
  });
});

describe("GET /api/blueprints/:id", () => {
  it("returns the blueprint, its current revision content, and (empty) sources", async () => {
    const id = await makeBlueprint("R", "C");
    const res = await getBlueprint(new Request("http://x"), ctx(id));
    expect(res.status).toBe(200);
    const { blueprint, content, sources } = await res.json();
    expect(blueprint.id).toBe(id);
    expect(content.title).toBe("R");
    expect(content.clientName).toBe("C");
    expect(content.sections).toEqual([]);
    expect(content.delivery).toEqual({ recipient: "", autoDeliverOnClear: false });
    expect(sources).toEqual([]);
  });

  it("returns 404 for a missing blueprint", async () => {
    const res = await getBlueprint(new Request("http://x"), ctx("bp_missing"));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/blueprints/:id/revisions", () => {
  it("bumps currentRev, inserts a revision, and GET reflects it", async () => {
    const id = await makeBlueprint("R", "C");
    const res = await saveRevision(jsonReq({ content: validContent }), ctx(id));
    expect(res.status).toBe(200);
    expect((await res.json()).rev).toBe(2);

    const { blueprint, content } = await (await getBlueprint(new Request("http://x"), ctx(id))).json();
    expect(blueprint.currentRev).toBe(2);
    expect(content.title).toBe("R2");
  });

  it("rejects invalid content with 400 and does not bump the revision", async () => {
    const id = await makeBlueprint();
    const res = await saveRevision(jsonReq({ content: { title: "oops" } }), ctx(id));
    expect(res.status).toBe(400);

    const { blueprint } = await (await getBlueprint(new Request("http://x"), ctx(id))).json();
    expect(blueprint.currentRev).toBe(1);
  });
});

describe("PATCH /api/blueprints/:id", () => {
  it("updates name/clientName/cadenceLabel/status", async () => {
    const id = await makeBlueprint("R", "C");
    const res = await patchBlueprint(jsonReq({ name: "New", clientName: "Acme", cadenceLabel: "Weekly", status: "active" }, "PATCH"), ctx(id));
    expect(res.status).toBe(200);

    const { blueprint } = await (await getBlueprint(new Request("http://x"), ctx(id))).json();
    expect(blueprint.name).toBe("New");
    expect(blueprint.clientName).toBe("Acme");
    expect(blueprint.cadenceLabel).toBe("Weekly");
    expect(blueprint.status).toBe("active");
  });

  it("binds sourceIds (replacing existing rows) and reflects in GET + counts", async () => {
    const id = await makeBlueprint();
    const srcId = await makeSource();

    const res = await patchBlueprint(jsonReq({ sourceIds: [srcId] }, "PATCH"), ctx(id));
    expect(res.status).toBe(200);

    const { sources } = await (await getBlueprint(new Request("http://x"), ctx(id))).json();
    expect(sources).toHaveLength(1);
    expect(sources[0].id).toBe(srcId);

    const list = await (await listSources()).json();
    expect(list.sources[0].usedBy).toBe(1);
    const bpList = await (await listBps()).json();
    expect(bpList.blueprints[0].sourceCount).toBe(1);

    // Replace with empty -> unbinds.
    await patchBlueprint(jsonReq({ sourceIds: [] }, "PATCH"), ctx(id));
    const after = await (await getBlueprint(new Request("http://x"), ctx(id))).json();
    expect(after.sources).toHaveLength(0);
  });
});

describe("sources API", () => {
  it("uploads an in-memory File and lists it with usedBy 0", async () => {
    const id = await makeSource("spend.csv", "text/csv", "Spend Data");
    expect(id).toMatch(/^src_[0-9a-f]{12}$/);

    const { sources } = await (await listSources()).json();
    expect(sources).toHaveLength(1);
    expect(sources[0].id).toBe(id);
    expect(sources[0].name).toBe("Spend Data");
    expect(sources[0].mime).toBe("text/csv");
    expect(sources[0].size).toBeGreaterThan(0);
    expect(sources[0].storedFilename).toMatch(/^src_[0-9a-f]{12}_spend\.csv$/);
    expect(sources[0].usedBy).toBe(0);
  });

  it("falls back to an extension-derived mime when file.type is empty", async () => {
    await makeSource("report.pdf", "", "A PDF");
    const { sources } = await (await listSources()).json();
    expect(sources[0].mime).toBe("application/pdf");
  });

  it("deletes a source", async () => {
    const id = await makeSource();
    const res = await deleteSource(new Request("http://x", { method: "DELETE" }), ctx(id));
    expect(res.status).toBe(200);
    const { sources } = await (await listSources()).json();
    expect(sources).toHaveLength(0);
  });

  it("acknowledges a source refresh request", async () => {
    const id = await makeSource();
    const res = await refreshSource(new Request("http://x", { method: "POST" }), ctx(id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
