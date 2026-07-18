import { describe, it, expect, beforeEach, vi } from "vitest";
import type { BlueprintContent, BlueprintSection } from "@runoff/core";

import { freshDb, jsonReq, ctx } from "./helpers";
import { getDb } from "../lib/db";

const copilotTurn = vi.fn();
vi.mock("@runoff/engine", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  copilotTurn: (...a: unknown[]) => copilotTurn(...a),
}));
vi.mock("../lib/llm", () => ({ getLlmClient: () => ({}) }));

const { buildCopilotContext } = await import("../lib/queries");
const { GET, POST } = await import("../app/api/blueprints/[id]/copilot/route");
const { GET: getMemories } = await import("../app/api/blueprints/[id]/memories/route");
const { PATCH: patchMemory, DELETE: deleteMemory } = await import("../app/api/memories/[id]/route");

function section(key: string, number: number): BlueprintSection {
  return { key, number, heading: key.toUpperCase(), mode: "auto", instruction: `about ${key}`, sourceIds: [], rules: [] };
}

const DRAFT: BlueprintContent = {
  title: "Report",
  clientName: "Client",
  eyebrow: "EB",
  dateline: "June 2026",
  sections: [section("a", 1), section("b", 2)],
  globalRules: ["be brief"],
  delivery: { recipient: "x@y.z", autoDeliverOnClear: false },
};

let db: ReturnType<typeof getDb>;

function seedBlueprint(id: string): void {
  db.sqlite.prepare("INSERT INTO blueprints (id, name, client_name, current_rev) VALUES (?, 'R', 'C', 1)").run(id);
  db.sqlite
    .prepare("INSERT INTO blueprint_revisions (id, blueprint_id, rev, content) VALUES (?, ?, 1, ?)")
    .run(`rev_${id}`, id, JSON.stringify(DRAFT));
  db.sqlite
    .prepare(
      "INSERT INTO sources (id, name, kind, stored_filename, mime, size) VALUES ('src_1', 'Src', 'file', 'src_1.txt', 'text/plain', 5)",
    )
    .run();
  db.sqlite.prepare("INSERT INTO blueprint_sources (blueprint_id, source_id) VALUES (?, 'src_1')").run(id);
}

beforeEach(() => {
  freshDb();
  copilotTurn.mockReset();
  db = getDb();
  seedBlueprint("bp_1");
});

describe("copilot API", () => {
  it("POST streams the turn's events as SSE and persists both messages", async () => {
    copilotTurn.mockImplementation(async (opts: any) => {
      opts.io.emit({ type: "text_delta", text: "Hello" });
      opts.io.emit({ type: "edit", op: { type: "update_global_rules", before: [], after: ["x"] } });
      return { reply: "Hello", actions: [{ kind: "edit", op: { type: "update_global_rules", before: [], after: ["x"] } }], draft: DRAFT };
    });
    const res = await POST(jsonReq({ message: "hi", draft: DRAFT, selectedKey: null }), ctx("bp_1"));
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"type":"text_delta"');
    expect(text).toContain('"type":"edit"');
    expect(text).toContain('"type":"done"');
    const rows = db.sqlite.prepare("SELECT role, body, status FROM copilot_messages WHERE blueprint_id='bp_1' ORDER BY rowid").all();
    expect(rows).toEqual([
      { role: "user", body: "hi", status: "ok" },
      { role: "assistant", body: "Hello", status: "ok" },
    ]);
  });

  it("POST rejects an invalid draft with 400 before calling the engine", async () => {
    const res = await POST(jsonReq({ message: "hi", draft: { junk: true }, selectedKey: null }), ctx("bp_1"));
    expect(res.status).toBe(400);
    expect(copilotTurn).not.toHaveBeenCalled();
  });

  it("a mid-stream engine error persists a failed assistant row and emits an error event", async () => {
    copilotTurn.mockImplementation(async (opts: any) => {
      opts.io.emit({ type: "text_delta", text: "partial" });
      throw new Error("proxy died");
    });
    const res = await POST(jsonReq({ message: "hi", draft: DRAFT, selectedKey: null }), ctx("bp_1"));
    const text = await res.text();
    expect(text).toContain('"type":"error"');
    const row = db.sqlite.prepare("SELECT body, status FROM copilot_messages WHERE role='assistant'").get();
    expect(row).toEqual({ body: "partial", status: "failed" });
  });

  it("GET returns the thread oldest-first with parsed actions", async () => {
    db.sqlite
      .prepare("INSERT INTO copilot_messages (id, blueprint_id, role, body) VALUES ('cm_1', 'bp_1', 'user', 'first')")
      .run();
    db.sqlite
      .prepare(
        "INSERT INTO copilot_messages (id, blueprint_id, role, body, actions) VALUES ('cm_2', 'bp_1', 'assistant', 'second', ?)",
      )
      .run(JSON.stringify([{ kind: "edit", op: { type: "update_global_rules", before: [], after: ["x"] } }]));

    const { messages } = await (await GET(new Request("http://x"), ctx("bp_1"))).json();
    expect(messages.map((m: any) => m.body)).toEqual(["first", "second"]);
    expect(messages[0].actions).toEqual([]);
    expect(messages[1].actions).toEqual([{ kind: "edit", op: { type: "update_global_rules", before: [], after: ["x"] } }]);
  });

  it("copilot turn saveMemory enforces the 30-active cap by disabling the oldest", async () => {
    for (let i = 0; i < 30; i++) {
      const id = `m_${String(i).padStart(2, "0")}`;
      db.sqlite
        .prepare("INSERT INTO memories (id, blueprint_id, body, source) VALUES (?, 'bp_1', ?, 'copilot')")
        .run(id, `mem ${i}`);
    }
    copilotTurn.mockImplementation(async (opts: any) => {
      opts.ctx.saveMemory("new one");
      return { reply: "ok", actions: [], draft: DRAFT };
    });
    await (await POST(jsonReq({ message: "hi", draft: DRAFT, selectedKey: null }), ctx("bp_1"))).text();
    const active = db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM memories WHERE blueprint_id='bp_1' AND status='active'")
      .get() as { n: number };
    expect(active.n).toBe(30);
    const oldest = db.sqlite.prepare("SELECT status FROM memories WHERE id='m_00'").get() as { status: string };
    expect(oldest.status).toBe("disabled");
  });

  it("getRunSection maps question ids to text and scopes answers by the raised section", () => {
    const doc = {
      title: "T",
      eyebrow: "E",
      dateline: "D",
      sections: [
        { key: "a", heading: "A", blocks: [] },
        { key: "b", heading: "B", blocks: [] },
      ],
    };
    db.sqlite
      .prepare("INSERT INTO runs (id, blueprint_id, blueprint_rev, status, document) VALUES ('run_1', 'bp_1', 1, 'complete', ?)")
      .run(JSON.stringify(doc));
    const ev = (seq: number, type: string, payload: unknown) =>
      db.sqlite
        .prepare("INSERT INTO run_events (run_id, seq, type, payload) VALUES ('run_1', ?, ?, ?)")
        .run(seq, type, JSON.stringify(payload));
    ev(1, "question_raised", { questionId: "q_1", sectionKey: "a", question: "Which fiscal year?", options: [], fallback: "", deadlineSection: "a" });
    ev(2, "question_answered", { questionId: "q_1", answer: "FY2026" });

    const context = buildCopilotContext(getDb(), "bp_1", new Map());

    const sectionA = context.getRunSection("run_1", "a");
    expect(sectionA?.answers).toEqual([{ question: "Which fiscal year?", answer: "FY2026" }]);

    const sectionB = context.getRunSection("run_1", "b");
    expect(sectionB?.answers).toEqual([]);
  });

  it("memories: GET lists, PATCH toggles status, DELETE removes", async () => {
    db.sqlite
      .prepare("INSERT INTO memories (id, blueprint_id, body, source) VALUES ('mem_1', 'bp_1', 'remember this', 'copilot')")
      .run();

    const list = await (await getMemories(new Request("http://x"), ctx("bp_1"))).json();
    expect(list.memories).toHaveLength(1);
    expect(list.memories[0]).toMatchObject({ id: "mem_1", body: "remember this", status: "active" });

    const patched = await patchMemory(jsonReq({ status: "disabled" }, "PATCH"), ctx("mem_1"));
    expect(patched.status).toBe(200);
    const after = db.sqlite.prepare("SELECT status FROM memories WHERE id='mem_1'").get() as { status: string };
    expect(after.status).toBe("disabled");

    const bad = await patchMemory(jsonReq({ status: "nope" }, "PATCH"), ctx("mem_1"));
    expect(bad.status).toBe(400);

    const missing = await patchMemory(jsonReq({ status: "active" }, "PATCH"), ctx("nope"));
    expect(missing.status).toBe(404);

    const del = await deleteMemory(new Request("http://x", { method: "DELETE" }), ctx("mem_1"));
    expect(del.status).toBe(200);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 0 });
  });
});
