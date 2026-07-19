import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "@runoff/core";

vi.mock("@runoff/engine", () => ({ executeRun: vi.fn(async () => undefined) }));
import { executeRun } from "@runoff/engine";
import { processOne } from "../src/runLoop.js";

const CONTENT = JSON.stringify({
  title: "T", clientName: "C", eyebrow: "E", dateline: "D",
  sections: [{ key: "s1", number: 1, heading: "S1", mode: "fixed", instruction: "", fixedText: "Hello.", familyIds: [], queries: [], rules: [] }],
  globalRules: [],
  delivery: { recipient: "", autoDeliverOnClear: false },
});
const PREV_DOC = { title: "Prev", eyebrow: "E", dateline: "D", sections: [] };

it("passes the predecessor's document to executeRun", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runoff-worker-prev-"));
  process.env.RUNOFF_FILES_DIR = dir;
  const db = openDb(join(dir, "t.db"));
  db.sqlite.prepare("INSERT INTO blueprints (id, name, client_name, current_rev) VALUES ('bp_1', 'B', 'C', 1)").run();
  db.sqlite
    .prepare("INSERT INTO blueprint_revisions (blueprint_id, rev, content) VALUES ('bp_1', 1, ?)")
    .run(CONTENT);
  db.sqlite
    .prepare(
      `INSERT INTO runs (id, blueprint_id, blueprint_rev, status, created_at, finished_at, document)
       VALUES ('run_prev', 'bp_1', 1, 'complete', '2026-07-01 09:00:00', '2026-07-01 09:10:00', ?)`,
    )
    .run(JSON.stringify(PREV_DOC));
  db.sqlite
    .prepare(
      "INSERT INTO runs (id, blueprint_id, blueprint_rev, status, created_at) VALUES ('run_cur', 'bp_1', 1, 'queued', '2026-07-18 09:00:00')",
    )
    .run();

  expect(await processOne(db, null as any)).toBe(true);
  const opts = (executeRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
  expect(opts.previousDocument).toEqual(PREV_DOC);
});
