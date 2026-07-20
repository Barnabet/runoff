/**
 * Live smoke for the golden unify + bind pipeline: take the seeded AR-review
 * exemplar (baked from the warehouse), unify its stored markdown LIVE, bind the
 * LIVE-unified document against the seeded warehouse, verify, and assert the AR
 * total was found and bound to the warehouse's own SUM. Name-agnostic: it does
 * not pin the model's item ids or SQL, only that some bound numeric value equals
 * the warehouse total within tolerance and overall boundness clears 50%.
 * Exit codes match scripts/eval.ts: 0 ok, 1 failed, 2 proxy unreachable, 3 auth.
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";
import OpenAI from "openai";
import {
  openDb, runWarehouseSql, formatSqlResult, buildWarehouseCatalog,
  type SqlResult,
} from "@runoff/core";
import {
  bindGolden, makeLlmClient, unifyGoldenReport, verifyInventory, MODEL,
} from "@runoff/engine";

const PERIOD = "2026-Q1";

function dbPath(): string {
  return process.env.RUNOFF_DB ?? "data/runoff.db";
}
function filesDir(): string {
  return process.env.RUNOFF_FILES_DIR ?? "data/files";
}
function baseURL(): string {
  return process.env.OPENAI_BASE_URL ?? "http://localhost:8317/v1";
}
function fail(detail: string): never {
  console.error(`EVAL GOLDEN FAIL: ${detail}`);
  process.exit(1);
}

/**
 * Probe the proxy before spending a full run. Resolves on success; otherwise
 * prints a SKIPPED line and exits with a distinct code (2 unreachable, 3 auth).
 */
async function preflight(client: OpenAI): Promise<void> {
  try {
    await client.models.list();
  } catch (err) {
    if (err instanceof OpenAI.APIConnectionError || (err as { code?: string })?.code === "ECONNREFUSED") {
      console.error(`EVAL SKIPPED — CLIProxyAPI unreachable at ${baseURL()}`);
      process.exit(2);
    }
    const status = (err as { status?: number })?.status;
    if (err instanceof OpenAI.AuthenticationError || status === 401 || status === 403) {
      console.error("EVAL SKIPPED — proxy requires a valid OPENAI_API_KEY (set it and re-run pnpm eval:golden)");
      process.exit(3);
    }
    try {
      await client.chat.completions.create({ model: MODEL, max_tokens: 1, messages: [{ role: "user", content: "ping" }] });
    } catch (err2) {
      if (err2 instanceof OpenAI.APIConnectionError || (err2 as { code?: string })?.code === "ECONNREFUSED") {
        console.error(`EVAL SKIPPED — CLIProxyAPI unreachable at ${baseURL()}`);
        process.exit(2);
      }
      const s2 = (err2 as { status?: number })?.status;
      if (err2 instanceof OpenAI.AuthenticationError || s2 === 401 || s2 === 403) {
        console.error("EVAL SKIPPED — proxy requires a valid OPENAI_API_KEY (set it and re-run pnpm eval:golden)");
        process.exit(3);
      }
      console.error(`EVAL SKIPPED — proxy probe failed: ${err2 instanceof Error ? err2.message : String(err2)}`);
      process.exit(2);
    }
  }
}

async function main(): Promise<void> {
  const client = makeLlmClient();
  await preflight(client);
  const db = openDb(dbPath());
  try {
    // 1. Find the seeded exemplar golden and read its stored markdown.
    const g = db.sqlite
      .prepare("SELECT id, blueprint_id AS blueprintId, name, stored_filename AS storedFilename FROM goldens WHERE kind='exemplar' AND name LIKE 'AR Review%' ORDER BY rowid DESC LIMIT 1")
      .get() as { id: string; blueprintId: string; name: string; storedFilename: string } | undefined;
    if (!g) fail("no seeded exemplar golden found (run pnpm seed first)");
    const projectId = (db.sqlite
      .prepare("SELECT project_id AS projectId FROM blueprints WHERE id = ?")
      .get(g.blueprintId) as { projectId: string }).projectId;
    const text = readFileSync(join(filesDir(), g.storedFilename), "utf8");

    // 2. UNIFY LIVE.
    const unified = await unifyGoldenReport({ client, filename: g.storedFilename, text });
    if (!unified) fail("unify returned null");
    if (unified.document.sections.length < 2) fail(`expected >= 2 sections, got ${unified.document.sections.length}`);
    if (unified.period !== PERIOD) fail(`expected period ${PERIOD}, got ${String(unified.period)}`);

    // 3. BIND LIVE against the seeded warehouse (cold start: no siblings).
    const catalog = buildWarehouseCatalog(db, projectId);
    const runSql = (sql: string): string => formatSqlResult(runWarehouseSql(projectId, sql, { period: PERIOD }));
    const exec = (sql: string): SqlResult => runWarehouseSql(projectId, sql, { period: PERIOD });
    let submitted = await bindGolden({
      client, catalog, runSql, document: unified.document, period: PERIOD, siblings: [],
    });
    if (!submitted) {
      // Self-check mirror: one retry before failing.
      submitted = await bindGolden({
        client, catalog, runSql, document: unified.document, period: PERIOD, siblings: [],
      });
    }
    if (!submitted) fail("bind returned null inventory (after one retry)");

    // 4. VERIFY.
    const verified = verifyInventory(submitted, exec, PERIOD, unified.document);

    // 5. Assertions (name-agnostic).
    const expected = runWarehouseSql(projectId, "SELECT SUM(amount) FROM fam_ar_transactions WHERE _period = :period", { period: PERIOD }).rows[0][0] as number;
    const tol = Math.max(0.005, 0.01 * Math.abs(expected));
    const totalHit = verified.items.some((i) =>
      i.binding?.status === "bound" &&
      typeof i.binding.verifiedValue === "number" &&
      Math.abs((i.binding.verifiedValue as number) - expected) <= tol);
    if (!totalHit) {
      const bounds = verified.items.filter((i) => i.binding?.status === "bound").map((i) => String(i.binding?.verifiedValue));
      fail(`no bound numeric item within tolerance of AR total ${expected} (bound values: ${bounds.join(", ") || "none"})`);
    }
    const total = verified.items.length;
    const bound = verified.items.filter((i) => i.binding?.status === "bound").length;
    if (total === 0 || bound / total < 0.5) fail(`boundness ${bound}/${total} below 0.5`);

    console.log("EVAL GOLDEN OK");
    console.log(`  unified ${unified.document.sections.length} sections · bound ${bound}/${total} items · AR total ${expected} verified within ±${tol.toFixed(2)}`);
  } finally {
    db.sqlite.close();
  }
}

main().catch((err) => {
  console.error(`\nEVAL GOLDEN FAIL — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
