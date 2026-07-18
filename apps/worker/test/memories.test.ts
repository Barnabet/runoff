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
  sections: [{ key: "exec", number: 1, heading: "Executive Summary", mode: "auto", instruction: "", fixedText: "", sourceIds: [], rules: [] }],
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
    distillRun.mockResolvedValue([]);

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

    // Interactive run: executeRun emits a steer + completion through the run's event log.
    executeRun.mockImplementation(async (opts: any) => {
      opts.io.emit({ type: "steer_received", sectionKey: "exec", text: "shorter please" });
      opts.io.emit({ type: "run_completed", stats: STATS, document: DOC });
      return { document: DOC, stats: STATS };
    });
    distillRun.mockResolvedValue(["Keep the executive summary short."]);

    await processOne(db, {} as never);

    expect(distillRun).toHaveBeenCalledOnce();
    const arg = distillRun.mock.calls[0][0] as { interactions: { steers: string[] } };
    expect(arg.interactions.steers).toEqual(["shorter please"]);
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
});
