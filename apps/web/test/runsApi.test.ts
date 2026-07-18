import { describe, it, expect, beforeEach } from "vitest";
import type { BlueprintContent } from "@runoff/core";

import { freshDb, jsonReq, ctx } from "./helpers";
import { getDb } from "../lib/db";
import { getRunPayload } from "../lib/queries";

import { POST as createRun } from "../app/api/runs/route";
import { GET as getRun } from "../app/api/runs/[id]/route";
import { POST as postInput } from "../app/api/runs/[id]/inputs/route";
import { GET as sseEvents } from "../app/api/runs/[id]/events/route";
import { POST as resolveFlag } from "../app/api/flags/[id]/route";
import { POST as createBlueprint } from "../app/api/blueprints/route";
import { POST as saveRevision } from "../app/api/blueprints/[id]/revisions/route";

const PROJECT_ID = "proj_test";

beforeEach(() => {
  freshDb();
  getDb().sqlite.prepare("INSERT INTO projects (id, name) VALUES (?, 'Test Project')").run(PROJECT_ID);
});

const contentWithSections: BlueprintContent = {
  title: "R",
  clientName: "C",
  eyebrow: "",
  dateline: "",
  // deliberately out of number order to prove sectionMeta sorts by number
  sections: [
    { key: "intro", number: 2, heading: "Introduction", mode: "auto", instruction: "Open the report.", familyIds: [], rules: [] },
    { key: "body", number: 1, heading: "Body", mode: "auto", instruction: "Write clearly and concisely.", familyIds: [], rules: [] },
  ],
  globalRules: [],
  delivery: { recipient: "", autoDeliverOnClear: false },
};

async function makeBlueprint(): Promise<string> {
  const res = await createBlueprint(jsonReq({ name: "R", clientName: "C", projectId: PROJECT_ID }));
  return (await res.json()).id as string;
}

/** Blueprint whose current revision (rev 2) holds two real sections. */
async function blueprintWithSections(): Promise<string> {
  const id = await makeBlueprint();
  await saveRevision(jsonReq({ content: contentWithSections }), ctx(id));
  return id;
}

function insertEvent(runId: string, seq: number, event: Record<string, unknown>): void {
  getDb()
    .sqlite.prepare("INSERT INTO run_events (run_id, seq, type, payload) VALUES (?, ?, ?, ?)")
    .run(runId, seq, event.type as string, JSON.stringify(event));
}

describe("POST /api/runs", () => {
  it("404s when the blueprint is missing", async () => {
    const res = await createRun(jsonReq({ blueprintId: "bp_missing" }));
    expect(res.status).toBe(404);
  });

  it("enqueues a run pinned to the blueprint's current rev", async () => {
    const id = await blueprintWithSections(); // currentRev = 2
    const res = await createRun(jsonReq({ blueprintId: id }));
    expect(res.status).toBe(200);
    const { id: runId } = await res.json();
    expect(runId).toMatch(/^run_[0-9a-f]{12}$/);

    const row = getDb()
      .sqlite.prepare("SELECT status, blueprint_rev AS rev FROM runs WHERE id = ?")
      .get(runId) as { status: string; rev: number };
    expect(row.status).toBe("queued");
    expect(row.rev).toBe(2);
  });
});

describe("GET /api/runs/:id", () => {
  it("404s for a missing run", async () => {
    const res = await getRun(new Request("http://x"), ctx("run_missing"));
    expect(res.status).toBe(404);
  });

  it("returns run, ordered events, flags, sectionMeta (number order), sourceLabels, blueprint", async () => {
    const bpId = await blueprintWithSections();

    // Bind a source so sourceLabels is non-empty.
    const db = getDb();
    db.sqlite
      .prepare("INSERT INTO sources (id, name, stored_filename, mime, size) VALUES ('src_1', 'Spend Data', 'src_1_x.csv', 'text/csv', 3)")
      .run();
    db.sqlite.prepare("INSERT INTO blueprint_sources (blueprint_id, source_id) VALUES (?, 'src_1')").run(bpId);

    const runId = (await (await createRun(jsonReq({ blueprintId: bpId }))).json()).id as string;
    insertEvent(runId, 1, { type: "run_started", sectionKeys: ["body", "intro"], blueprintRev: 2 });
    insertEvent(runId, 2, { type: "section_started", sectionKey: "body" });

    // A flag for this run.
    db.sqlite
      .prepare("INSERT INTO flags (id, run_id, code, section_key, question, options, status) VALUES ('flag_a', ?, 'F1', 'body', 'q?', '[\"a\",\"b\"]', 'open')")
      .run(runId);

    const res = await getRun(new Request("http://x"), ctx(runId));
    expect(res.status).toBe(200);
    const { run, events, flags, sectionMeta, sourceLabels, blueprint } = await res.json();

    expect(run.id).toBe(runId);
    expect(run.status).toBe("queued");
    expect(events.map((e: { type: string }) => e.type)).toEqual(["run_started", "section_started"]);
    expect(events[0].sectionKeys).toEqual(["body", "intro"]);
    expect(flags).toHaveLength(1);
    expect(flags[0].options).toEqual(["a", "b"]);
    expect(sectionMeta).toEqual([
      { key: "body", number: 1, heading: "Body" },
      { key: "intro", number: 2, heading: "Introduction" },
    ]);
    expect(sourceLabels).toEqual({ src_1: "Spend Data" });
    expect(blueprint).toEqual({ id: bpId, name: "R", clientName: "C" });
  });
});

describe("getRunPayload.previous", () => {
  it("is the latest completed predecessor for a second run, null for the first", async () => {
    const bpId = await makeBlueprint();
    const first = (await (await createRun(jsonReq({ blueprintId: bpId }))).json()).id as string;
    getDb()
      .sqlite.prepare(
        "UPDATE runs SET status='complete', finished_at='2026-07-01 09:10:00', created_at='2026-07-01 09:00:00', document=? WHERE id = ?",
      )
      .run(JSON.stringify({ title: "Prev", eyebrow: "E", dateline: "D", sections: [] }), first);

    const second = (await (await createRun(jsonReq({ blueprintId: bpId }))).json()).id as string;
    getDb().sqlite.prepare("UPDATE runs SET created_at='2026-07-18 09:00:00' WHERE id = ?").run(second);

    expect(getRunPayload(getDb(), first)!.previous).toBeNull();
    const prev = getRunPayload(getDb(), second)!.previous;
    expect(prev?.runId).toBe(first);
    expect(prev?.document.title).toBe("Prev");
  });
});

describe("POST /api/runs/:id/inputs", () => {
  it("rejects an unknown kind with 400", async () => {
    const bpId = await makeBlueprint();
    const runId = (await (await createRun(jsonReq({ blueprintId: bpId }))).json()).id as string;
    const res = await postInput(jsonReq({ kind: "bogus" }), ctx(runId));
    expect(res.status).toBe(400);
  });

  it("inserts a run_inputs row for a valid kind", async () => {
    const bpId = await makeBlueprint();
    const runId = (await (await createRun(jsonReq({ blueprintId: bpId }))).json()).id as string;
    const res = await postInput(jsonReq({ kind: "answer", questionId: "q1", text: "yes" }), ctx(runId));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const row = getDb()
      .sqlite.prepare("SELECT kind, payload FROM run_inputs WHERE run_id = ?")
      .get(runId) as { kind: string; payload: string };
    expect(row.kind).toBe("answer");
    expect(JSON.parse(row.payload)).toEqual({ text: "yes", questionId: "q1" });
  });

  it("replaces a pending answer to the same question instead of queueing a duplicate", async () => {
    // A live run recorded 4 identical rows per question from re-clicks (run_d899df901079).
    const bpId = await makeBlueprint();
    const runId = (await (await createRun(jsonReq({ blueprintId: bpId }))).json()).id as string;
    await postInput(jsonReq({ kind: "answer", questionId: "q1", text: "yes" }), ctx(runId));
    await postInput(jsonReq({ kind: "answer", questionId: "q1", text: "no" }), ctx(runId));
    await postInput(jsonReq({ kind: "answer", questionId: "q2", text: "maybe" }), ctx(runId));

    const rows = getDb()
      .sqlite.prepare("SELECT payload FROM run_inputs WHERE run_id = ? ORDER BY id")
      .all(runId) as { payload: string }[];
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0].payload)).toEqual({ text: "no", questionId: "q1" });
    expect(JSON.parse(rows[1].payload)).toEqual({ text: "maybe", questionId: "q2" });
  });
});

describe("POST /api/flags/:id", () => {
  it("resolves a flag and reports the run's remaining open count", async () => {
    const bpId = await makeBlueprint();
    const runId = (await (await createRun(jsonReq({ blueprintId: bpId }))).json()).id as string;
    const db = getDb();
    db.sqlite
      .prepare("INSERT INTO flags (id, run_id, code, section_key, question, options) VALUES ('flag_a', ?, 'F1', 'body', 'q', '[]')")
      .run(runId);
    db.sqlite
      .prepare("INSERT INTO flags (id, run_id, code, section_key, question, options) VALUES ('flag_b', ?, 'F2', 'body', 'q', '[]')")
      .run(runId);

    const res = await resolveFlag(jsonReq({ option: "a", note: "because" }), ctx("flag_a"));
    expect(res.status).toBe(200);
    expect((await res.json()).remainingOpen).toBe(1);

    const row = db.sqlite.prepare("SELECT status, resolution FROM flags WHERE id = 'flag_a'").get() as {
      status: string;
      resolution: string;
    };
    expect(row.status).toBe("resolved");
    expect(JSON.parse(row.resolution)).toEqual({ option: "a", note: "because" });
  });

  it("404s for a missing flag", async () => {
    const res = await resolveFlag(jsonReq({ option: "a" }), ctx("flag_missing"));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/runs/:id/events (SSE)", () => {
  it("streams existing events then closes on abort", async () => {
    const bpId = await makeBlueprint();
    const runId = (await (await createRun(jsonReq({ blueprintId: bpId }))).json()).id as string;
    insertEvent(runId, 1, { type: "run_started", sectionKeys: ["body"], blueprintRev: 1 });

    const controller = new AbortController();
    const res = await sseEvents(new Request("http://x", { signal: controller.signal }), ctx(runId));
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain("run_started");
    expect(text.startsWith("data: ")).toBe(true);

    controller.abort();
    const done = await reader.read();
    expect(done.done).toBe(true);
  });
});
