import { join } from "node:path";
import type OpenAI from "openai";
import { type RunoffDb, type RunEvent, BlueprintContentSchema } from "@runoff/core";
import { executeRun, type EngineIO, type RunInputMsg, type EngineFile } from "@runoff/engine";

/** Atomically claim the oldest queued run (single statement; RETURNING gives us its identity). */
const CLAIM_SQL = `
UPDATE runs SET status='running', started_at=datetime('now')
WHERE id = (SELECT id FROM runs WHERE status='queued' ORDER BY created_at LIMIT 1)
RETURNING id, blueprint_id AS blueprintId, blueprint_rev AS blueprintRev`;

export function claimQueuedRun(
  db: RunoffDb,
): { id: string; blueprintId: string; blueprintRev: number } | undefined {
  const row = db.sqlite.prepare(CLAIM_SQL).get() as
    | { id: string; blueprintId: string; blueprintRev: number }
    | undefined;
  return row ?? undefined;
}

/**
 * The side-channel the engine drives for a single run. `emit` appends a run
 * event (seq = max+1) in one transaction and mirrors run status onto the
 * `runs` row (and, for flags, into the `flags` table) so the API can report
 * status without replaying events. `pollInputs` drains pending worker inputs.
 */
export function makeEngineIO(db: RunoffDb, runId: string): EngineIO {
  const nextSeq = db.sqlite.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM run_events WHERE run_id = ?");
  const insertEvent = db.sqlite.prepare("INSERT INTO run_events (run_id, seq, type, payload) VALUES (?, ?, ?, ?)");
  const insertFlag = db.sqlite.prepare(
    "INSERT INTO flags (id, run_id, code, section_key, question, options) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const setStatus = db.sqlite.prepare("UPDATE runs SET status=? WHERE id = ?");
  const finishComplete = db.sqlite.prepare(
    "UPDATE runs SET status='complete', finished_at=datetime('now'), stats=?, document=? WHERE id = ?",
  );
  const finishFailed = db.sqlite.prepare("UPDATE runs SET status='failed', finished_at=datetime('now') WHERE id = ?");

  const emitTx = db.sqlite.transaction((e: RunEvent) => {
    const { seq } = nextSeq.get(runId) as { seq: number };
    insertEvent.run(runId, seq, e.type, JSON.stringify(e));
    switch (e.type) {
      case "flag_raised":
        insertFlag.run(e.flagId, runId, e.code, e.sectionKey, e.question, JSON.stringify(e.options));
        break;
      case "paused":
        setStatus.run("paused", runId);
        break;
      case "resumed":
        setStatus.run("running", runId);
        break;
      case "run_completed":
        finishComplete.run(JSON.stringify(e.stats), JSON.stringify(e.document), runId);
        break;
      case "run_failed":
        finishFailed.run(runId);
        break;
    }
  });

  const selectInputs = db.sqlite.prepare(
    "SELECT id, kind, payload FROM run_inputs WHERE run_id = ? AND consumed_at IS NULL ORDER BY id",
  );
  const consumeInput = db.sqlite.prepare("UPDATE run_inputs SET consumed_at=datetime('now') WHERE id = ?");

  return {
    emit(e: RunEvent): void {
      emitTx(e);
    },
    pollInputs(): RunInputMsg[] {
      const rows = selectInputs.all(runId) as { id: number; kind: string; payload: string }[];
      return rows.map((r) => {
        consumeInput.run(r.id);
        const payload = JSON.parse(r.payload) as { text?: string; questionId?: string };
        return { kind: r.kind as RunInputMsg["kind"], text: payload.text, questionId: payload.questionId };
      });
    },
    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}

/**
 * Boot recovery: any run left `running`/`paused` by a crashed worker is
 * unrecoverable (the engine's in-memory state is gone), so mark it failed and
 * append a `run_failed` event. Returns how many runs were recovered.
 */
export function failStaleRuns(db: RunoffDb): number {
  const stale = db.sqlite
    .prepare("SELECT id FROM runs WHERE status IN ('running', 'paused')")
    .all() as { id: string }[];
  for (const { id } of stale) {
    makeEngineIO(db, id).emit({ type: "run_failed", error: "worker restarted mid-run" });
  }
  return stale.length;
}

/**
 * Claim and execute one queued run. Loads the pinned blueprint revision content
 * and its bound source files, runs the engine (which persists success and, on
 * failure, emits `run_failed` before throwing), and guards pre-engine throws
 * (e.g. a malformed revision) by marking the run failed itself.
 * Returns whether a run was claimed.
 */
export async function processOne(db: RunoffDb, client: OpenAI): Promise<boolean> {
  const claimed = claimQueuedRun(db);
  if (!claimed) return false;

  const io = makeEngineIO(db, claimed.id);
  try {
    const revRow = db.sqlite
      .prepare("SELECT content FROM blueprint_revisions WHERE blueprint_id = ? AND rev = ?")
      .get(claimed.blueprintId, claimed.blueprintRev) as { content: string } | undefined;
    if (!revRow) throw new Error(`blueprint revision not found: ${claimed.blueprintId}@${claimed.blueprintRev}`);
    const content = BlueprintContentSchema.parse(JSON.parse(revRow.content));

    const bound = db.sqlite
      .prepare(
        "SELECT s.id, s.name, s.mime, s.stored_filename AS storedFilename FROM blueprint_sources bs JOIN sources s ON s.id = bs.source_id WHERE bs.blueprint_id = ?",
      )
      .all(claimed.blueprintId) as { id: string; name: string; mime: string; storedFilename: string }[];
    const filesDir = process.env.RUNOFF_FILES_DIR ?? "data/files";
    const files: EngineFile[] = bound.map((s) => ({
      id: s.id,
      name: s.name,
      mime: s.mime,
      path: join(filesDir, s.storedFilename),
    }));

    await executeRun({ client, content, files, io, blueprintRev: claimed.blueprintRev });
    // Success is already persisted by the `run_completed` emit handler.
  } catch (err) {
    // If the engine threw it already emitted `run_failed` (which set status).
    // For pre-engine throws (revision missing / zod parse) nothing marked it yet.
    const row = db.sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(claimed.id) as
      | { status: string }
      | undefined;
    if (row && row.status !== "failed") {
      io.emit({ type: "run_failed", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return true;
}
