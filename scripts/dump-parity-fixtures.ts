/**
 * Dump cross-language parity fixtures: for each pure @runoff/core function that
 * the Python port reimplements, record its real inputs and the TS output into
 * backend/tests/fixtures/. backend/tests/test_parity_fixtures.py then replays
 * the recorded inputs through the Python port and asserts byte-equal output.
 *
 * Reads RUNOFF_DB (default data/runoff.db) — requires a freshly seeded DB
 * (rm -f data/runoff.db* && pnpm seed; the glob matters, stale -wal/-shm
 * sidecars break openDb). Deterministic given the DB state: re-running produces
 * byte-identical fixtures (dump twice + diff to confirm).
 *
 * Run: pnpm backend:fixtures
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  openDb,
  reduceRun,
  diffRuns,
  parseBindings,
  boundnessCounts,
  buildWarehouseCatalog,
  previousCompletedDocument,
  type RunEvent,
  type RunDocument,
} from "@runoff/core";

const dbPath = process.env.RUNOFF_DB ?? "data/runoff.db";
const FIX_DIR = "backend/tests/fixtures";

function writeFixture(name: string, value: unknown): void {
  writeFileSync(join(FIX_DIR, name), JSON.stringify(value, null, 2) + "\n");
  console.log(`wrote ${name}`);
}

function main(): void {
  mkdirSync(FIX_DIR, { recursive: true });
  const db = openDb(dbPath);

  // The seeded bound golden anchors "the seeded blueprint" — the one golden row
  // carrying a non-null bindings string.
  const golden = db.sqlite
    .prepare(
      "SELECT blueprint_id AS blueprintId, bindings FROM goldens WHERE bindings IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .get() as { blueprintId: string; bindings: string } | undefined;
  if (!golden) throw new Error("no bound golden in DB — reseed with `pnpm seed`");

  const bp = db.sqlite
    .prepare("SELECT id, project_id AS projectId FROM blueprints WHERE id = ?")
    .get(golden.blueprintId) as { id: string; projectId: string } | undefined;
  if (!bp) throw new Error(`blueprint ${golden.blueprintId} not found`);

  // --- bindings.json (always available: the golden's bindings string) ---
  const parsed = parseBindings(golden.bindings);
  writeFixture("bindings.json", {
    raw: golden.bindings,
    parsed,
    counts: boundnessCounts(parsed),
  });

  // --- catalog.json (always available: read of source_families + warehouses) ---
  writeFixture("catalog.json", {
    projectId: bp.projectId,
    catalog: buildWarehouseCatalog(db, bp.projectId),
  });

  // --- reducer.json (needs a completed run's real event log) ---
  const run = db.sqlite
    .prepare(
      `SELECT id, blueprint_id AS blueprintId, blueprint_rev AS blueprintRev,
              created_at AS createdAt, document
       FROM runs WHERE blueprint_id = ? AND status = 'complete'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(golden.blueprintId) as
    | { id: string; blueprintId: string; blueprintRev: number; createdAt: string; document: string | null }
    | undefined;

  if (!run) {
    console.log("no completed run for the seeded blueprint — reducer.json + diff.json = null (parity tests skip)");
    writeFixture("reducer.json", null);
    writeFixture("diff.json", null);
    db.sqlite.close();
    return;
  }

  const events = (
    db.sqlite.prepare("SELECT payload FROM run_events WHERE run_id = ? ORDER BY seq").all(run.id) as {
      payload: string;
    }[]
  ).map((r) => JSON.parse(r.payload) as RunEvent);

  // sectionMeta comes from the revision the run is pinned to (mirrors getRunPayload).
  const revRow = db.sqlite
    .prepare("SELECT content FROM blueprint_revisions WHERE blueprint_id = ? AND rev = ?")
    .get(run.blueprintId, run.blueprintRev) as { content: string } | undefined;
  const content = revRow
    ? (JSON.parse(revRow.content) as { sections: { key: string; number: number; heading: string }[] })
    : null;
  const sectionMeta = content
    ? content.sections
        .map((s) => ({ key: s.key, number: s.number, heading: s.heading }))
        .sort((a, b) => a.number - b.number)
    : [];

  writeFixture("reducer.json", {
    sectionMeta,
    events,
    projection: reduceRun(events, sectionMeta),
  });

  // --- diff.json (needs a predecessor completed run) ---
  const current = run.document ? (JSON.parse(run.document) as RunDocument) : null;
  const prev = previousCompletedDocument(db.sqlite, run.blueprintId, {
    runId: run.id,
    createdAt: run.createdAt,
  });
  if (!current || !prev) {
    console.log("no predecessor completed run (or current has no document) — diff.json = null (parity test skips)");
    writeFixture("diff.json", null);
  } else {
    writeFixture("diff.json", {
      current,
      previous: prev.document,
      diff: diffRuns(current, prev.document),
    });
  }

  db.sqlite.close();
}

main();
