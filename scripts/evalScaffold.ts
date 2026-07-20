/**
 * Live smoke for golden→section scaffolding: one real conversation turn against
 * the local CLIProxyAPI. Renders the seeded bound AR-review exemplar's scaffold
 * digest deterministically, hands it to the copilot via get_golden_scaffold, and
 * asserts the model called the tool, produced at least one add_section op, and
 * lifted a section query byte-equal from the golden's verified bindings.
 * Exit codes match scripts/eval.ts: 0 ok, 1 failed, 2 proxy unreachable, 3 auth.
 */
import { join } from "node:path";
import OpenAI from "openai";
import {
  openDb,
  BlueprintContentSchema,
  RunDocumentSchema,
  BindingInventorySchema,
  buildWarehouseCatalog,
  formatSqlResult,
  runWarehouseSql,
  type RunoffDb,
} from "@runoff/core";
import {
  makeLlmClient,
  copilotTurn,
  MODEL,
  buildScaffoldDigest,
  renderScaffoldDigest,
  type CopilotContext,
  type CopilotTurnResult,
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
function fail(detail: string): never {
  console.error(`EVAL SCAFFOLD FAIL: ${detail}`);
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
      console.error("EVAL SKIPPED — proxy requires a valid OPENAI_API_KEY (set it and re-run pnpm eval:scaffold)");
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
        console.error("EVAL SKIPPED — proxy requires a valid OPENAI_API_KEY (set it and re-run pnpm eval:scaffold)");
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
 * Build the CopilotContext for the seeded blueprint, mirroring buildCopilotContext
 * in apps/web/lib/queries.ts: bound families → live/latest defaultFiles, every
 * filed periodic row → periodFiles, warehouse catalog via buildWarehouseCatalog.
 * runSql binds :period to the latest filed period so add_section's dry-run
 * validation of the golden's :period-parameterized lifted SQL succeeds. Golden
 * access is wired to serve exactly the one seeded exemplar's rendered digest.
 */
function buildScaffoldContext(
  db: RunoffDb,
  blueprintId: string,
  golden: { id: string; name: string | null; digest: string },
): CopilotContext {
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

  // Latest filed period across the project: add_section dry-runs the lifted
  // :period-parameterized SQL through runSql, which fails without a bound value.
  const latestPeriod = (db.sqlite
    .prepare("SELECT MAX(period) AS p FROM sources WHERE project_id = ? AND status='filed' AND period IS NOT NULL")
    .get(projectId) as { p: string | null }).p;

  return {
    families,
    defaultFiles,
    periodFiles,
    catalog: buildWarehouseCatalog(db, projectId),
    runSql: (sql: string) => formatSqlResult(runWarehouseSql(projectId, sql, { period: latestPeriod })),
    listRuns: () => [],
    getRunSection: () => null,
    listGoldens: () => [{ id: golden.id, kind: "exemplar", label: golden.name ?? golden.id, note: null }],
    getGolden: () => null,
    scaffoldDigest: (id) => (id === golden.id ? golden.digest : `golden not found: ${id}`),
    saveMemory: () => "mem_eval",
  };
}

async function main(): Promise<void> {
  const client = makeLlmClient();
  await preflight(client);
  const db = openDb(dbPath());
  try {
    const { blueprintId, content } = await loadBlueprint(db);

    // Read the seeded bound exemplar directly and render its digest deterministically.
    const g = db.sqlite
      .prepare(
        "SELECT id, name, period, document, bindings FROM goldens WHERE kind = 'exemplar' AND bindings IS NOT NULL LIMIT 1",
      )
      .get() as { id: string; name: string | null; period: string | null; document: string; bindings: string } | undefined;
    if (!g) fail("no bound exemplar golden in seed");
    const document = RunDocumentSchema.parse(JSON.parse(g.document));
    const inventory = BindingInventorySchema.parse(JSON.parse(g.bindings));
    const digest = renderScaffoldDigest(
      buildScaffoldDigest({ id: g.id, label: g.name ?? g.id, period: g.period, document, inventory }),
    );
    const boundSqls = inventory.items
      .filter((i) => i.binding?.status === "bound")
      .map((i) => i.binding!.sql);
    if (!boundSqls.length) fail("seeded exemplar has no bound queries to lift");

    const ctx = buildScaffoldContext(db, blueprintId, { id: g.id, name: g.name, digest });

    const runTurn = (): Promise<CopilotTurnResult> =>
      copilotTurn({
        client,
        draft: content,
        selectedKey: null,
        message: "Add a new receivables-review section to the report, scaffolded from the golden example.",
        thread: [],
        memories: [],
        ctx,
        io: {
          emit(e) {
            if (e.type === "tool_activity") console.log(`[tool] ${e.label}`);
            if (e.type === "edit") console.log(`[edit] ${e.op.type}`);
            if (e.type === "text_delta") process.stdout.write(".");
          },
        },
      });

    let res = await runTurn();
    // One retry on a zero-op turn (model nondeterminism), mirroring eval:golden.
    if (!res.actions.some((a) => a.kind === "edit")) {
      console.log("retrying: first turn produced no ops");
      res = await runTurn();
    }
    process.stdout.write("\n");

    const usedTool = res.actions.some((a) => a.kind === "tool" && a.tool === "get_golden_scaffold");
    const addOps = res.actions.filter((a) => a.kind === "edit" && a.op.type === "add_section");
    const liftedQuery = res.draft.sections.some((s) =>
      (s.queries ?? []).some((q) => boundSqls.includes(q.sql)),
    );
    if (!usedTool) fail("model never called get_golden_scaffold");
    if (!addOps.length) fail("no add_section op produced");
    if (!liftedQuery) fail("no section query lifted byte-equal from the golden's bindings");
    console.log(`EVAL SCAFFOLD OK — ${addOps.length} section(s) scaffolded, ${res.actions.length} action(s)`);
  } finally {
    db.sqlite.close();
  }
}

main().catch((err) => {
  console.error(`\nEVAL SCAFFOLD FAIL — ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
