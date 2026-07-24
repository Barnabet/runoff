/**
 * Dump ingest-diff parity fixtures: for each of the four scripts/fixtures/ data
 * files, run the REAL TS ingest path — loadGrids → executeParsePlan → applySchema
 * + insertRows into a fresh in-memory warehouse — under a hard-coded, working
 * ParsePlan, then dump every produced warehouse table as {name, columns, rows}
 * to backend/tests/fixtures/ingest/<basename>.json.
 *
 * backend/tests/test_ingest_parity.py replays the SAME files through the SAME
 * canned plans (transcribed) via the Python engine + core.warehouse and asserts
 * the produced tables are byte-identical — proving the Tasks 3-4 + 9 ports
 * ingest identical files into identical warehouse rows.
 *
 * The plans are hand-derived from the real fixture content and cover: currency
 * and date parsing, a periodColumn, an unpivot, multi-table single-sheet and
 * multi-sheet workbooks, exclude rules, and both periodic and constant families.
 *
 * Run: pnpm backend:ingest-fixtures
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "@runoff/core";
import { applySchema, insertRows, planTableName, type ParsePlan, type WhTableSchema } from "@runoff/core";
import { loadGrids, executeParsePlan } from "@runoff/engine";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = join(HERE, "fixtures");
const OUT_DIR = "backend/tests/fixtures/ingest";

/** Recursively sort object keys; arrays keep their order (mirrors diff-api.ts). */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

interface IngestCase {
  file: string;
  familyKey: string;
  periodic: boolean;
  period: string | null;
  granularity: "quarter" | "month" | "year" | null;
  plan: ParsePlan;
}

// ===========================================================================
// CANNED PLANS — hand-derived, working; transcribe byte-for-byte into Python.
// ===========================================================================

const CASES: IngestCase[] = [
  {
    file: "spend_june.csv",
    familyKey: "marketing_spend",
    periodic: true,
    period: "2026-06",
    granularity: "month",
    plan: {
      version: 1,
      tables: [
        {
          name: "spend",
          anchor: { sheet: "spend_june", headerSignature: ["date", "channel", "amount"], minMatch: 2 },
          headerRows: 1,
          exclude: [],
          columns: [
            { from: "date", name: "date", type: "TEXT", parse: "date" },
            { from: "channel", name: "channel", type: "TEXT" },
            { from: "amount", name: "amount", type: "REAL", parse: "currency" },
          ],
          periodColumn: "date",
          onPeriodMismatch: "keep",
        },
      ],
    },
  },
  {
    file: "ga4_export.csv",
    familyKey: "ga4_analytics",
    periodic: false,
    period: null,
    granularity: null,
    plan: {
      version: 1,
      tables: [
        {
          name: "ga4",
          anchor: { sheet: "ga4_export", headerSignature: ["channel", "sessions", "conversions"], minMatch: 2 },
          headerRows: 1,
          exclude: [],
          columns: [
            { from: "channel", name: "channel", type: "TEXT" },
            { from: "sessions", name: "sessions", type: "INTEGER" },
            { from: "conversions", name: "conversions", type: "INTEGER" },
          ],
          onPeriodMismatch: "keep",
        },
      ],
    },
  },
  {
    file: "ar_aging_q2_2026.xlsx",
    familyKey: "ar_aging",
    periodic: true,
    period: "2026-Q2",
    granularity: "quarter",
    plan: {
      version: 1,
      tables: [
        {
          name: "ar_aging",
          anchor: {
            sheet: "ar_aging",
            headerSignature: ["customer", "status", "amount due ($)", "days outstanding"],
            minMatch: 3,
          },
          headerRows: 1,
          exclude: [{ column: "customer", pattern: "total" }],
          columns: [
            { from: "customer", name: "customer", type: "TEXT" },
            { from: "status", name: "status", type: "TEXT" },
            { from: "amount due ($)", name: "amount_due", type: "REAL", parse: "currency" },
            { from: "days outstanding", name: "days_outstanding", type: "INTEGER" },
          ],
          onPeriodMismatch: "keep",
        },
        {
          name: "monthly_totals",
          anchor: {
            sheet: "monthly_totals",
            headerSignature: ["region", "apr 2026", "may 2026", "jun 2026"],
            minMatch: 2,
          },
          headerRows: 1,
          exclude: [],
          columns: [{ from: "region", name: "region", type: "TEXT" }],
          unpivot: {
            keep: ["region"],
            valuePattern: "\\d{4}$",
            keyColumn: "month",
            valueColumn: "amount",
            valueType: "REAL",
            valueParse: "currency",
          },
          onPeriodMismatch: "keep",
        },
      ],
    },
  },
  {
    file: "regional_summary.xlsx",
    familyKey: "regional_summary",
    periodic: false,
    period: null,
    granularity: null,
    plan: {
      version: 1,
      tables: [
        {
          name: "regional",
          anchor: { sheet: "regional_summary", headerSignature: ["region", "revenue", "orders"], minMatch: 2 },
          headerRows: 1,
          exclude: [{ column: "region", pattern: "^note" }],
          columns: [
            { from: "region", name: "region", type: "TEXT" },
            { from: "revenue", name: "revenue", type: "INTEGER" },
            { from: "orders", name: "orders", type: "INTEGER" },
          ],
          onPeriodMismatch: "keep",
        },
        {
          name: "channels",
          anchor: { sheet: "regional_summary", headerSignature: ["channel", "share"], minMatch: 2 },
          headerRows: 1,
          exclude: [],
          columns: [
            { from: "channel", name: "channel", type: "TEXT" },
            { from: "share", name: "share", type: "REAL" },
          ],
          onPeriodMismatch: "keep",
        },
      ],
    },
  },
];

interface DumpedTable {
  name: string;
  columns: { name: string; type: string }[];
  rows: unknown[][];
}

async function ingest(c: IngestCase): Promise<{ tables: DumpedTable[] }> {
  const grids = await loadGrids(join(FIXTURE_SRC, c.file), "", c.file);
  const { tables, report } = executeParsePlan(grids, c.plan, c.periodic ? c.period : null, c.granularity);
  const firstProblem = report.tables.flatMap((t) => t.problems)[0];
  if (firstProblem) throw new Error(`${c.file}: ${firstProblem}`);
  if (report.tables.every((t) => t.rowsKept === 0)) throw new Error(`${c.file}: plan produced no rows`);

  const db = openDb(":memory:");
  db.sqlite.prepare("ATTACH DATABASE ':memory:' AS wh").run();
  const incoming: WhTableSchema[] = tables.map((t) => ({
    name: planTableName(c.familyKey, c.plan, t.logical),
    columns: t.columns,
  }));
  applySchema(db.sqlite, c.periodic, incoming);
  for (const t of tables) {
    const tname = planTableName(c.familyKey, c.plan, t.logical);
    const cols = t.columns.map((col) => col.name);
    insertRows(db.sqlite, tname, cols, t.rows, c.periodic ? c.period : null);
  }

  const q = (id: string): string => `"${id.replace(/"/g, '""')}"`;
  const dumped: DumpedTable[] = incoming.map((t) => {
    const columns = db.sqlite.prepare(`SELECT name, type FROM wh.pragma_table_info(?)`).all(t.name) as {
      name: string;
      type: string;
    }[];
    const rows = db.sqlite.prepare(`SELECT * FROM wh.${q(t.name)} ORDER BY rowid`).raw().all() as unknown[][];
    return { name: t.name, columns, rows };
  });
  db.sqlite.close();
  return { tables: dumped };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const c of CASES) {
    const payload = await ingest(c);
    const base = c.file.replace(/\.[^.]+$/, "");
    writeFileSync(join(OUT_DIR, `${base}.json`), JSON.stringify(sortKeys(payload), null, 2) + "\n");
    const rowN = payload.tables.reduce((n, t) => n + t.rows.length, 0);
    console.log(`wrote ${base}.json — ${payload.tables.length} table(s), ${rowN} row(s)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
