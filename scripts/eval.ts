/**
 * Live smoke eval for Runoff. Runs the seeded "Quarterly Performance Report"
 * blueprint end to end through the real engine against the local CLIProxyAPI
 * (OpenAI-compatible, serving GPT 5.6 Sol) and asserts the run produced a
 * usable document.
 *
 * Preflight (opt-in credentials): the eval builds its client with
 * `makeLlmClient()` and probes the proxy. If the proxy is unreachable it exits
 * 2; if it rejects the key it exits 3 — both print a clear SKIPPED line so this
 * is safe to run in any environment.
 *
 * On a live run it asserts: every non-fixed section produced >= 1 block; the
 * document carries citations; at least one check ran. Prints an `EVAL OK` line
 * and exits 0, or `EVAL FAILED` and exits 1.
 *
 * Run:  pnpm eval
 */
import { join } from "node:path";
import OpenAI from "openai";
import { openDb, BlueprintContentSchema, type RunoffDb, type RunEvent } from "@runoff/core";
import {
  makeLlmClient,
  executeRun,
  MODEL,
  type EngineIO,
  type EngineFile,
} from "@runoff/engine";
import { seedDatabase } from "./seed.js";
import { buildRunData } from "../apps/worker/src/runData.js";

const BLUEPRINT_NAME = "Quarterly Performance Report";
const RUN_PERIOD = "2026-Q2";

function dbPath(): string {
  return process.env.RUNOFF_DB ?? "data/runoff.db";
}

function filesDir(): string {
  return process.env.RUNOFF_FILES_DIR ?? "data/files";
}

function baseURL(): string {
  return process.env.OPENAI_BASE_URL ?? "http://localhost:8317/v1";
}

/**
 * Probe the proxy before spending a full run. Resolves on success; otherwise
 * prints a SKIPPED line and exits with a distinct code (2 unreachable, 3 auth).
 */
async function preflight(client: OpenAI): Promise<void> {
  try {
    await client.models.list();
  } catch (err) {
    if (
      err instanceof OpenAI.APIConnectionError ||
      (err as { code?: string })?.code === "ECONNREFUSED"
    ) {
      console.error(`EVAL SKIPPED — CLIProxyAPI unreachable at ${baseURL()}`);
      process.exit(2);
    }
    const status = (err as { status?: number })?.status;
    if (err instanceof OpenAI.AuthenticationError || status === 401 || status === 403) {
      console.error("EVAL SKIPPED — proxy requires a valid OPENAI_API_KEY (set it and re-run pnpm eval)");
      process.exit(3);
    }
    // Any other failure (e.g. proxy up but /models unimplemented): re-probe with
    // a tiny chat completion, which exercises the exact path the run uses.
    try {
      await client.chat.completions.create({
        model: MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      });
    } catch (err2) {
      if (
        err2 instanceof OpenAI.APIConnectionError ||
        (err2 as { code?: string })?.code === "ECONNREFUSED"
      ) {
        console.error(`EVAL SKIPPED — CLIProxyAPI unreachable at ${baseURL()}`);
        process.exit(2);
      }
      const s2 = (err2 as { status?: number })?.status;
      if (err2 instanceof OpenAI.AuthenticationError || s2 === 401 || s2 === 403) {
        console.error("EVAL SKIPPED — proxy requires a valid OPENAI_API_KEY (set it and re-run pnpm eval)");
        process.exit(3);
      }
      console.error(`EVAL SKIPPED — proxy probe failed: ${err2 instanceof Error ? err2.message : String(err2)}`);
      process.exit(2);
    }
  }
}

/** Load the seeded blueprint (seeding first if absent). */
async function loadBlueprint(db: RunoffDb): Promise<{ blueprintId: string; rev: number; files: EngineFile[]; gaps: string[]; content: ReturnType<typeof BlueprintContentSchema.parse> }> {
  let row = db.sqlite
    .prepare("SELECT id, current_rev AS rev FROM blueprints WHERE name = ?")
    .get(BLUEPRINT_NAME) as { id: string; rev: number } | undefined;
  if (!row) {
    console.log(`No "${BLUEPRINT_NAME}" found — seeding first…`);
    const { blueprintId } = await seedDatabase(db);
    row = db.sqlite.prepare("SELECT id, current_rev AS rev FROM blueprints WHERE id = ?").get(blueprintId) as {
      id: string;
      rev: number;
    };
  }

  const revRow = db.sqlite
    .prepare("SELECT content FROM blueprint_revisions WHERE blueprint_id = ? AND rev = ?")
    .get(row.id, row.rev) as { content: string } | undefined;
  if (!revRow) throw new Error(`blueprint revision not found: ${row.id}@${row.rev}`);
  const content = BlueprintContentSchema.parse(JSON.parse(revRow.content));

  // Resolve the blueprint's bound families to concrete files for RUN_PERIOD,
  // mirroring the worker's resolveRunSources: constants take their NULL slot,
  // periodics the file filed for this period. EngineFile.id is the FAMILY id.
  const fams = db.sqlite
    .prepare(
      `SELECT f.id, f.key, f.label, f.kind FROM blueprint_families bf
       JOIN source_families f ON f.id = bf.family_id WHERE bf.blueprint_id = ? ORDER BY f.key`,
    )
    .all(row.id) as { id: string; key: string; label: string; kind: string }[];
  const slot = db.sqlite.prepare(
    "SELECT mime, stored_filename AS storedFilename FROM sources WHERE family_id = ? AND status='filed' AND period IS ?",
  );
  const dir = filesDir();
  const files: EngineFile[] = [];
  const gaps: string[] = [];
  for (const f of fams) {
    const s = slot.get(f.id, f.kind === "constant" ? null : RUN_PERIOD) as
      | { mime: string; storedFilename: string }
      | undefined;
    if (!s) {
      gaps.push(f.key);
      continue;
    }
    files.push({ id: f.id, name: f.label, mime: s.mime, path: join(dir, s.storedFilename) });
  }

  return { blueprintId: row.id, rev: row.rev, files, gaps, content };
}

/** A console EngineIO: logs every event compactly, streams deltas as dots. */
function consoleIO(): EngineIO {
  let streaming = false;
  const endStream = () => {
    if (streaming) {
      process.stdout.write("\n");
      streaming = false;
    }
  };
  return {
    emit(e: RunEvent): void {
      switch (e.type) {
        case "run_started":
          console.log(`\n[run_started] rev ${e.blueprintRev} · sections: ${e.sectionKeys.join(", ")}`);
          break;
        case "source_read":
          console.log(`[source_read] ${e.label} — ${e.summary}`);
          break;
        case "section_started":
          endStream();
          process.stdout.write(`[section ${e.sectionKey}] `);
          streaming = true;
          break;
        case "text_delta":
          process.stdout.write(".");
          break;
        case "section_completed":
          endStream();
          console.log(
            `[section_completed] ${e.sectionKey} — ${e.blocks.length} blocks, ${e.words} words, ${e.ms}ms, ${e.retries} retries`,
          );
          break;
        case "section_failed":
          endStream();
          console.log(`[section_failed] ${e.sectionKey} — ${e.error}`);
          break;
        case "check_passed":
          endStream();
          console.log(`  [check_passed] ${e.sectionKey}: ${e.rule}`);
          break;
        case "check_failed":
          endStream();
          console.log(`  [check_failed] ${e.sectionKey}: ${e.rule} — ${e.detail}`);
          break;
        case "retry_started":
          endStream();
          console.log(`  [retry] ${e.sectionKey}: ${e.reason}`);
          break;
        case "question_raised":
          endStream();
          console.log(`  [question] ${e.sectionKey}: ${e.question}`);
          break;
        case "question_answered":
          console.log(`  [answered] ${e.questionId}: ${e.answer}`);
          break;
        case "question_fallback_applied":
          console.log(`  [fallback] ${e.questionId}`);
          break;
        case "flag_raised":
          endStream();
          console.log(`  [flag ${e.code}] ${e.sectionKey}: ${e.question}`);
          break;
        case "steer_received":
          console.log(`  [steer] ${e.text}`);
          break;
        case "paused":
          console.log("[paused]");
          break;
        case "resumed":
          console.log("[resumed]");
          break;
        case "render_started":
          endStream();
          console.log("[render_started]");
          break;
        case "run_completed":
          console.log(`[run_completed] ${(e.stats.durationMs / 1000).toFixed(1)}s`);
          break;
        case "run_failed":
          endStream();
          console.log(`[run_failed] ${e.error}`);
          break;
        case "log":
          console.log(`[log:${e.level}] ${e.message}`);
          break;
      }
    },
    pollInputs(): [] {
      return [];
    },
    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}

async function main(): Promise<void> {
  const client = makeLlmClient();
  await preflight(client);
  console.log(`Proxy reachable at ${baseURL()} (model ${MODEL}).`);

  const db = openDb(dbPath());
  try {
    const { blueprintId, content, files, gaps, rev } = await loadBlueprint(db);
    console.log(`Running "${content.title}" for ${content.clientName} — ${files.length} sources, period ${RUN_PERIOD}, rev ${rev}.`);

    const projectId = (db.sqlite
      .prepare("SELECT project_id AS projectId FROM blueprints WHERE id = ?")
      .get(blueprintId) as { projectId: string }).projectId;
    const boundFamilyIds = [...new Set(content.sections.flatMap((s) => s.familyIds))];
    const data = buildRunData(db, projectId, boundFamilyIds, RUN_PERIOD);

    // Wrap the console IO to capture the run_started event so we can assert on
    // its serialized payload (period present, gaps absent).
    const baseIo = consoleIO();
    let runStartedJson: string | null = null;
    let checkPassedCount = 0;
    const io: EngineIO = {
      ...baseIo,
      emit(e: RunEvent): void {
        if (e.type === "run_started") runStartedJson = JSON.stringify(e);
        if (e.type === "check_passed") checkPassedCount++;
        baseIo.emit(e);
      },
    };

    const { document, stats } = await executeRun({
      client,
      content,
      files,
      data,
      io,
      blueprintRev: rev,
      period: RUN_PERIOD,
      gaps,
    });

    // --- assertions --------------------------------------------------------
    const failures: string[] = [];
    if (runStartedJson === null) {
      failures.push("no run_started event was emitted");
    } else {
      if (!runStartedJson.includes(`"period":"${RUN_PERIOD}"`)) {
        failures.push(`run_started payload missing "period":"${RUN_PERIOD}" — got ${runStartedJson}`);
      }
      if (runStartedJson.includes(`"gaps"`)) {
        failures.push(`run_started payload should not contain "gaps" (seed fills every slot) — got ${runStartedJson}`);
      }
    }
    for (const section of content.sections) {
      if (section.mode === "fixed") continue;
      const doc = document.sections.find((s) => s.key === section.key);
      if (!doc || doc.blocks.length < 1) {
        failures.push(`non-fixed section '${section.key}' produced no blocks`);
      }
    }
    if (stats.citationCount <= 0) failures.push(`citationCount is ${stats.citationCount} (expected > 0)`);
    if (stats.checksPassed + stats.checksFailed <= 0) failures.push("no checks ran (checksPassed + checksFailed == 0)");

    if (failures.length > 0) {
      console.error(`\nEVAL FAILED — ${failures.join("; ")}`);
      process.exit(1);
    }

    if (checkPassedCount === 0) {
      console.error("EVAL FAIL: no check_passed events (SQL checks never ran)");
      process.exit(1);
    }

    const sections = document.sections.length;
    const checks = stats.checksPassed + stats.checksFailed;
    const seconds = (stats.durationMs / 1000).toFixed(1);
    console.log(
      `\nEVAL OK — ${sections} sections, ${stats.citationCount} citations, ${checks} checks (${stats.checksPassed} pass), ${stats.flagCount} flags, ${seconds}s`,
    );
  } finally {
    db.sqlite.close();
  }
}

main().catch((err) => {
  console.error(`\nEVAL FAILED — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
