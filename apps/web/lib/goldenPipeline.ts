import { join } from "node:path";
import {
  BindingInventorySchema,
  formatSqlResult,
  runWarehouseSql,
  type RunoffDb,
  type SqlResult,
} from "@runoff/core";
import {
  bindGolden,
  extractFileText,
  inventoryFromCitations,
  isUnsupportedExemplarMime,
  unifyGoldenReport,
  verifyInventory,
} from "@runoff/engine";
import { catalog } from "./catalog";
import { getGoldenRow, resolveGolden } from "./goldens";
import { getLlmClient } from "./llm";

// Blueprint → project resolution used by every entry point:
const projectOf = (db: RunoffDb, blueprintId: string): string =>
  (db.sqlite.prepare("SELECT project_id AS p FROM blueprints WHERE id = ?").get(blueprintId) as { p: string }).p;

// Golden-scoped executors: :period binds to the GOLDEN's period.
const execFor =
  (projectId: string, period: string | null) =>
  (sql: string): SqlResult =>
    runWarehouseSql(projectId, sql, { period });
const runSqlFor =
  (projectId: string, period: string | null) =>
  (sql: string): string =>
    formatSqlResult(runWarehouseSql(projectId, sql, { period }));

// The blueprint's current revision section queries, as (sectionKey) => queries[].
function queriesForBlueprint(db: RunoffDb, blueprintId: string): (sectionKey: string) => { name: string; sql: string }[] {
  const row = db.sqlite
    .prepare(
      "SELECT content FROM blueprint_revisions WHERE blueprint_id = ? AND rev = (SELECT current_rev FROM blueprints WHERE id = ?)",
    )
    .get(blueprintId, blueprintId) as { content: string } | undefined;
  const byKey = new Map<string, { name: string; sql: string }[]>();
  if (row?.content) {
    const content = JSON.parse(row.content) as {
      sections?: { key: string; queries?: { name: string; sql: string }[] }[];
    };
    for (const s of content.sections ?? []) byKey.set(s.key, s.queries ?? []);
  }
  return (sectionKey: string) => byKey.get(sectionKey) ?? [];
}

// Sibling context: bound inventories of the blueprint's OTHER goldens, newest 3.
const siblingsFor = (db: RunoffDb, blueprintId: string, excludeGoldenId: string) =>
  (
    db.sqlite
      .prepare(
        "SELECT id, period, bindings FROM goldens WHERE blueprint_id = ? AND id != ? AND bindings IS NOT NULL ORDER BY rowid DESC LIMIT 3",
      )
      .all(blueprintId, excludeGoldenId) as { period: string | null; bindings: string }[]
  ).map((r) => ({ period: r.period, inventory: BindingInventorySchema.parse(JSON.parse(r.bindings)) }));

export async function bindExemplar(args: {
  db: RunoffDb;
  goldenId: string;
  feedback?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const g = resolveGolden(args.db, args.goldenId);
    if (!g || !g.document) return { ok: false, error: "golden is not unified" };
    const row = args.db.sqlite.prepare("SELECT blueprint_id AS b FROM goldens WHERE id = ?").get(args.goldenId) as {
      b: string;
    };
    const projectId = projectOf(args.db, row.b);
    const submitted = await bindGolden({
      client: getLlmClient(),
      catalog: catalog(args.db, projectId),
      runSql: runSqlFor(projectId, g.period),
      document: g.document,
      period: g.period,
      siblings: siblingsFor(args.db, row.b, args.goldenId),
      priorInventory: g.inventory ?? undefined,
      feedback: args.feedback,
    });
    if (!submitted) return { ok: false, error: "bind failed: no inventory produced" };
    const verified = verifyInventory(submitted, execFor(projectId, g.period), g.period, g.document);
    args.db.sqlite.prepare("UPDATE goldens SET bindings = ? WHERE id = ?").run(JSON.stringify(verified), args.goldenId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `bind failed: ${String((e as Error).message ?? e)}` };
  }
}

export async function unifyAndBindExemplar(args: { db: RunoffDb; goldenId: string }): Promise<void> {
  const g = getGoldenRow(args.db, args.goldenId)!;
  if (isUnsupportedExemplarMime(g.mime ?? "")) {
    args.db.sqlite
      .prepare("UPDATE goldens SET unify_error = ? WHERE id = ?")
      .run(`unsupported exemplar type for unify: ${g.mime}`, args.goldenId);
    return;
  }
  try {
    const text = await extractFileText({
      id: g.id,
      name: g.name ?? "exemplar",
      mime: g.mime ?? "text/plain",
      path: join(process.env.RUNOFF_FILES_DIR ?? "data/files", g.storedFilename!),
    });
    const unified = await unifyGoldenReport({ client: getLlmClient(), filename: g.name ?? "exemplar", text });
    if (!unified) {
      args.db.sqlite
        .prepare("UPDATE goldens SET unify_error = ? WHERE id = ?")
        .run("unify failed: no document produced", args.goldenId);
      return;
    }
    args.db.sqlite
      .prepare("UPDATE goldens SET document = ?, period = ?, unify_error = NULL WHERE id = ?")
      .run(JSON.stringify(unified.document), unified.period, args.goldenId);
    await bindExemplar({ db: args.db, goldenId: args.goldenId }); // auto-chain; its failure leaves bindings null
  } catch (e) {
    args.db.sqlite
      .prepare("UPDATE goldens SET unify_error = ? WHERE id = ?")
      .run(`unify failed: ${String((e as Error).message ?? e)}`, args.goldenId);
  }
}

export function rebuildRunGoldenInventory(args: { db: RunoffDb; goldenId: string }): void {
  const g = resolveGolden(args.db, args.goldenId);
  if (!g?.document) return;
  const row = args.db.sqlite.prepare("SELECT blueprint_id AS b FROM goldens WHERE id = ?").get(args.goldenId) as {
    b: string;
  };
  const projectId = projectOf(args.db, row.b);
  const submitted = inventoryFromCitations(g.document, catalog(args.db, projectId), queriesForBlueprint(args.db, row.b));
  const verified = verifyInventory(submitted, execFor(projectId, g.period), g.period, g.document);
  args.db.sqlite.prepare("UPDATE goldens SET bindings = ? WHERE id = ?").run(JSON.stringify(verified), args.goldenId);
}

export function verifyStoredInventory(args: { db: RunoffDb; goldenId: string }): void {
  const g = resolveGolden(args.db, args.goldenId);
  if (!g?.inventory || !g.document) return;
  const row = args.db.sqlite.prepare("SELECT blueprint_id AS b FROM goldens WHERE id = ?").get(args.goldenId) as {
    b: string;
  };
  const verified = verifyInventory(g.inventory, execFor(projectOf(args.db, row.b), g.period), g.period, g.document);
  args.db.sqlite.prepare("UPDATE goldens SET bindings = ? WHERE id = ?").run(JSON.stringify(verified), args.goldenId);
}
