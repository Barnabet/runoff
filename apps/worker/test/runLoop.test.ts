import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openDb,
  newId,
  blueprints,
  blueprintRevisions,
  runs,
  type RunoffDb,
  type BlueprintContent,
  type RunDocument,
} from "@runoff/core";
import { claimQueuedRun, failStaleRuns, makeEngineIO, processOne } from "../src/runLoop.js";

function tempDb(): RunoffDb {
  return openDb(join(mkdtempSync(join(tmpdir(), "runoff-worker-")), "t.db"));
}

// A fixed-only blueprint: fixed sections never call the model, so `processOne`
// can drive an end-to-end run with a `null` client.
const fixedOnlyContent: BlueprintContent = {
  title: "Weekly Digest",
  clientName: "Acme",
  eyebrow: "Weekly",
  dateline: "July 2026",
  sections: [
    { key: "intro", number: 1, heading: "Introduction", mode: "fixed", instruction: "", fixedText: "Welcome to the digest.", sourceIds: [], rules: [] },
  ],
  globalRules: [],
  delivery: { recipient: "", autoDeliverOnClear: false },
};

function seedQueuedRun(db: RunoffDb, content: BlueprintContent): string {
  const bpId = newId("bp");
  db.orm.insert(blueprints).values({ id: bpId, name: "Digest", currentRev: 1 }).run();
  db.orm.insert(blueprintRevisions).values({ id: newId("rev"), blueprintId: bpId, rev: 1, content: JSON.stringify(content) }).run();
  const runId = newId("run");
  db.orm.insert(runs).values({ id: runId, blueprintId: bpId, blueprintRev: 1, status: "queued" }).run();
  return runId;
}

describe("processOne", () => {
  it("claims and completes a fixed-only run without touching the client", async () => {
    const db = tempDb();
    const runId = seedQueuedRun(db, fixedOnlyContent);

    const processed = await processOne(db, null as any);
    expect(processed).toBe(true);

    const run = db.sqlite
      .prepare("SELECT status, document, stats, started_at, finished_at FROM runs WHERE id = ?")
      .get(runId) as { status: string; document: string; stats: string; started_at: string; finished_at: string };
    expect(run.status).toBe("complete");
    expect(run.started_at).toBeTruthy();
    expect(run.finished_at).toBeTruthy();
    expect(run.stats).toBeTruthy();

    const doc = JSON.parse(run.document) as RunDocument;
    expect(doc.sections).toHaveLength(1);
    expect(doc.sections[0].heading).toBe("Introduction");

    const events = db.sqlite
      .prepare("SELECT seq, type FROM run_events WHERE run_id = ? ORDER BY seq")
      .all(runId) as { seq: number; type: string }[];
    const types = events.map((e) => e.type);
    expect(types).toContain("run_started");
    expect(types).toContain("run_completed");
    // run_started must precede run_completed.
    expect(types.indexOf("run_started")).toBeLessThan(types.indexOf("run_completed"));

    const seqs = events.map((e) => e.seq);
    expect(seqs[0]).toBe(1);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // monotonic
    expect(new Set(seqs).size).toBe(seqs.length); // unique
  });

  it("returns false when nothing is queued", async () => {
    const db = tempDb();
    expect(await processOne(db, null as any)).toBe(false);
  });

  it("marks the run failed (status + run_failed event) when the revision content is invalid", async () => {
    const db = tempDb();
    const bpId = newId("bp");
    db.orm.insert(blueprints).values({ id: bpId, name: "Broken", currentRev: 1 }).run();
    // Content that fails BlueprintContentSchema (missing required fields).
    db.orm.insert(blueprintRevisions).values({ id: newId("rev"), blueprintId: bpId, rev: 1, content: JSON.stringify({ title: "oops" }) }).run();
    const runId = newId("run");
    db.orm.insert(runs).values({ id: runId, blueprintId: bpId, blueprintRev: 1, status: "queued" }).run();

    expect(await processOne(db, null as any)).toBe(true);

    const run = db.sqlite.prepare("SELECT status, finished_at FROM runs WHERE id = ?").get(runId) as { status: string; finished_at: string };
    expect(run.status).toBe("failed");
    expect(run.finished_at).toBeTruthy();

    const events = db.sqlite.prepare("SELECT type FROM run_events WHERE run_id = ?").all(runId) as { type: string }[];
    expect(events.some((e) => e.type === "run_failed")).toBe(true);
  });
});

describe("makeEngineIO", () => {
  it("inserts a matching flags row when a flag_raised event is emitted", () => {
    const db = tempDb();
    const runId = newId("run");
    db.sqlite.prepare("INSERT INTO runs (id, blueprint_id, blueprint_rev, status) VALUES (?, 'bp_x', 1, 'running')").run(runId);

    const io = makeEngineIO(db, runId);
    io.emit({ type: "flag_raised", flagId: "flag_1", code: "F1", sectionKey: "body", question: "Keep this?", options: ["Keep", "Drop"] });

    const flag = db.sqlite.prepare("SELECT id, run_id, code, section_key, question, options, status FROM flags WHERE id = ?").get("flag_1") as {
      id: string; run_id: string; code: string; section_key: string; question: string; options: string; status: string;
    };
    expect(flag).toBeTruthy();
    expect(flag.run_id).toBe(runId);
    expect(flag.code).toBe("F1");
    expect(flag.section_key).toBe("body");
    expect(flag.question).toBe("Keep this?");
    expect(JSON.parse(flag.options)).toEqual(["Keep", "Drop"]);
    expect(flag.status).toBe("open");

    // The event itself is still recorded.
    const ev = db.sqlite.prepare("SELECT type FROM run_events WHERE run_id = ?").all(runId) as { type: string }[];
    expect(ev.some((e) => e.type === "flag_raised")).toBe(true);
  });
});

describe("claimQueuedRun", () => {
  it("returns undefined when nothing is queued", () => {
    const db = tempDb();
    expect(claimQueuedRun(db)).toBeUndefined();
  });

  it("claims the oldest queued run and flips it to running", () => {
    const db = tempDb();
    const runId = seedQueuedRun(db, fixedOnlyContent);
    const claimed = claimQueuedRun(db);
    expect(claimed).toEqual({ id: runId, blueprintId: expect.any(String), blueprintRev: 1 });
    const row = db.sqlite.prepare("SELECT status, started_at FROM runs WHERE id = ?").get(runId) as { status: string; started_at: string };
    expect(row.status).toBe("running");
    expect(row.started_at).toBeTruthy();
    // Once claimed, it is no longer available.
    expect(claimQueuedRun(db)).toBeUndefined();
  });
});

describe("failStaleRuns", () => {
  it("flips stuck running/paused runs to failed with a run_failed event", () => {
    const db = tempDb();
    const running = newId("run");
    const paused = newId("run");
    db.sqlite.prepare("INSERT INTO runs (id, blueprint_id, blueprint_rev, status) VALUES (?, 'bp_x', 1, 'running')").run(running);
    db.sqlite.prepare("INSERT INTO runs (id, blueprint_id, blueprint_rev, status) VALUES (?, 'bp_x', 1, 'paused')").run(paused);
    // A completed run must be left untouched.
    const done = newId("run");
    db.sqlite.prepare("INSERT INTO runs (id, blueprint_id, blueprint_rev, status) VALUES (?, 'bp_x', 1, 'complete')").run(done);

    const count = failStaleRuns(db);
    expect(count).toBe(2);

    for (const id of [running, paused]) {
      const run = db.sqlite.prepare("SELECT status, finished_at FROM runs WHERE id = ?").get(id) as { status: string; finished_at: string };
      expect(run.status).toBe("failed");
      expect(run.finished_at).toBeTruthy();
      const ev = db.sqlite.prepare("SELECT type, payload FROM run_events WHERE run_id = ? ORDER BY seq").all(id) as { type: string; payload: string }[];
      expect(ev.some((e) => e.type === "run_failed" && JSON.parse(e.payload).error === "worker restarted mid-run")).toBe(true);
    }

    expect((db.sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(done) as { status: string }).status).toBe("complete");
  });
});
