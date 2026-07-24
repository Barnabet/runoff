/**
 * Dump prompt-payload parity fixtures: run each LLM engine stage (draft,
 * classify, propose, distill) through a RECORDING fake client that captures the
 * exact `chat.completions.create(params)` object, and write the deep-key-sorted
 * JSON of those captured params to backend/tests/fixtures/prompts/<stage>.json.
 *
 * backend/tests/test_prompt_fixtures.py recreates the identical canned inputs
 * (transcribed byte-for-byte) in Python, runs the Python ports through their own
 * recording fake client, and asserts the request bodies are byte-identical —
 * proving the Tasks 6-8 ports build the same prompts as the TS originals.
 *
 * Canned inputs are HARD-CODED below and must be copied verbatim into the Python
 * test. Deterministic: re-running produces byte-identical fixtures (no DB, no
 * clock, no env beyond RUNOFF_MODEL which both sides default to "gpt-5.6-sol").
 *
 * Run: pnpm backend:prompt-fixtures
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  BlueprintContent,
  BlueprintSection,
  DocSection,
  ExecReport,
  ParsePlan,
} from "@runoff/core";
import { draftSection, classifySource, proposeParsePlan, distillRun } from "@runoff/engine";
import type { ScopedMemory } from "@runoff/engine";
import { makeFakeClient, type FakeTurn } from "../packages/engine/test/fakeClient.js";

const FIX_DIR = "backend/tests/fixtures/prompts";

let skipped = 0;

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

/** A payload is "empty" if it carries no fixture data (mirrors dump-parity-fixtures.ts). */
function isEmptyPayload(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

function writeFixture(name: string, value: unknown): void {
  const path = join(FIX_DIR, name);
  if (isEmptyPayload(value)) {
    const existing = existsSync(path) ? readFileSync(path, "utf8").trim() : "";
    if (existing.length > 0) {
      console.warn(`SKIP ${name}: resolved payload is null/empty — keeping the existing non-empty fixture`);
    } else {
      console.warn(`SKIP ${name}: resolved payload is null/empty and no good fixture exists to keep`);
    }
    skipped++;
    return;
  }
  writeFileSync(path, JSON.stringify(sortKeys(value), null, 2) + "\n");
  console.log(`wrote ${name}`);
}

/** A fake client that records every create(params) verbatim, returning a scripted response. */
function recording(script: FakeTurn[][]): { client: any; params: any[] } {
  const base = makeFakeClient(script);
  const inner = base.chat.completions.create;
  const params: any[] = [];
  base.chat.completions.create = async (p: any) => {
    params.push(p);
    return inner(p);
  };
  return { client: base, params };
}

const NOOP_CB = { onDelta() {}, onFlag() {}, onQuestion() {} };

// ===========================================================================
// CANNED INPUTS — hard-coded; transcribe byte-for-byte into the Python test.
// ===========================================================================

const CONTENT: BlueprintContent = {
  title: "Quarterly Performance Review",
  clientName: "Northwind Trading Co.",
  eyebrow: "Confidential",
  dateline: "Q2 2026",
  delivery: { recipient: "cfo@northwind.example", autoDeliverOnClear: false },
  globalRules: ["Round all currency to whole dollars.", "Write in the past tense."],
  sections: [
    {
      key: "exec",
      number: 1,
      heading: "Executive Summary",
      mode: "auto",
      instruction: "Summarize the quarter's headline results in three sentences.",
      familyIds: ["fam_marketing_spend"],
      queries: [],
      rules: [],
    },
    {
      key: "revenue",
      number: 2,
      heading: "Revenue Analysis",
      mode: "auto",
      instruction: "Analyze revenue by channel and call out the largest mover.",
      familyIds: ["fam_marketing_spend"],
      queries: [],
      rules: [
        { kind: "style", text: "Lead with the total before the breakdown." },
        {
          kind: "assert",
          text: "Total spend equals the sum of channel spend.",
          sql: "SELECT sum(amount)\n  FROM fam_marketing_spend\n  WHERE _period = :period",
        },
      ],
    },
  ],
};

const MEMORIES: ScopedMemory[] = [
  { id: "mem_p1", body: "Northwind's fiscal year starts in April.", scope: "project" },
  { id: "mem_b1", body: "Always express spend deltas in percentages.", scope: "blueprint" },
];

const COMPLETED: DocSection[] = [
  {
    key: "exec",
    heading: "Executive Summary",
    blocks: [
      {
        type: "paragraph",
        spans: [{ text: "Revenue rose across every paid channel this quarter." }],
      },
    ],
  },
];

const DRAFT_SECTION: BlueprintSection = CONTENT.sections[1];
const DATA_BLOCK =
  "fam_marketing_spend (periodic, quarter 2026-Q2)\n" +
  "schema: date TEXT, channel TEXT, amount REAL\n" +
  "sum(amount)=190900 across 12 rows";
const STEERS = ["Lead with the revenue headline."];
const ANSWERS = [{ question: "Which channels count as paid?", answer: "Search and social only." }];
const RETRY_FEEDBACK = "assert failed: total spend 190900 did not match the sum of the cited channel figures.";
const PREVIOUS_SECTION_TEXT = "Last quarter total spend was 175000, led by paid search.";

// classify
const CLASSIFY_FAMILIES = [
  { key: "marketing_spend", label: "Marketing spend", kind: "periodic" as const, granularity: "quarter" as const },
  { key: "ga4_analytics", label: "GA4 analytics", kind: "periodic" as const, granularity: "quarter" as const },
  { key: "brand_guidelines", label: "Brand guidelines", kind: "constant" as const, granularity: null },
];
const CLASSIFY_FILENAME = "ga4_export_q3.csv";
const CLASSIFY_SAMPLE =
  "channel,sessions,conversions\npaid_search,48200,1240\npaid_social,31500,720\ndisplay,22800,410\n";

// propose
const PROPOSE_FILENAME = "spend_june.csv";
const PROPOSE_GRID_SAMPLE =
  "## sheet: spend_june (13×3)\n" +
  "R1: date | channel | amount\n" +
  "R2: 2026-06-02 | search | 42000\n" +
  "R3: 2026-06-05 | social | 28500\n\n" +
  "## detector hints\nsingle table; header row 1";
const EXISTING_PLAN: ParsePlan = {
  version: 1,
  tables: [
    {
      name: "spend",
      anchor: { headerSignature: ["date", "channel", "amount"], minMatch: 2 },
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
};
const FIT_DETAIL = ["unknown column: notes"];
const EXEC_REPORT: ExecReport = {
  tables: [
    {
      name: "spend",
      anchor: { sheet: "spend_june", row: 0 },
      problems: [],
      rowsKept: 11,
      rowsExcluded: [],
      coercionFailures: [{ column: "amount", count: 1, samples: ["n/a"] }],
      periodMismatches: { count: 0, samples: [] },
      unknownColumns: ["notes"],
    },
  ],
};
const PROPOSE_FEEDBACK = "Treat the notes column as free text; keep it out of the numeric tables.";

// distill
const DISTILL_TITLE = "Quarterly Performance Review";
const DISTILL_HEADINGS = ["Executive Summary", "Revenue Analysis"];
const DISTILL_INTERACTIONS = {
  steers: ["Lead with the revenue headline."],
  answers: [{ question: "Which channels count as paid?", answer: "Search and social only." }],
  flagResolutions: [{ question: "Include the disputed invoice?", resolution: "Exclude disputed invoices from totals." }],
};
const DISTILL_EXISTING = [{ body: "Northwind's fiscal year starts in April.", scope: "project" }];

// A minimal valid ParsePlan the propose fake returns so the stage accepts it on
// the first attempt (one create() call per invocation).
const VALID_PLAN_JSON =
  '{"version":1,"tables":[{"name":"t","anchor":{"headerSignature":["a"],"minMatch":1},' +
  '"headerRows":1,"exclude":[],"columns":[{"from":"a","name":"a","type":"TEXT"}]}]}';

async function main(): Promise<void> {
  mkdirSync(FIX_DIR, { recursive: true });

  // --- draft.json: first draft + retry variant ---
  const draftParams: any[] = [];
  {
    const rec = recording([[{ text: "Drafted section body.", stopReason: "end_turn" }]]);
    await draftSection({
      client: rec.client,
      content: CONTENT,
      section: DRAFT_SECTION,
      dataBlock: DATA_BLOCK,
      completed: COMPLETED,
      steers: STEERS,
      answers: ANSWERS,
      memories: MEMORIES,
      cb: NOOP_CB,
    });
    draftParams.push(...rec.params);
  }
  {
    const rec = recording([[{ text: "Redrafted section body.", stopReason: "end_turn" }]]);
    await draftSection({
      client: rec.client,
      content: CONTENT,
      section: DRAFT_SECTION,
      dataBlock: DATA_BLOCK,
      completed: COMPLETED,
      steers: STEERS,
      answers: ANSWERS,
      retryFeedback: RETRY_FEEDBACK,
      previousSectionText: PREVIOUS_SECTION_TEXT,
      memories: MEMORIES,
      cb: NOOP_CB,
    });
    draftParams.push(...rec.params);
  }
  writeFixture("draft.json", draftParams);

  // --- classify.json ---
  {
    const rec = recording([[{ text: '{"familyKey":"ga4_analytics","period":"2026-Q3","confidence":"high"}' }]]);
    await classifySource({
      client: rec.client,
      filename: CLASSIFY_FILENAME,
      contentSample: CLASSIFY_SAMPLE,
      families: CLASSIFY_FAMILIES,
    });
    writeFixture("classify.json", rec.params);
  }

  // --- propose.json: initial + replan variant ---
  const proposeParams: any[] = [];
  {
    const rec = recording([[{ text: VALID_PLAN_JSON }]]);
    await proposeParsePlan({
      client: rec.client,
      filename: PROPOSE_FILENAME,
      gridSample: PROPOSE_GRID_SAMPLE,
    });
    proposeParams.push(...rec.params);
  }
  {
    const rec = recording([[{ text: VALID_PLAN_JSON }]]);
    await proposeParsePlan({
      client: rec.client,
      filename: PROPOSE_FILENAME,
      gridSample: PROPOSE_GRID_SAMPLE,
      existingPlan: EXISTING_PLAN,
      fitDetail: FIT_DETAIL,
      execReport: EXEC_REPORT,
      feedback: PROPOSE_FEEDBACK,
    });
    proposeParams.push(...rec.params);
  }
  writeFixture("propose.json", proposeParams);

  // --- distill.json ---
  {
    const rec = recording([[{ text: '{"memories":[]}' }]]);
    await distillRun({
      client: rec.client,
      title: DISTILL_TITLE,
      sectionHeadings: DISTILL_HEADINGS,
      interactions: DISTILL_INTERACTIONS,
      existing: DISTILL_EXISTING,
    });
    writeFixture("distill.json", rec.params);
  }
}

main().then(() => {
  if (skipped > 0) {
    console.error(`${skipped} fixture(s) skipped`);
    process.exit(1);
  }
});
