import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type RunoffDb } from "@runoff/core";

const executeRun = vi.fn();
const distillRun = vi.fn();
vi.mock("@runoff/engine", () => ({
  executeRun: (...a: unknown[]) => executeRun(...a),
  distillRun: (...a: unknown[]) => distillRun(...a),
  makeLlmClient: () => ({}),
}));

import { processOne } from "../src/runLoop.js";

const CONTENT = JSON.stringify({
  title: "T", clientName: "C", eyebrow: "E", dateline: "D",
  sections: [{ key: "exec", number: 1, heading: "Executive Summary", mode: "auto", instruction: "", fixedText: "", familyIds: [], rules: [] }],
  globalRules: [],
  delivery: { recipient: "", autoDeliverOnClear: false },
});
const DOC = { title: "T", eyebrow: "E", dateline: "D", sections: [] };
const STATS = {
  durationMs: 1, words: 1, sourcesUsed: 0, checksPassed: 0, checksFailed: 0,
  flagCount: 0, citationCount: 0, retries: 0,
};
const RUN_ID = "run_cur";

/** Fresh temp db with bp_1 @ rev 1 seeded. */
function seedDb(): RunoffDb {
  const dir = mkdtempSync(join(tmpdir(), "runoff-worker-mem-"));
  process.env.RUNOFF_FILES_DIR = dir;
  const db = openDb(join(dir, "t.db"));
  db.sqlite.prepare("INSERT INTO blueprints (id, name, client_name, current_rev) VALUES ('bp_1', 'B', 'C', 1)").run();
  db.sqlite.prepare("INSERT INTO blueprint_revisions (blueprint_id, rev, content) VALUES ('bp_1', 1, ?)").run(CONTENT);
  return db;
}

function queueRun(db: RunoffDb, id: string, createdAt: string): void {
  db.sqlite
    .prepare("INSERT INTO runs (id, blueprint_id, blueprint_rev, status, created_at) VALUES (?, 'bp_1', 1, 'queued', ?)")
    .run(id, createdAt);
}

describe("worker memory wiring", () => {
  beforeEach(() => {
    executeRun.mockReset();
    distillRun.mockReset();
  });

  it("passes active memories (not disabled ones) into executeRun", async () => {
    const db = seedDb();
    db.sqlite.prepare("INSERT INTO memories (id, blueprint_id, body, source) VALUES ('m1','bp_1','Use percentages.','copilot')").run();
    db.sqlite.prepare("INSERT INTO memories (id, blueprint_id, body, source) VALUES ('m2','bp_1','Be terse.','distilled')").run();
    db.sqlite.prepare("INSERT INTO memories (id, blueprint_id, body, source, status) VALUES ('m3','bp_1','Old.','copilot','disabled')").run();
    queueRun(db, RUN_ID, "2026-07-18 09:00:00");
    executeRun.mockResolvedValue({ document: DOC, stats: STATS });
    // No interactions on this run, so the distiller is never reached.

    await processOne(db, {} as never);

    const opts = executeRun.mock.calls[0][0] as { memories?: { id: string; body: string }[] };
    expect(opts.memories).toEqual([
      { id: "m1", body: "Use percentages." },
      { id: "m2", body: "Be terse." },
    ]);
  });

  it("inserts distilled memories after an interactive completed run, and skips the distiller for a quiet run", async () => {
    const db = seedDb();
    queueRun(db, RUN_ID, "2026-07-18 09:00:00");

    // Interactive run: executeRun emits a steer, a raised+answered question, and
    // completion through the run's event log.
    executeRun.mockImplementation(async (opts: any) => {
      opts.io.emit({ type: "steer_received", sectionKey: "exec", text: "shorter please" });
      opts.io.emit({
        type: "question_raised", questionId: "q_1", sectionKey: "exec",
        question: "Which fiscal year?", options: [], fallback: "", deadlineSection: "exec",
      });
      opts.io.emit({ type: "question_answered", questionId: "q_1", answer: "FY2025" });
      opts.io.emit({ type: "run_completed", stats: STATS, document: DOC });
      return { document: DOC, stats: STATS };
    });
    distillRun.mockResolvedValue(["Keep the executive summary short."]);

    await processOne(db, {} as never);

    expect(distillRun).toHaveBeenCalledOnce();
    const arg = distillRun.mock.calls[0][0] as {
      interactions: { steers: string[]; answers: { question: string; answer: string }[] };
    };
    expect(arg.interactions.steers).toEqual(["shorter please"]);
    // The distiller must receive the question TEXT, not the opaque questionId.
    expect(arg.interactions.answers).toEqual([{ question: "Which fiscal year?", answer: "FY2025" }]);
    const rows = db.sqlite.prepare("SELECT body, source, origin_id AS originId, status FROM memories WHERE source='distilled'").all();
    expect(rows).toEqual([{ body: "Keep the executive summary short.", source: "distilled", originId: RUN_ID, status: "active" }]);

    // Quiet run: no steers/answers/resolved flags -> distiller never called.
    distillRun.mockClear();
    queueRun(db, "run_2", "2026-07-18 10:00:00");
    executeRun.mockImplementation(async (opts: any) => {
      opts.io.emit({ type: "run_completed", stats: STATS, document: DOC });
      return { document: DOC, stats: STATS };
    });

    await processOne(db, {} as never);

    expect(distillRun).not.toHaveBeenCalled();
  });

  it("a distiller failure never flips a completed run to failed", async () => {
    const db = seedDb();
    queueRun(db, RUN_ID, "2026-07-18 09:00:00");

    executeRun.mockImplementation(async (opts: any) => {
      opts.io.emit({ type: "steer_received", sectionKey: "exec", text: "shorter please" });
      opts.io.emit({ type: "run_completed", stats: STATS, document: DOC });
      return { document: DOC, stats: STATS };
    });
    // If this throw escaped distillCompletedRun into processOne's outer catch,
    // the run would be flipped to failed.
    distillRun.mockRejectedValue(new Error("distill boom"));

    await processOne(db, {} as never);

    const run = db.sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(RUN_ID) as { status: string };
    expect(run.status).toBe("complete");
    const failed = db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ? AND type = 'run_failed'")
      .get(RUN_ID) as { n: number };
    expect(failed.n).toBe(0);
  });

  it("caps active memories at 30, disabling the oldest active row", async () => {
    const db = seedDb();
    const insert = db.sqlite.prepare(
      "INSERT INTO memories (id, blueprint_id, body, source) VALUES (?, 'bp_1', ?, 'distilled')",
    );
    for (let i = 0; i < 30; i++) insert.run(`seed_${i}`, `Memory ${i}.`);

    queueRun(db, RUN_ID, "2026-07-18 09:00:00");
    executeRun.mockImplementation(async (opts: any) => {
      opts.io.emit({ type: "steer_received", sectionKey: "exec", text: "shorter please" });
      opts.io.emit({ type: "run_completed", stats: STATS, document: DOC });
      return { document: DOC, stats: STATS };
    });
    distillRun.mockResolvedValue(["A fresh distilled memory."]);

    await processOne(db, {} as never);

    // The new memory landed.
    const fresh = db.sqlite
      .prepare("SELECT status FROM memories WHERE body = 'A fresh distilled memory.'")
      .get() as { status: string } | undefined;
    expect(fresh).toEqual({ status: "active" });

    // The cap holds: still exactly 30 active.
    const active = db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM memories WHERE blueprint_id = 'bp_1' AND status = 'active'")
      .get() as { n: number };
    expect(active.n).toBe(30);

    // The disabled row is the OLDEST of the original 30 (lowest rowid).
    const disabled = db.sqlite
      .prepare("SELECT id FROM memories WHERE blueprint_id = 'bp_1' AND status = 'disabled'")
      .all() as { id: string }[];
    expect(disabled).toEqual([{ id: "seed_0" }]);
  });
});
