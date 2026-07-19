/**
 * Live smoke for the copilot's run_sql tool: one real conversation turn against
 * the local CLIProxyAPI. Asks a data question that can only be answered by
 * querying the warehouse, and asserts at least one run_sql call succeeded and a
 * non-empty final reply came back.
 * Exit codes match scripts/eval.ts: 0 ok, 1 failed, 2 proxy unreachable, 3 auth.
 */
import OpenAI from "openai";
import { openDb, BlueprintContentSchema, runWarehouseSql, type RunoffDb } from "@runoff/core";
import { makeLlmClient, copilotTurn, MODEL } from "@runoff/engine";
import { buildEvalContext } from "./evalCopilot.js";
import { seedDatabase } from "./seed.js";

const BLUEPRINT_NAME = "Quarterly Performance Report";

function dbPath(): string {
  return process.env.RUNOFF_DB ?? "data/runoff.db";
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
      console.error("EVAL SKIPPED — proxy requires a valid OPENAI_API_KEY (set it and re-run pnpm eval:sql)");
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
        console.error("EVAL SKIPPED — proxy requires a valid OPENAI_API_KEY (set it and re-run pnpm eval:sql)");
        process.exit(3);
      }
      console.error(`EVAL SKIPPED — proxy probe failed: ${err2 instanceof Error ? err2.message : String(err2)}`);
      process.exit(2);
    }
  }
}

/** Load the seeded blueprint (seeding first if absent). */
async function loadBlueprint(
  db: RunoffDb,
): Promise<{ blueprintId: string; content: ReturnType<typeof BlueprintContentSchema.parse> }> {
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
  return { blueprintId: row.id, content };
}

async function main(): Promise<void> {
  const client = makeLlmClient();
  await preflight(client);
  const db = openDb(dbPath());
  try {
    const { blueprintId, content: draft } = await loadBlueprint(db);
    const projectId = (db.sqlite
      .prepare("SELECT project_id AS projectId FROM blueprints WHERE id = ?")
      .get(blueprintId) as { projectId: string }).projectId;
    const ctx = buildEvalContext(db, blueprintId);
    let sqlCalls = 0;
    const rawRunSql = ctx.runSql.bind(ctx);
    ctx.runSql = (sql: string): string => {
      const out = rawRunSql(sql); // throws on failure — a throw here fails the eval below only if no call ever succeeds
      sqlCalls++;
      console.log(`  run_sql ok: ${sql.slice(0, 100)}`);
      return out;
    };

    const result = await copilotTurn({
      client,
      draft,
      selectedKey: null,
      message:
        "Using run_sql, what is the total invoice amount in ar_transactions for period 2026-Q2? Reply with the number.",
      thread: [],
      memories: [],
      ctx,
      io: { emit: () => {} },
    });

    if (sqlCalls < 1) {
      console.error("EVAL SQL FAIL: no successful run_sql call");
      process.exit(1);
    }
    if (!result.reply.trim()) {
      console.error("EVAL SQL FAIL: empty final reply");
      process.exit(1);
    }
    const expectedRes = runWarehouseSql(projectId, "SELECT SUM(amount) FROM fam_ar_transactions WHERE _period = '2026-Q2'");
    const expected = Math.trunc(expectedRes.rows[0][0] as number).toString();
    if (!result.reply.replace(/[^0-9]/g, "").includes(expected)) {
      console.error(`EVAL SQL FAIL: reply does not contain expected sum ${expected}`);
      process.exit(1);
    }
    console.log(`EVAL SQL OK — ${sqlCalls} successful run_sql call(s); reply: ${result.reply.slice(0, 200)}`);
  } finally {
    db.sqlite.close();
  }
}

main().catch((err) => {
  console.error(`\nEVAL SQL FAIL — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
