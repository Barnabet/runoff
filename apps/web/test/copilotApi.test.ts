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
  return { key, number, heading: key.toUpperCase(), mode: "auto", instruction: `about ${key}`, familyIds: [], rules: [] };
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
  db.sqlite.prepare("INSERT INTO blueprints (id, name, client_name, project_id, current_rev) VALUES (?, 'R', 'C', 'proj_1', 1)").run(id);
  db.sqlite
    .prepare("INSERT INTO blueprint_revisions (id, blueprint_id, rev, content) VALUES (?, ?, 1, ?)")
    .run(`rev_${id}`, id, JSON.stringify(DRAFT));
  // A bound constant family (fam_1, one live file), a bound periodic family
  // (fam_rev, two filed quarters), and an unbound periodic family (fam_un).
  db.sqlite
    .prepare("INSERT INTO source_families (id, project_id, key, label, kind) VALUES ('fam_1', 'proj_1', 'src', 'Src', 'constant')")
    .run();
  db.sqlite
    .prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES ('fam_rev', 'proj_1', 'revenue', 'Revenue', 'periodic', 'quarter')")
    .run();
  db.sqlite
    .prepare("INSERT INTO source_families (id, project_id, key, label, kind, granularity) VALUES ('fam_un', 'proj_1', 'leftover', 'Leftover', 'periodic', 'month')")
    .run();
  const src = db.sqlite.prepare(
    "INSERT INTO sources (id, project_id, family_id, period, name, kind, stored_filename, mime, size, status) VALUES (?, 'proj_1', ?, ?, ?, 'file', ?, 'text/plain', 5, 'filed')",
  );
  src.run("src_1", "fam_1", null, "Src", "src_1.txt");
  src.run("src_q1", "fam_rev", "2026-Q1", "Revenue Q1", "src_q1.csv");
  src.run("src_q2", "fam_rev", "2026-Q2", "Revenue Q2", "src_q2.csv");
  db.sqlite.prepare("INSERT INTO blueprint_families (blueprint_id, family_id) VALUES (?, 'fam_1')").run(id);
  db.sqlite.prepare("INSERT INTO blueprint_families (blueprint_id, family_id) VALUES (?, 'fam_rev')").run(id);
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
      opts.ctx.saveMemory("new one", "blueprint");
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

  it("buildCopilotContext exposes the family tree, default resolution, and per-period files", () => {
    const context = buildCopilotContext(getDb(), "bp_1", new Map());

    // Every project family appears; bound ones marked, filed periods ascending.
    expect(context.families).toEqual([
      { id: "fam_un", key: "leftover", label: "Leftover", kind: "periodic", granularity: "month", filedPeriods: [], hasLiveFile: false, bound: false },
      { id: "fam_rev", key: "revenue", label: "Revenue", kind: "periodic", granularity: "quarter", filedPeriods: ["2026-Q1", "2026-Q2"], hasLiveFile: false, bound: true },
      { id: "fam_1", key: "src", label: "Src", kind: "constant", granularity: null, filedPeriods: [], hasLiveFile: true, bound: true },
    ]);

    // defaultFiles: constant live file + periodic latest period (Q2). id = family id.
    expect(context.defaultFiles.map((f) => f.id).sort()).toEqual(["fam_1", "fam_rev"]);
    const rev = context.defaultFiles.find((f) => f.id === "fam_rev")!;
    expect(rev.path).toContain("src_q2.csv");

    // periodFiles: every filed periodic row of the bound families.
    expect(context.periodFiles.map((p) => `${p.familyId}:${p.period}`)).toEqual([
      "fam_rev:2026-Q1",
      "fam_rev:2026-Q2",
    ]);
    expect(context.periodFiles.every((p) => p.file.id === p.familyId)).toBe(true);
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
