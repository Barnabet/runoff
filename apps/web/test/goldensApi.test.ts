import { unlinkSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect, beforeEach } from "vitest";
import type { RunDocument } from "@runoff/core";

import { freshDb, jsonReq, ctx } from "./helpers";
import { getDb } from "../lib/db";
import { resolveGoldenText } from "../lib/goldens";

import { GET as listGoldens, POST as postGolden } from "../app/api/blueprints/[id]/goldens/route";
import { DELETE as deleteGolden } from "../app/api/goldens/[id]/route";

beforeEach(() => freshDb());

/** A run document with one paragraph section. */
const document: RunDocument = {
  title: "Q3 Report",
  eyebrow: "Runoff",
  dateline: "July 2026",
  sections: [{ key: "exec", heading: "Exec", blocks: [{ type: "paragraph", spans: [{ text: "Hello world." }] }] }],
};

function seedBlueprint(id: string): void {
  getDb().sqlite.prepare("INSERT INTO blueprints (id, name, client_name) VALUES (?, 'R', 'C')").run(id);
}

/** A completed run under `blueprintId`, carrying the fixture document. */
function seedRun(runId: string, blueprintId: string): void {
  getDb()
    .sqlite.prepare(
      "INSERT INTO runs (id, blueprint_id, blueprint_rev, status, document) VALUES (?, ?, 1, 'complete', ?)",
    )
    .run(runId, blueprintId, JSON.stringify(document));
}

describe("goldens API", () => {
  it("stars a run: POST {kind:'run', runId} creates the row; GET lists it", async () => {
    seedBlueprint("bp_1");
    seedRun("run_1", "bp_1");

    const res = await postGolden(jsonReq({ kind: "run", runId: "run_1" }), ctx("bp_1"));
    expect(res.status).toBe(200);
    const { id } = await res.json();
    expect(id).toMatch(/^gold_/);

    const list = await (await listGoldens(new Request("http://x"), ctx("bp_1"))).json();
    expect(list.goldens).toHaveLength(1);
    expect(list.goldens[0]).toMatchObject({ id, kind: "run", runId: "run_1", blueprintId: "bp_1" });
  });

  it("stars a section: POST {kind:'section', runId, sectionKey}", async () => {
    seedBlueprint("bp_1");
    seedRun("run_1", "bp_1");

    const res = await postGolden(jsonReq({ kind: "section", runId: "run_1", sectionKey: "exec" }), ctx("bp_1"));
    expect(res.status).toBe(200);

    const list = await (await listGoldens(new Request("http://x"), ctx("bp_1"))).json();
    expect(list.goldens[0]).toMatchObject({ kind: "section", runId: "run_1", sectionKey: "exec" });
  });

  it("rejects a star for a run of a different blueprint (404)", async () => {
    seedBlueprint("bp_1");
    seedBlueprint("bp_other");
    seedRun("run_1", "bp_other");

    const res = await postGolden(jsonReq({ kind: "run", runId: "run_1" }), ctx("bp_1"));
    expect(res.status).toBe(404);

    const list = await (await listGoldens(new Request("http://x"), ctx("bp_1"))).json();
    expect(list.goldens).toHaveLength(0);
  });

  it("uploads an exemplar via multipart and resolves its text", async () => {
    seedBlueprint("bp_1");

    const form = new FormData();
    form.set("file", new File(["golden text here"], "example.txt", { type: "text/plain" }));
    const res = await postGolden(new Request("http://x", { method: "POST", body: form }), ctx("bp_1"));
    expect(res.status).toBe(200);
    const { id } = await res.json();

    const list = await (await listGoldens(new Request("http://x"), ctx("bp_1"))).json();
    expect(list.goldens[0]).toMatchObject({ id, kind: "exemplar", name: "example.txt", storedFilename: expect.any(String) });

    const resolved = await resolveGoldenText(getDb(), id);
    expect(resolved).not.toBeNull();
    expect(resolved!.text).toContain("golden text here");
  });

  it("DELETE removes the golden row", async () => {
    seedBlueprint("bp_1");
    seedRun("run_1", "bp_1");
    const { id } = await (await postGolden(jsonReq({ kind: "run", runId: "run_1" }), ctx("bp_1"))).json();

    const res = await deleteGolden(new Request("http://x", { method: "DELETE" }), ctx(id));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const list = await (await listGoldens(new Request("http://x"), ctx("bp_1"))).json();
    expect(list.goldens).toHaveLength(0);
  });

  it("resolveGoldenText returns section text for a kind:'section' golden", async () => {
    seedBlueprint("bp_1");
    seedRun("run_1", "bp_1");
    const { id } = await (
      await postGolden(jsonReq({ kind: "section", runId: "run_1", sectionKey: "exec" }), ctx("bp_1"))
    ).json();

    const resolved = await resolveGoldenText(getDb(), id);
    expect(resolved).not.toBeNull();
    expect(resolved!.text).toContain("Hello world.");
    expect(resolved!.description).toContain("Exec");
  });

  it("resolveGoldenText returns null when the run document is corrupt JSON", async () => {
    seedBlueprint("bp_1");
    seedRun("run_1", "bp_1");
    const { id } = await (await postGolden(jsonReq({ kind: "run", runId: "run_1" }), ctx("bp_1"))).json();

    getDb().sqlite.prepare("UPDATE runs SET document = ? WHERE id = ?").run("not json{", "run_1");

    const resolved = await resolveGoldenText(getDb(), id);
    expect(resolved).toBeNull();
  });

  it("resolveGoldenText returns null when the exemplar file is missing from disk", async () => {
    seedBlueprint("bp_1");

    const form = new FormData();
    form.set("file", new File(["golden text here"], "example.txt", { type: "text/plain" }));
    const { id } = await (
      await postGolden(new Request("http://x", { method: "POST", body: form }), ctx("bp_1"))
    ).json();

    const { storedFilename } = getDb()
      .sqlite.prepare("SELECT stored_filename AS storedFilename FROM goldens WHERE id = ?")
      .get(id) as { storedFilename: string };
    unlinkSync(join(process.env.RUNOFF_FILES_DIR!, storedFilename));

    const resolved = await resolveGoldenText(getDb(), id);
    expect(resolved).toBeNull();
  });
});
