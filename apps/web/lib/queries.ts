import { join } from "node:path";
import { blocksToPlainText, newId, previousCompletedDocument } from "@runoff/core";
import type { RunDocument, RunEvent, RunoffDb } from "@runoff/core";
import type { CopilotContext, EngineFile, RunSummary, RunSectionDetail } from "@runoff/engine";
import type { BlueprintListItem, FlagRow, GetRunResponse, RunRow, SourceRow } from "./api";
import { listGoldenSummaries } from "./goldens";

// Server-only db reads shared by the API route and the server-rendered Library
// page so the blueprint+run join lives in exactly one place. Never import this
// from client code — it touches the SQLite handle.

interface BlueprintListRow {
  id: string;
  name: string;
  clientName: string;
  cadenceLabel: string;
  status: string;
  currentRev: number;
  sourceCount: number;
}

/**
 * Every blueprint with its bound-source count, its latest run (by created_at),
 * and that run's open-flag count. Ordered newest-blueprint first.
 */
export function listBlueprintsWithRuns(db: RunoffDb): BlueprintListItem[] {
  const rows = db.sqlite
    .prepare(
      `SELECT b.id, b.name, b.client_name AS clientName, b.cadence_label AS cadenceLabel,
              b.status, b.current_rev AS currentRev,
              (SELECT COUNT(*) FROM blueprint_sources bs WHERE bs.blueprint_id = b.id) AS sourceCount
       FROM blueprints b
       ORDER BY b.created_at DESC, b.id DESC`,
    )
    .all() as BlueprintListRow[];

  const lastRunStmt = db.sqlite.prepare(
    `SELECT id, finished_at AS finishedAt, status FROM runs
     WHERE blueprint_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
  const openFlagsStmt = db.sqlite.prepare(
    "SELECT COUNT(*) AS n FROM flags WHERE run_id = ? AND status = 'open'",
  );

  return rows.map((b) => {
    const run = lastRunStmt.get(b.id) as
      | { id: string; finishedAt: string | null; status: string }
      | undefined;
    const lastRun = run
      ? {
          id: run.id,
          finishedAt: run.finishedAt,
          status: run.status,
          openFlags: (openFlagsStmt.get(run.id) as { n: number }).n,
        }
      : null;
    return { ...b, lastRun };
  });
}

interface FlagDbRow {
  id: string;
  runId: string;
  code: string;
  sectionKey: string;
  question: string;
  options: string;
  status: string;
  resolution: string | null;
  createdAt: string;
}

/**
 * Everything the Live Run UI needs for a run in one read: the run row, the full
 * ordered event log, the run's flags, the pinned revision's section metadata and
 * masthead, source labels, and the parent blueprint. Shared by GET /api/runs/:id
 * and the server-rendered run page so the query lives in exactly one place.
 * Returns null when the run (or its blueprint) is missing so callers can 404.
 */
export function getRunPayload(db: RunoffDb, id: string): GetRunResponse | null {
  const run = db.sqlite
    .prepare(
      `SELECT id, blueprint_id AS blueprintId, blueprint_rev AS blueprintRev,
              trigger_kind AS triggerKind, status, started_at AS startedAt,
              finished_at AS finishedAt, stats, document, created_at AS createdAt
       FROM runs WHERE id = ?`,
    )
    .get(id) as RunRow | undefined;
  if (!run) return null;

  const previous = previousCompletedDocument(db.sqlite, run.blueprintId, {
    runId: run.id,
    createdAt: run.createdAt,
  });

  const blueprint = db.sqlite
    .prepare("SELECT id, name, client_name AS clientName FROM blueprints WHERE id = ?")
    .get(run.blueprintId) as { id: string; name: string; clientName: string } | undefined;
  if (!blueprint) return null;

  const events = (
    db.sqlite.prepare("SELECT payload FROM run_events WHERE run_id = ? ORDER BY seq").all(id) as {
      payload: string;
    }[]
  ).map((r) => JSON.parse(r.payload) as RunEvent);

  const flags: FlagRow[] = (
    db.sqlite
      .prepare(
        `SELECT id, run_id AS runId, code, section_key AS sectionKey, question,
                options, status, resolution, created_at AS createdAt
         FROM flags WHERE run_id = ? ORDER BY code, id`,
      )
      .all(id) as FlagDbRow[]
  ).map((f) => ({
    ...f,
    options: JSON.parse(f.options) as string[],
    resolution: f.resolution ? (JSON.parse(f.resolution) as { option: string; note?: string }) : null,
  }));

  // Section metadata + masthead come from the revision the run is pinned to, not
  // the blueprint's current revision — the run drafted against that snapshot.
  const revRow = db.sqlite
    .prepare("SELECT content FROM blueprint_revisions WHERE blueprint_id = ? AND rev = ?")
    .get(run.blueprintId, run.blueprintRev) as { content: string } | undefined;
  const content = revRow
    ? (JSON.parse(revRow.content) as {
        title: string;
        eyebrow: string;
        dateline: string;
        sections: { key: string; number: number; heading: string }[];
        delivery?: { recipient: string; autoDeliverOnClear: boolean };
      })
    : null;
  const sectionMeta = content
    ? content.sections
        .map((s) => ({ key: s.key, number: s.number, heading: s.heading }))
        .sort((a, b) => a.number - b.number)
    : [];
  const masthead = content
    ? {
        title: content.title,
        eyebrow: content.eyebrow,
        dateline: content.dateline,
        delivery: content.delivery ?? { recipient: "", autoDeliverOnClear: false },
      }
    : {
        title: "",
        eyebrow: "",
        dateline: "",
        delivery: { recipient: "", autoDeliverOnClear: false },
      };

  const sourceRows = db.sqlite
    .prepare(
      `SELECT s.id, s.name FROM blueprint_sources bs
       JOIN sources s ON s.id = bs.source_id
       WHERE bs.blueprint_id = ?`,
    )
    .all(run.blueprintId) as { id: string; name: string }[];
  const sourceLabels: Record<string, string> = Object.fromEntries(
    sourceRows.map((s) => [s.id, s.name]),
  );

  return { run, events, flags, sectionMeta, sourceLabels, blueprint, content: masthead, previous };
}

/**
 * Every source with a count of blueprints referencing it (`usedBy`), newest
 * upload first. Shared by the GET /api/sources route and the server-rendered
 * Sources page so the join lives in exactly one place.
 */
export function listSourcesWithUsage(db: RunoffDb): SourceRow[] {
  return db.sqlite
    .prepare(
      `SELECT s.id, s.name, s.kind, s.stored_filename AS storedFilename, s.mime, s.size,
              s.uploaded_at AS uploadedAt, s.refreshed_at AS refreshedAt,
              (SELECT COUNT(*) FROM blueprint_sources bs WHERE bs.source_id = s.id) AS usedBy
       FROM sources s
       ORDER BY s.uploaded_at DESC, s.id DESC`,
    )
    .all() as SourceRow[];
}

/**
 * Server-side data access for one copilot turn. Caps: 30 active memories,
 * 500-char bodies. `goldenCache` is pre-resolved by the route (exemplar parsing
 * is async; the engine context is synchronous).
 */
export function buildCopilotContext(
  db: RunoffDb,
  blueprintId: string,
  goldenCache: Map<string, { description: string; text: string }>,
): CopilotContext {
  const filesDir = process.env.RUNOFF_FILES_DIR ?? "data/files";
  const bound = db.sqlite
    .prepare(
      "SELECT s.id, s.name, s.mime, s.stored_filename AS storedFilename FROM blueprint_sources bs JOIN sources s ON s.id = bs.source_id WHERE bs.blueprint_id = ?",
    )
    .all(blueprintId) as { id: string; name: string; mime: string; storedFilename: string }[];
  const files: EngineFile[] = bound.map((s) => ({ id: s.id, name: s.name, mime: s.mime, path: join(filesDir, s.storedFilename) }));

  return {
    files,
    listRuns(): RunSummary[] {
      const rows = db.sqlite
        .prepare(
          `SELECT r.id, r.created_at AS createdAt, r.status, r.stats, r.blueprint_rev AS rev,
                  (SELECT COUNT(*) FROM flags f WHERE f.run_id = r.id) AS flagCount
           FROM runs r WHERE r.blueprint_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 10`,
        )
        .all(blueprintId) as { id: string; createdAt: string; status: string; stats: string | null; rev: number; flagCount: number }[];
      return rows.map((r) => ({ ...r, stats: r.stats ? JSON.parse(r.stats) : null }));
    },
    getRunSection(runId: string, key: string): RunSectionDetail | null {
      const run = db.sqlite
        .prepare("SELECT blueprint_id AS blueprintId, document FROM runs WHERE id = ?")
        .get(runId) as { blueprintId: string; document: string | null } | undefined;
      if (!run || run.blueprintId !== blueprintId || !run.document) return null;
      const doc = JSON.parse(run.document) as RunDocument;
      const section = doc.sections.find((s) => s.key === key);
      if (!section) return null;

      const detail: RunSectionDetail = {
        text: blocksToPlainText(section.blocks),
        checkFailures: [],
        retryReasons: [],
        steers: [],
        answers: [],
        flags: [],
      };
      const events = db.sqlite
        .prepare(
          "SELECT type, payload FROM run_events WHERE run_id = ? AND type IN ('check_failed','retry_started','steer_received','question_answered') ORDER BY seq",
        )
        .all(runId) as { type: string; payload: string }[];
      for (const e of events) {
        const p = JSON.parse(e.payload);
        if (p.sectionKey && p.sectionKey !== key) continue;
        if (e.type === "check_failed") detail.checkFailures.push(String(p.detail ?? ""));
        if (e.type === "retry_started") detail.retryReasons.push(String(p.reason ?? ""));
        if (e.type === "steer_received") detail.steers.push(String(p.text ?? ""));
        if (e.type === "question_answered")
          detail.answers.push({ question: String(p.question ?? ""), answer: String(p.answer ?? "") });
      }
      const flags = db.sqlite
        .prepare("SELECT question, status, resolution FROM flags WHERE run_id = ? AND section_key = ?")
        .all(runId, key) as { question: string; status: string; resolution: string | null }[];
      detail.flags = flags;
      return detail;
    },
    listGoldens: () => listGoldenSummaries(db, blueprintId),
    getGolden: (id) => goldenCache.get(id) ?? null,
    saveMemory(body: string): string {
      const id = newId("mem");
      const { n } = db.sqlite
        .prepare("SELECT COUNT(*) AS n FROM memories WHERE blueprint_id = ? AND status = 'active'")
        .get(blueprintId) as { n: number };
      if (n >= 30) {
        db.sqlite
          .prepare(
            "UPDATE memories SET status = 'disabled' WHERE id = (SELECT id FROM memories WHERE blueprint_id = ? AND status = 'active' ORDER BY rowid LIMIT 1)",
          )
          .run(blueprintId);
      }
      db.sqlite
        .prepare("INSERT INTO memories (id, blueprint_id, body, source, origin_id) VALUES (?, ?, ?, 'copilot', NULL)")
        .run(id, blueprintId, body.slice(0, 500));
      return id;
    },
  };
}
