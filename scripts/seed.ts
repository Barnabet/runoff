/**
 * Seed the Runoff database with the demo "Quarterly Performance Report" for the
 * Meridian Retail project: a three-family source taxonomy backed by real
 * fixtures, plus a five-section blueprint bound to those families whose assert
 * rules reference the real fixture columns via FAMILY ids.
 *
 * Families (all in the Meridian Retail project):
 *  - marketing_spend  periodic/quarter, filed 2026-Q1 + 2026-Q2 (spend_june.csv)
 *  - ga4_analytics    periodic/quarter, filed 2026-Q1 + 2026-Q2 (ga4_export.csv)
 *  - brand_guidelines constant, one live file, period NULL (brand_guidelines.pdf)
 *
 * Idempotent: if a blueprint named "Quarterly Performance Report" already exists,
 * the seed is a no-op and simply reports the existing ids.
 *
 * Run:  pnpm seed
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  openDb, newId, attachWarehouse, detachWarehouse, applySchema, deleteRows, insertRows,
  whFamilyTables, type RunoffDb, type BlueprintContent, type WhTableSchema,
} from "@runoff/core";
import { isTabular, readTabular, type DetectedTable } from "@runoff/engine";

const BLUEPRINT_NAME = "Quarterly Performance Report";
const PROJECT_NAME = "Meridian Retail";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

function dbPath(): string {
  return process.env.RUNOFF_DB ?? "data/runoff.db";
}

function filesDir(): string {
  return process.env.RUNOFF_FILES_DIR ?? "data/files";
}

/** mulberry32 — deterministic tiny PRNG so every seed produces identical data. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AR_CUSTOMERS = ["Northwind", "Contoso", "Fabrikam", "Adventure Works", "Tailspin", "Wingtip", "Proseware", "Litware"];
const AR_STATUSES = ["paid", "open", "overdue"];

/** ~10k-row AR extract for one quarter; seed differs per period → different but stable data. */
function arCsv(period: string, seed: number): string {
  const rand = mulberry32(seed);
  const year = period.slice(0, 4);
  const q = Number(period.slice(6));
  const lines = ["invoice_id,customer,amount,issued_date,status"];
  for (let i = 0; i < 10_000; i++) {
    const month = String((q - 1) * 3 + 1 + Math.floor(rand() * 3)).padStart(2, "0");
    const day = String(1 + Math.floor(rand() * 28)).padStart(2, "0");
    const amount = Math.round(rand() * 9_900 + 100 + rand() * 100) / 1; // integer dollars
    const customer = AR_CUSTOMERS[Math.floor(rand() * AR_CUSTOMERS.length)];
    const status = AR_STATUSES[Math.floor(rand() * AR_STATUSES.length)];
    lines.push(`INV-${period}-${String(i + 1).padStart(5, "0")},${customer},${amount},${year}-${month}-${day},${status}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Ingest one tabular seed source into the project warehouse. Mirror of the app's
 * fileSource ingest path (single/multi naming rule included): a lone detected
 * table lands as `fam_<key>`, multiple tables as `fam_<key>__<slug>`.
 */
async function ingestSeedSource(
  db: RunoffDb, projectId: string, familyKey: string, periodic: boolean, period: string | null,
  path: string, mime: string, name: string,
): Promise<void> {
  attachWarehouse(db.sqlite, projectId);
  try {
    const tables: { table: DetectedTable; rows: unknown[][][] }[] = [];
    await readTabular(path, mime, name, (table) => {
      const entry = { table, rows: [] as unknown[][][] };
      tables.push(entry);
      return (batch) => { entry.rows.push(batch); };
    });
    const single = tables.length === 1;
    const nameOf = (slug: string): string => (single ? `fam_${familyKey}` : `fam_${familyKey}__${slug}`);
    const incoming: WhTableSchema[] = tables.map((t) => ({ name: nameOf(t.table.slug), columns: t.table.columns }));
    applySchema(db.sqlite, periodic, incoming);
    deleteRows(db.sqlite, whFamilyTables(db.sqlite, familyKey).map((t) => t.name), period);
    for (const t of tables) {
      const cols = t.table.columns.map((c) => c.name);
      for (const batch of t.rows) insertRows(db.sqlite, nameOf(t.table.slug), cols, batch, period);
    }
  } finally {
    detachWarehouse(db.sqlite);
  }
}

interface SeedResult {
  projectId: string;
  blueprintId: string;
  created: boolean;
}

/**
 * Insert the demo project, families, filed sources, and blueprint if absent.
 * Returns the project + blueprint ids and whether they were freshly created.
 * Safe to call repeatedly (idempotent by blueprint name).
 */
export async function seedDatabase(db: RunoffDb): Promise<SeedResult> {
  const existing = db.sqlite
    .prepare("SELECT id, project_id AS projectId FROM blueprints WHERE name = ?")
    .get(BLUEPRINT_NAME) as { id: string; projectId: string } | undefined;
  if (existing) return { projectId: existing.projectId, blueprintId: existing.id, created: false };

  const dir = filesDir();
  mkdirSync(dir, { recursive: true });

  // Copy a fixture under a freshly-minted source id and return the row shape the
  // INSERT below expects. Each call = one physical file on disk, so duplicating a
  // fixture across periods is fine (identical figures across quarters, demo-only).
  interface SourceRow {
    id: string;
    name: string;
    familyId: string;
    period: string | null;
    storedFilename: string;
    mime: string;
    size: number;
  }
  function copyFixture(
    fixture: string,
    name: string,
    mime: string,
    familyId: string,
    period: string | null,
  ): SourceRow {
    const id = newId("src");
    const storedFilename = `${id}_${fixture}`;
    const srcPath = join(FIXTURES, fixture);
    copyFileSync(srcPath, join(dir, storedFilename));
    const size = statSync(srcPath).size;
    return { id, name, familyId, period, storedFilename, mime, size };
  }

  // Write a generated (non-fixture) CSV under a freshly-minted source id. Used
  // for the large deterministic AR extracts, which are produced at seed time.
  function generatedSource(name: string, csv: string, familyId: string, period: string): SourceRow {
    const id = newId("src");
    const storedFilename = `${id}_${name}`;
    writeFileSync(join(dir, storedFilename), csv);
    return { id, name, familyId, period, storedFilename, mime: "text/csv", size: csv.length };
  }

  const projectId = newId("proj");
  const spendFam = newId("fam");
  const ga4Fam = newId("fam");
  const brandFam = newId("fam");
  const arFam = newId("fam");
  const regFam = newId("fam");
  const blueprintId = newId("bp");

  const families = [
    { id: spendFam, key: "marketing_spend", label: "Marketing spend", kind: "periodic", granularity: "quarter" },
    { id: ga4Fam, key: "ga4_analytics", label: "GA4 analytics", kind: "periodic", granularity: "quarter" },
    { id: brandFam, key: "brand_guidelines", label: "Brand guidelines", kind: "constant", granularity: null },
    { id: arFam, key: "ar_transactions", label: "AR transactions", kind: "periodic", granularity: "quarter" },
    { id: regFam, key: "regional_summary", label: "Regional summary", kind: "periodic", granularity: "quarter" },
  ];

  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const sourceRows: SourceRow[] = [
    copyFixture("spend_june.csv", "Marketing Spend — Q1 2026", "text/csv", spendFam, "2026-Q1"),
    copyFixture("spend_june.csv", "Marketing Spend — Q2 2026", "text/csv", spendFam, "2026-Q2"),
    copyFixture("ga4_export.csv", "GA4 Channel Export — Q1 2026", "text/csv", ga4Fam, "2026-Q1"),
    copyFixture("ga4_export.csv", "GA4 Channel Export — Q2 2026", "text/csv", ga4Fam, "2026-Q2"),
    copyFixture("brand_guidelines.pdf", "Brand Guidelines", "application/pdf", brandFam, null),
    generatedSource("ar_2026-Q1.csv", arCsv("2026-Q1", 1301), arFam, "2026-Q1"),
    generatedSource("ar_2026-Q2.csv", arCsv("2026-Q2", 1302), arFam, "2026-Q2"),
    copyFixture("regional_summary.xlsx", "Regional Summary — Q1 2026", XLSX_MIME, regFam, "2026-Q1"),
    copyFixture("regional_summary.xlsx", "Regional Summary — Q2 2026", XLSX_MIME, regFam, "2026-Q2"),
  ];

  // Assert expressions reference the real fixture columns via FAMILY ids
  // (grammar: agg(familyId.column) <op> <number>); EngineFile.id is the family id
  // at run time, so the locators stay stable across periods.
  const ga4Rows = countCsvRows(join(FIXTURES, "ga4_export.csv"));

  const content: BlueprintContent = {
    title: BLUEPRINT_NAME,
    clientName: PROJECT_NAME,
    eyebrow: "Marketing Performance",
    dateline: "Q2 2026",
    sections: [
      {
        key: "kpi-summary",
        number: 1,
        heading: "KPI Summary",
        mode: "auto",
        instruction:
          "Open with the quarter's headline numbers: total marketing spend and total GA4 sessions and conversions. " +
          "State each figure directly and cite its source. No preamble.",
        familyIds: [spendFam, ga4Fam],
        rules: [
          {
            kind: "assert",
            text: "Total quarterly spend stays within the cap",
            expression: `sum(${spendFam}.amount) <= 250000`,
          },
          {
            kind: "assert",
            text: "Every GA4 channel row is accounted for",
            expression: `count(${ga4Fam}.channel) == ${ga4Rows}`,
          },
        ],
      },
      {
        key: "exec-summary",
        number: 2,
        heading: "Executive Summary",
        mode: "review",
        instruction:
          "In two short paragraphs, summarize how the quarter performed against the plan. " +
          "Follow the brand voice in the Brand Guidelines: plain, confident, no hedging. " +
          "Ground any figures in the spend and GA4 sources.",
        familyIds: [spendFam, ga4Fam, brandFam],
        rules: [
          { kind: "style", text: "Lead with the single most important result." },
          { kind: "judgment", text: "Flag for human review before release." },
        ],
      },
      {
        key: "channel-performance",
        number: 3,
        heading: "Channel Performance",
        mode: "auto",
        instruction:
          "Break down spend by channel and pair it with GA4 sessions and conversions. " +
          "Present the comparison as a table, one row per channel, with every figure cited.",
        familyIds: [spendFam, ga4Fam],
        rules: [],
      },
      {
        key: "budget",
        number: 4,
        heading: "Budget & Efficiency",
        mode: "auto",
        instruction:
          "Report total spend and confirm no single line item exceeded the per-item ceiling. " +
          "Note the average spend per line and cite the figures.",
        familyIds: [spendFam],
        rules: [
          {
            kind: "assert",
            text: "No single spend line exceeds the per-item ceiling",
            expression: `max(${spendFam}.amount) <= 50000`,
          },
        ],
      },
      {
        key: "appendix",
        number: 5,
        heading: "Appendix & Methodology",
        mode: "fixed",
        instruction: "Fixed methodology note.",
        fixedText:
          "Figures are drawn from the quarterly marketing spend ledger and the GA4 channel export. " +
          "Spend is reported gross of agency fees. Sessions and conversions reflect last-click attribution. " +
          "All figures are cited to their source of record.",
        familyIds: [],
        rules: [],
      },
    ],
    globalRules: [
      "Cite every figure you take from a source.",
      "Plain, confident tone — no hedging.",
    ],
    delivery: { recipient: "reports@meridianretail.com", autoDeliverOnClear: true },
  };

  // Persist project, families, filed sources, blueprint, revision 1, and family
  // bindings atomically.
  const tx = db.sqlite.transaction(() => {
    db.sqlite
      .prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, datetime('now'))")
      .run(projectId, PROJECT_NAME);

    const insFamily = db.sqlite.prepare(
      "INSERT INTO source_families (id, project_id, key, label, kind, granularity, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
    );
    for (const f of families) insFamily.run(f.id, projectId, f.key, f.label, f.kind, f.granularity);

    const insSource = db.sqlite.prepare(
      "INSERT INTO sources (id, project_id, family_id, period, name, kind, stored_filename, mime, size, status, uploaded_at, filed_at) " +
        "VALUES (?, ?, ?, ?, ?, 'file', ?, ?, ?, 'filed', datetime('now'), datetime('now'))",
    );
    for (const r of sourceRows)
      insSource.run(r.id, projectId, r.familyId, r.period, r.name, r.storedFilename, r.mime, r.size);

    db.sqlite
      .prepare(
        "INSERT INTO blueprints (id, name, client_name, project_id, cadence_label, status, current_rev) VALUES (?, ?, ?, ?, 'Quarterly', 'active', 1)",
      )
      .run(blueprintId, BLUEPRINT_NAME, PROJECT_NAME, projectId);
    db.sqlite
      .prepare("INSERT INTO blueprint_revisions (id, blueprint_id, rev, content) VALUES (?, ?, 1, ?)")
      .run(newId("rev"), blueprintId, JSON.stringify(content));

    const bind = db.sqlite.prepare(
      "INSERT OR IGNORE INTO blueprint_families (blueprint_id, family_id) VALUES (?, ?)",
    );
    for (const f of families) bind.run(blueprintId, f.id);
  });
  tx();

  // Warehouse ingestion for every tabular filed source (CSV/XLSX). Mirrors the
  // app's ingest so the seeded project ships with a populated warehouse; the PDF
  // brand-guidelines source is skipped by the isTabular check.
  const famById = new Map(families.map((f) => [f.id, f]));
  let ingested = 0;
  for (const r of sourceRows) {
    if (!isTabular(r.mime, r.name)) continue;
    const fam = famById.get(r.familyId)!;
    await ingestSeedSource(
      db, projectId, fam.key, fam.kind === "periodic", r.period,
      join(dir, r.storedFilename), r.mime, r.name,
    );
    ingested++;
  }
  console.log(`Ingested warehouse tables for ${ingested} tabular sources`);

  return { projectId, blueprintId, created: true };
}

/** Count data rows (excluding the header) in a simple CSV fixture. */
function countCsvRows(path: string): number {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
  return Math.max(0, lines.length - 1);
}

async function main(): Promise<void> {
  const db = openDb(dbPath());
  try {
    const { projectId, blueprintId, created } = await seedDatabase(db);
    if (created) {
      console.log(`Seeded "${PROJECT_NAME}" — project id: ${projectId}`);
      console.log(`Seeded "${BLUEPRINT_NAME}" — blueprint id: ${blueprintId}`);
    } else {
      console.log(`"${BLUEPRINT_NAME}" already present — project id: ${projectId}, blueprint id: ${blueprintId} (no-op)`);
    }
  } finally {
    db.sqlite.close();
  }
}

// Run when invoked directly (pnpm seed), but not when imported by the eval.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
