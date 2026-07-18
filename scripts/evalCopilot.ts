/**
 * Live smoke for the builder copilot: one real conversation turn against the
 * local CLIProxyAPI. Asks for a section-instruction tightening and asserts the
 * turn produced at least one applied edit op and a coherent reply.
 * Exit codes match scripts/eval.ts: 0 ok, 1 failed, 2 proxy unreachable, 3 auth.
 */
import { join } from "node:path";
import OpenAI from "openai";
import { openDb, BlueprintContentSchema, type RunoffDb } from "@runoff/core";
import {
  makeLlmClient,
  copilotTurn,
  MODEL,
  type CopilotContext,
  type EngineFile,
} from "@runoff/engine";
import { seedDatabase } from "./seed.js";

const BLUEPRINT_NAME = "Monthly Performance Report";

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
function loadBlueprint(db: RunoffDb): { blueprintId: string; rev: number; files: EngineFile[]; content: ReturnType<typeof BlueprintContentSchema.parse> } {
  let row = db.sqlite
    .prepare("SELECT id, current_rev AS rev FROM blueprints WHERE name = ?")
    .get(BLUEPRINT_NAME) as { id: string; rev: number } | undefined;
  if (!row) {
    console.log(`No "${BLUEPRINT_NAME}" found — seeding first…`);
    const { blueprintId } = seedDatabase(db);
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

  const bound = db.sqlite
    .prepare(
      "SELECT s.id, s.name, s.mime, s.stored_filename AS storedFilename FROM blueprint_sources bs JOIN sources s ON s.id = bs.source_id WHERE bs.blueprint_id = ?",
    )
    .all(row.id) as { id: string; name: string; mime: string; storedFilename: string }[];
  const dir = filesDir();
  const files: EngineFile[] = bound.map((s) => ({
    id: s.id,
    name: s.name,
    mime: s.mime,
    path: join(dir, s.storedFilename),
  }));

  return { blueprintId: row.id, rev: row.rev, files, content };
}

async function main(): Promise<void> {
  const client = makeLlmClient();
  await preflight(client);
  const db = openDb(dbPath());
  try {
    const { content, files } = loadBlueprint(db);
    const events: string[] = [];
    let editOps = 0;
    const ctx: CopilotContext = {
      files,
      listRuns: () => [],
      getRunSection: () => null,
      listGoldens: () => [],
      getGolden: () => null,
      saveMemory: () => "mem_eval",
    };
    const res = await copilotTurn({
      client,
      draft: content,
      selectedKey: content.sections[0]?.key ?? null,
      message:
        "Tighten the first auto section's instruction: demand exactly three sentences and require the headline spend figure to be cited. Apply the edit.",
      thread: [],
      memories: [],
      ctx,
      io: {
        emit(e) {
          if (e.type === "tool_activity") console.log(`[tool] ${e.label}`);
          if (e.type === "edit") { editOps++; console.log(`[edit] ${e.op.type}`); }
          if (e.type === "text_delta") process.stdout.write(".");
        },
      },
    });
    process.stdout.write("\n");
    const failures: string[] = [];
    if (editOps < 1) failures.push("no edit op was applied");
    if (res.reply.trim().length < 10) failures.push(`reply too short: "${res.reply}"`);
    if (failures.length) {
      console.error(`\nCOPILOT EVAL FAILED — ${failures.join("; ")}`);
      process.exit(1);
    }
    console.log(`\nCOPILOT EVAL OK — ${editOps} edit op(s), ${res.actions.length} action(s), reply ${res.reply.length} chars`);
  } finally {
    db.sqlite.close();
  }
}

main().catch((err) => {
  console.error(`\nCOPILOT EVAL FAILED — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
