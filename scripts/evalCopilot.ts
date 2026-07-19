/**
 * Live smoke for the builder copilot: one real conversation turn against the
 * local CLIProxyAPI. Asks for a section-instruction tightening and asserts the
 * turn produced at least one applied edit op and a coherent reply.
 * Exit codes match scripts/eval.ts: 0 ok, 1 failed, 2 proxy unreachable, 3 auth.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import OpenAI from "openai";
import { openDb, BlueprintContentSchema, formatSqlResult, readWarehouseTables, runWarehouseSql, type RunoffDb } from "@runoff/core";
import {
  makeLlmClient,
  copilotTurn,
  MODEL,
  type CatalogFamily,
  type CopilotContext,
  type EngineFile,
  type FamilyInfo,
} from "@runoff/engine";
import { seedDatabase } from "./seed.js";

const BLUEPRINT_NAME = "Quarterly Performance Report";

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
async function loadBlueprint(db: RunoffDb): Promise<{ blueprintId: string; rev: number; content: ReturnType<typeof BlueprintContentSchema.parse> }> {
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

  return { blueprintId: row.id, rev: row.rev, content };
}

/**
 * Build the Task-10 CopilotContext for the seeded blueprint, mirroring
 * `buildCopilotContext` in apps/web/lib/queries.ts: families (with bound /
 * filedPeriods / hasLiveFile), defaultFiles (bound families → live file, id =
 * family id), and periodFiles (every filed periodic row of bound families). Run
 * history / goldens are stubbed empty — the eval only exercises source access,
 * edits, and saveMemory.
 */
export function buildEvalContext(db: RunoffDb, blueprintId: string): CopilotContext {
  const dir = filesDir();
  const projectId =
    (db.sqlite.prepare("SELECT project_id AS projectId FROM blueprints WHERE id = ?").get(blueprintId) as
      | { projectId: string }
      | undefined)?.projectId ?? "";
  const boundSet = new Set(
    (db.sqlite
      .prepare("SELECT family_id AS familyId FROM blueprint_families WHERE blueprint_id = ?")
      .all(blueprintId) as { familyId: string }[]).map((r) => r.familyId),
  );
  const famRows = db.sqlite
    .prepare("SELECT id, key, label, kind, granularity FROM source_families WHERE project_id = ? ORDER BY key")
    .all(projectId) as {
    id: string;
    key: string;
    label: string;
    kind: "periodic" | "constant";
    granularity: FamilyInfo["granularity"];
  }[];
  const periodsStmt = db.sqlite.prepare(
    "SELECT period FROM sources WHERE family_id = ? AND status='filed' AND period IS NOT NULL ORDER BY period",
  );
  const liveStmt = db.sqlite.prepare(
    "SELECT 1 FROM sources WHERE family_id = ? AND status='filed' AND period IS NULL LIMIT 1",
  );
  const families: FamilyInfo[] = famRows.map((f) => ({
    id: f.id,
    key: f.key,
    label: f.label,
    kind: f.kind,
    granularity: f.granularity,
    filedPeriods:
      f.kind === "constant" ? [] : (periodsStmt.all(f.id) as { period: string }[]).map((r) => r.period),
    hasLiveFile: f.kind === "constant" ? !!liveStmt.get(f.id) : false,
    bound: boundSet.has(f.id),
  }));

  const constantSlot = db.sqlite.prepare(
    "SELECT mime, stored_filename AS storedFilename FROM sources WHERE family_id = ? AND status='filed' AND period IS NULL",
  );
  const latestSlot = db.sqlite.prepare(
    "SELECT mime, stored_filename AS storedFilename FROM sources WHERE family_id = ? AND status='filed' AND period IS NOT NULL ORDER BY period DESC LIMIT 1",
  );
  const defaultFiles: EngineFile[] = [];
  for (const f of families) {
    if (!f.bound) continue;
    const r = (f.kind === "constant" ? constantSlot : latestSlot).get(f.id) as
      | { mime: string; storedFilename: string }
      | undefined;
    if (!r) continue;
    defaultFiles.push({ id: f.id, name: f.label, mime: r.mime, path: join(dir, r.storedFilename) });
  }

  const periodRowsStmt = db.sqlite.prepare(
    "SELECT period, mime, stored_filename AS storedFilename FROM sources WHERE family_id = ? AND status='filed' AND period IS NOT NULL ORDER BY period",
  );
  const periodFiles: CopilotContext["periodFiles"] = [];
  for (const f of families) {
    if (!f.bound || f.kind !== "periodic") continue;
    for (const r of periodRowsStmt.all(f.id) as { period: string; mime: string; storedFilename: string }[]) {
      periodFiles.push({
        familyId: f.id,
        period: r.period,
        file: { id: f.id, name: f.label, mime: r.mime, path: join(dir, r.storedFilename) },
      });
    }
  }

  const catalog: CatalogFamily[] = families.map((f) => {
    const tables = readWarehouseTables(projectId, f.key);
    return {
      id: f.id,
      key: f.key,
      label: f.label,
      kind: f.kind,
      granularity: f.granularity,
      queryable: tables.length > 0,
      tables,
      filedPeriods: f.filedPeriods,
    };
  });

  return {
    families,
    defaultFiles,
    periodFiles,
    catalog,
    runSql: (sql: string) => formatSqlResult(runWarehouseSql(projectId, sql)),
    listRuns: () => [],
    getRunSection: () => null,
    listGoldens: () => [],
    getGolden: () => null,
    saveMemory: () => "mem_eval",
  };
}

async function main(): Promise<void> {
  const client = makeLlmClient();
  await preflight(client);
  const db = openDb(dbPath());
  try {
    const { blueprintId, content } = await loadBlueprint(db);
    let editOps = 0;
    const ctx: CopilotContext = buildEvalContext(db, blueprintId);
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

// Only run the live copilot eval when this module is the direct entrypoint.
// scripts/evalSql.ts imports buildEvalContext from here; the guard keeps that
// import side-effect-free (no unintended second live run, no coupled exit code).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`\nCOPILOT EVAL FAILED — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
