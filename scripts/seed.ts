/**
 * Seed the Runoff database with the demo "Monthly Performance Report" blueprint
 * for Meridian Retail: three real fixture sources (June spend CSV, GA4 export
 * CSV, brand-guidelines PDF) copied into the files directory, plus a five-section
 * blueprint whose assert rules reference the real fixture columns.
 *
 * Idempotent: if a blueprint named "Monthly Performance Report" already exists,
 * the seed is a no-op and simply reports the existing id.
 *
 * Run:  pnpm seed
 */
import { readFileSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { openDb, newId, type RunoffDb, type BlueprintContent } from "@runoff/core";

const BLUEPRINT_NAME = "Monthly Performance Report";
const CLIENT_NAME = "Meridian Retail";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

function dbPath(): string {
  return process.env.RUNOFF_DB ?? "data/runoff.db";
}

function filesDir(): string {
  return process.env.RUNOFF_FILES_DIR ?? "data/files";
}

interface FixtureSpec {
  fixture: string; // filename under scripts/fixtures
  name: string; // display name
  mime: string;
}

const FIXTURE_SPECS: FixtureSpec[] = [
  { fixture: "spend_june.csv", name: "June Marketing Spend", mime: "text/csv" },
  { fixture: "ga4_export.csv", name: "GA4 Channel Export", mime: "text/csv" },
  { fixture: "brand_guidelines.pdf", name: "Brand Guidelines", mime: "application/pdf" },
];

interface SeedResult {
  blueprintId: string;
  created: boolean;
}

/**
 * Insert the demo sources + blueprint if absent. Returns the blueprint id and
 * whether it was freshly created. Safe to call repeatedly (idempotent by name).
 */
export function seedDatabase(db: RunoffDb): SeedResult {
  const existing = db.sqlite
    .prepare("SELECT id FROM blueprints WHERE name = ?")
    .get(BLUEPRINT_NAME) as { id: string } | undefined;
  if (existing) return { blueprintId: existing.id, created: false };

  // --- 1. Copy fixtures into the files dir and record source rows. ---------
  const dir = filesDir();
  mkdirSync(dir, { recursive: true });

  const sourceIds: Record<string, string> = {};
  const sourceRows: { id: string; name: string; storedFilename: string; mime: string; size: number }[] = [];
  for (const spec of FIXTURE_SPECS) {
    const id = newId("src");
    const storedFilename = `${id}_${spec.fixture}`;
    const srcPath = join(FIXTURES, spec.fixture);
    copyFileSync(srcPath, join(dir, storedFilename));
    const size = statSync(srcPath).size;
    sourceIds[spec.fixture] = id;
    sourceRows.push({ id, name: spec.name, storedFilename, mime: spec.mime, size });
  }

  const spendId = sourceIds["spend_june.csv"];
  const ga4Id = sourceIds["ga4_export.csv"];
  const brandId = sourceIds["brand_guidelines.pdf"];

  // Assert expressions reference the real fixture columns via the exact source
  // ids just minted (grammar: agg(sourceId.column) <op> <number>).
  const ga4Rows = countCsvRows(join(FIXTURES, "ga4_export.csv"));

  // --- 2. Build the blueprint content. -------------------------------------
  const content: BlueprintContent = {
    title: BLUEPRINT_NAME,
    clientName: CLIENT_NAME,
    eyebrow: "Marketing Performance",
    dateline: "June 2026",
    sections: [
      {
        key: "kpi-summary",
        number: 1,
        heading: "KPI Summary",
        mode: "auto",
        instruction:
          "Open with the month's headline numbers: total marketing spend and total GA4 sessions and conversions. " +
          "State each figure directly and cite its source. No preamble.",
        sourceIds: [spendId, ga4Id],
        rules: [
          {
            kind: "assert",
            text: "Total June spend stays within the monthly cap",
            expression: `sum(${spendId}.amount) <= 250000`,
          },
          {
            kind: "assert",
            text: "Every GA4 channel row is accounted for",
            expression: `count(${ga4Id}.channel) == ${ga4Rows}`,
          },
        ],
      },
      {
        key: "exec-summary",
        number: 2,
        heading: "Executive Summary",
        mode: "review",
        instruction:
          "In two short paragraphs, summarize how the month performed against the plan. " +
          "Follow the brand voice in the Brand Guidelines: plain, confident, no hedging. " +
          "Ground any figures in the spend and GA4 sources.",
        sourceIds: [spendId, ga4Id, brandId],
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
        sourceIds: [spendId, ga4Id],
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
        sourceIds: [spendId],
        rules: [
          {
            kind: "assert",
            text: "No single spend line exceeds the per-item ceiling",
            expression: `max(${spendId}.amount) <= 50000`,
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
          "Figures are drawn from the June 2026 marketing spend ledger and the GA4 channel export. " +
          "Spend is reported gross of agency fees. Sessions and conversions reflect last-click attribution. " +
          "All figures are cited to their source of record.",
        sourceIds: [],
        rules: [],
      },
    ],
    globalRules: [
      "Cite every figure you take from a source.",
      "Plain, confident tone — no hedging.",
    ],
    delivery: { recipient: "reports@meridianretail.com", autoDeliverOnClear: true },
  };

  // --- 3. Persist sources, blueprint, revision 1, and bindings atomically. -
  const blueprintId = newId("bp");
  const tx = db.sqlite.transaction(() => {
    const insSource = db.sqlite.prepare(
      "INSERT INTO sources (id, name, kind, stored_filename, mime, size) VALUES (?, ?, 'file', ?, ?, ?)",
    );
    for (const r of sourceRows) insSource.run(r.id, r.name, r.storedFilename, r.mime, r.size);

    db.sqlite
      .prepare(
        "INSERT INTO blueprints (id, name, client_name, cadence_label, status, current_rev) VALUES (?, ?, ?, 'Monthly', 'active', 1)",
      )
      .run(blueprintId, BLUEPRINT_NAME, CLIENT_NAME);
    db.sqlite
      .prepare("INSERT INTO blueprint_revisions (id, blueprint_id, rev, content) VALUES (?, ?, 1, ?)")
      .run(newId("rev"), blueprintId, JSON.stringify(content));

    const bind = db.sqlite.prepare(
      "INSERT OR IGNORE INTO blueprint_sources (blueprint_id, source_id) VALUES (?, ?)",
    );
    for (const r of sourceRows) bind.run(blueprintId, r.id);
  });
  tx();

  return { blueprintId, created: true };
}

/** Count data rows (excluding the header) in a simple CSV fixture. */
function countCsvRows(path: string): number {
  const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
  return Math.max(0, lines.length - 1);
}

async function main(): Promise<void> {
  const db = openDb(dbPath());
  try {
    const { blueprintId, created } = seedDatabase(db);
    if (created) {
      console.log(`Seeded "${BLUEPRINT_NAME}" — blueprint id: ${blueprintId}`);
    } else {
      console.log(`"${BLUEPRINT_NAME}" already present — blueprint id: ${blueprintId} (no-op)`);
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
