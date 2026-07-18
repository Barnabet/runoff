import type OpenAI from "openai";
import {
  type RunoffDb,
  type RunEvent,
  type BlueprintContent,
  BlueprintContentSchema,
  previousCompletedDocument,
  newId,
} from "@runoff/core";
import {
  executeRun,
  distillRun,
  type RunInteractions,
  type EngineIO,
  type RunInputMsg,
} from "@runoff/engine";
import { resolveRunSources } from "./resolveSources.js";

/** Atomically claim the oldest queued run (single statement; RETURNING gives us its identity). */
const CLAIM_SQL = `
UPDATE runs SET status='running', started_at=datetime('now')
WHERE id = (SELECT id FROM runs WHERE status='queued' ORDER BY created_at LIMIT 1)
RETURNING id, blueprint_id AS blueprintId, blueprint_rev AS blueprintRev, period`;

export function claimQueuedRun(
  db: RunoffDb,
): { id: string; blueprintId: string; blueprintRev: number; period: string | null } | undefined {
  const row = db.sqlite.prepare(CLAIM_SQL).get() as
    | { id: string; blueprintId: string; blueprintRev: number; period: string | null }
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
        // The engine mints per-run flag ids (`flag_1`, `flag_2`, …); the `flags`
        // table is globally keyed, so namespace the row id by run to avoid a
        // cross-run primary-key collision. The event payload (and thus the UI's
        // in-flight projection) keeps the bare id; the API reads the row id back.
        insertFlag.run(`${runId}_${e.flagId}`, runId, e.code, e.sectionKey, e.question, JSON.stringify(e.options));
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
      // Immediate mode takes the write lock up front, so the MAX(seq) read and
      // the insert see one snapshot — avoids SQLITE_BUSY_SNAPSHOT (which
      // busy_timeout does not retry) when the web app writes concurrently.
      emitTx.immediate(e);
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

    const { files, gaps } = resolveRunSources(db, claimed.blueprintId, claimed.period);

    const runRow = db.sqlite
      .prepare("SELECT created_at AS createdAt FROM runs WHERE id = ?")
      .get(claimed.id) as { createdAt: string };
    const previous = previousCompletedDocument(db.sqlite, claimed.blueprintId, {
      runId: claimed.id,
      createdAt: runRow.createdAt,
    });

    const memoryRows = db.sqlite
      .prepare(
        `SELECT id, body, scope FROM memories
         WHERE status='active' AND (blueprint_id = ? OR (scope='project' AND project_id = (SELECT project_id FROM blueprints WHERE id = ?)))
         ORDER BY rowid`,
      )
      .all(claimed.blueprintId, claimed.blueprintId) as { id: string; body: string; scope: "blueprint" | "project" }[];

    await executeRun({
      client,
      content,
      files,
      io,
      blueprintRev: claimed.blueprintRev,
      previousDocument: previous?.document,
      memories: memoryRows,
      period: claimed.period,
      gaps,
    });
    // Success is already persisted by the `run_completed` emit handler.
    await distillCompletedRun(db, client, claimed.id, claimed.blueprintId, content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] run ${claimed.id} failed: ${message}`);
    // If the engine threw it already emitted `run_failed` (which set status).
    // For pre-engine throws (revision missing / zod parse) nothing marked it yet.
    const row = db.sqlite.prepare("SELECT status FROM runs WHERE id = ?").get(claimed.id) as
      | { status: string }
      | undefined;
    if (row && row.status !== "failed") {
      io.emit({ type: "run_failed", error: message });
    }
  }
  return true;
}

/**
 * Post-run learning: turn this run's human interventions into standing
 * memories. Read-side is the run's own event log + resolved flags; any failure
 * is logged and swallowed — distillation must never affect run status.
 */
async function distillCompletedRun(
  db: RunoffDb,
  client: OpenAI,
  runId: string,
  blueprintId: string,
  content: BlueprintContent,
): Promise<void> {
  try {
    const events = db.sqlite
      .prepare(
        "SELECT type, payload FROM run_events WHERE run_id = ? AND type IN ('steer_received','question_raised','question_answered') ORDER BY seq",
      )
      .all(runId) as { type: string; payload: string }[];
    // `question_answered` carries only {questionId, answer}; the question text
    // lives in the preceding `question_raised` event, so map ids -> text first.
    const questionText = new Map<string, string>();
    for (const e of events) {
      if (e.type !== "question_raised") continue;
      const p = JSON.parse(e.payload);
      if (typeof p.questionId === "string" && typeof p.question === "string") questionText.set(p.questionId, p.question);
    }
    const interactions: RunInteractions = { steers: [], answers: [], flagResolutions: [] };
    for (const e of events) {
      const p = JSON.parse(e.payload);
      if (e.type === "steer_received" && typeof p.text === "string") interactions.steers.push(p.text);
      if (e.type === "question_answered" && typeof p.answer === "string") {
        interactions.answers.push({ question: questionText.get(p.questionId) ?? String(p.questionId ?? ""), answer: p.answer });
      }
    }
    const flagRows = db.sqlite
      .prepare("SELECT question, resolution FROM flags WHERE run_id = ? AND status = 'resolved' AND resolution IS NOT NULL")
      .all(runId) as { question: string; resolution: string }[];
    interactions.flagResolutions = flagRows.map((f) => ({ question: f.question, resolution: f.resolution }));

    if (!interactions.steers.length && !interactions.answers.length && !interactions.flagResolutions.length) return;

    // This blueprint's project, so project-scoped memories land on the right row.
    const projectId =
      (db.sqlite.prepare("SELECT project_id AS projectId FROM blueprints WHERE id = ?").get(blueprintId) as
        | { projectId: string }
        | undefined)?.projectId ?? "";

    // Dedup pool spans both scopes (dedup is on lowercased body, scope-agnostic).
    const existing = db.sqlite
      .prepare(
        `SELECT body, scope FROM memories WHERE blueprint_id = ? OR (scope='project' AND project_id = ?)`,
      )
      .all(blueprintId, projectId) as { body: string; scope: string }[];

    const fresh = await distillRun({
      client,
      title: content.title,
      sectionHeadings: content.sections.map((s) => s.heading),
      interactions,
      existing,
    });

    const insert = db.sqlite.prepare(
      "INSERT INTO memories (id, scope, project_id, blueprint_id, body, source, origin_id) VALUES (?, ?, ?, ?, ?, 'distilled', ?)",
    );
    for (const m of fresh) {
      enforceMemoryCap(db, m.scope === "project" ? { projectId } : { blueprintId });
      insert.run(newId("mem"), m.scope, projectId, m.scope === "blueprint" ? blueprintId : null, m.body, runId);
    }
  } catch (err) {
    console.error(`[worker] distillation failed for run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Cap active memories at 30 within one scope by disabling the oldest active row.
 * Project scope keys on `project_id`; blueprint scope on `blueprint_id`.
 */
function enforceMemoryCap(db: RunoffDb, scope: { projectId: string } | { blueprintId: string }): void {
  const clause =
    "projectId" in scope ? "scope='project' AND project_id = ?" : "scope='blueprint' AND blueprint_id = ?";
  const val = "projectId" in scope ? scope.projectId : scope.blueprintId;
  const { n } = db.sqlite
    .prepare(`SELECT COUNT(*) AS n FROM memories WHERE ${clause} AND status='active'`)
    .get(val) as { n: number };
  if (n >= 30) {
    db.sqlite
      .prepare(
        `UPDATE memories SET status='disabled' WHERE id = (SELECT id FROM memories WHERE ${clause} AND status='active' ORDER BY rowid LIMIT 1)`,
      )
      .run(val);
  }
}
