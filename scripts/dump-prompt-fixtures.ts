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
import type { ScopedMemory } from "@runoff/engine";
import { makeFakeClient, type FakeTurn } from "../packages/engine/test/fakeClient.js";

// Pin the engine model BEFORE @runoff/engine is evaluated, so a dev-shell
// RUNOFF_MODEL leak can't skew the recorded request bodies. prompts.ts reads
// `process.env.RUNOFF_MODEL ?? "gpt-5.6-sol"` at import time, so the engine is
// pulled in via a dynamic import() inside main() — after this assignment runs —
// rather than a hoisted static import (see backend/tests/test_prompt_fixtures.py
// for the matching Python-side pin).
process.env.RUNOFF_MODEL = "gpt-5.6-sol";

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

// ---------------------------------------------------------------------------
// copilot: a 2-section draft (one section WITH fixedText, one WITHOUT — absent-
// key handling is load-bearing), selectedKey, a 2-message thread, memories of
// both scopes, a small catalog, and 2 families. The goldenCache/scaffoldCache
// are built from the canned resolved golden below via the REAL render functions,
// exercising the annotation + digest paths cross-stack.
// ---------------------------------------------------------------------------
const COPILOT_DRAFT: BlueprintContent = {
  title: "Monthly Marketing Report",
  clientName: "Meridian Retail",
  eyebrow: "Marketing Performance",
  dateline: "June 2026",
  delivery: { recipient: "ops@meridian.example", autoDeliverOnClear: false },
  globalRules: ["Cite every figure.", "Use GBP for all amounts."],
  sections: [
    {
      key: "summary",
      number: 1,
      heading: "Executive Summary",
      mode: "fixed",
      instruction: "Summarize the month in two sentences.",
      fixedText: "Marketing delivered steady growth in June.",
      familyIds: [],
      queries: [],
      rules: [],
    },
    {
      key: "spend",
      number: 2,
      heading: "Spend Breakdown",
      mode: "auto",
      instruction: "Break spend down by channel.",
      familyIds: ["fam_spend"],
      queries: [{ name: "total_spend", sql: "SELECT sum(amount) FROM fam_spend WHERE _period = :period" }],
      rules: [{ kind: "style", text: "Lead with the total." }],
    },
  ],
};
const COPILOT_SELECTED_KEY = "spend";
const COPILOT_MESSAGE = "Bake a query that totals spend for the month.";
const COPILOT_THREAD = [
  { role: "user" as const, body: "Can you tighten the summary?" },
  { role: "assistant" as const, body: "Sure — I made it more concise." },
];
const COPILOT_MEMORIES: ScopedMemory[] = [
  { id: "mem_pr1", body: "Meridian reports in GBP.", scope: "project" },
  { id: "mem_bp1", body: "Keep the executive summary to two sentences.", scope: "blueprint" },
];
const COPILOT_CATALOG = [
  {
    id: "fam_spend", key: "spend", label: "Ad spend", kind: "periodic" as const, granularity: "month" as const,
    queryable: true,
    tables: [{ name: "fam_spend", columns: [{ name: "channel", type: "TEXT" }, { name: "amount", type: "REAL" }], rowCounts: { "2026-05": 3, "2026-06": 4 } }],
    filedPeriods: ["2026-05", "2026-06"],
  },
  {
    id: "fam_brand", key: "brand", label: "Brand guidelines", kind: "constant" as const, granularity: null,
    queryable: false, tables: [], filedPeriods: [],
  },
];
const COPILOT_FAMILIES = [
  { id: "fam_spend", key: "spend", label: "Ad spend", kind: "periodic" as const, granularity: "month" as const, filedPeriods: ["2026-06"], hasLiveFile: false, bound: true },
  { id: "fam_brand", key: "brand", label: "Brand guidelines", kind: "constant" as const, granularity: null, filedPeriods: [], hasLiveFile: false, bound: false },
];
// A canned resolved golden with a bound value item AND a mismatch table item.
const COPILOT_RESOLVED_GOLDEN = {
  id: "gold_q2",
  kind: "run" as const,
  label: "run run_42",
  note: "Strong Q2 exemplar",
  period: "2026-Q2",
  document: {
    title: "Quarterly Revenue Report",
    eyebrow: "",
    dateline: "",
    sections: [
      {
        key: "revenue",
        heading: "Revenue",
        blocks: [
          { type: "paragraph" as const, spans: [{ text: "Revenue reached " }, { text: "$4.2M" }, { text: " this quarter." }] },
          {
            type: "table" as const,
            columns: ["channel", "amount"],
            rows: [
              { cells: [[{ text: "search" }], [{ text: "2.5M" }]] },
              { cells: [[{ text: "social" }], [{ text: "1.7M" }]] },
            ],
          },
        ],
      },
    ],
  },
  inventory: {
    version: 1 as const,
    items: [
      {
        id: "revenue_total", kind: "value" as const, anchor: { sectionKey: "revenue", blockIndex: 0, spanIndex: 1 },
        raw: "$4.2M", parsed: 4200000,
        binding: { familyId: "fam_rev", sql: "SELECT sum(amount) FROM fam_rev WHERE _period = :period", verifiedValue: 4200000, status: "bound" as const },
        reason: null,
      },
      {
        id: "revenue_table", kind: "table" as const, anchor: { sectionKey: "revenue", blockIndex: 1, spanIndex: null },
        raw: "table: channel, amount", parsed: null,
        binding: { familyId: "fam_rev", sql: "SELECT channel, amount FROM fam_rev WHERE _period = :period", verifiedValue: 3, status: "mismatch" as const },
        reason: "row count 3 ≠ 2",
      },
    ],
  },
  unifyError: null,
};
const COPILOT_IO = { emit() {} };

// ---------------------------------------------------------------------------
// bind: a canned RunDocument (a paragraph with one >160-char span and one span
// with quotes/unicode, plus a 15-row table so the >12-row cap fires), catalog,
// period, and one sibling carrying a bound item. Two variants: `initial` (no
// prior/feedback) and `rebind` (priorInventory + feedback).
// ---------------------------------------------------------------------------
const BIND_TABLE_ROWS = Array.from({ length: 15 }, (_, i) => ({
  cells: [[{ text: `channel_${i + 1}` }], [{ text: `${(i + 1) * 1000}` }]],
}));
const BIND_DOCUMENT = {
  title: "Q2 Revenue Report",
  eyebrow: "",
  dateline: "",
  sections: [
    {
      key: "overview",
      heading: "Overview",
      blocks: [
        {
          type: "paragraph" as const,
          spans: [
            { text: "Revenue climbed sharply this quarter, driven primarily by paid search and a resurgent social channel that together accounted for the overwhelming majority of net new bookings across every region we serve and every product line we track." },
            { text: "The CFO called it \"solid\" — up 12% ✓ over last year." },
          ],
        },
        { type: "table" as const, columns: ["channel", "amount"], rows: BIND_TABLE_ROWS },
      ],
    },
  ],
};
const BIND_CATALOG = [
  {
    id: "fam_rev", key: "revenue", label: "Revenue", kind: "periodic" as const, granularity: "quarter" as const,
    queryable: true,
    tables: [{ name: "fam_rev", columns: [{ name: "channel", type: "TEXT" }, { name: "amount", type: "REAL" }], rowCounts: { "2026-Q1": 10, "2026-Q2": 15 } }],
    filedPeriods: ["2026-Q1", "2026-Q2"],
  },
];
const BIND_PERIOD = "2026-Q2";
const BIND_SIBLINGS = [
  {
    period: "2026-Q1",
    inventory: {
      version: 1 as const,
      items: [
        {
          id: "rev_total", kind: "value" as const, anchor: { sectionKey: "overview", blockIndex: 0, spanIndex: 0 },
          raw: "$3.8M", parsed: 3800000,
          binding: { familyId: "fam_rev", sql: "SELECT sum(amount) FROM fam_rev WHERE _period = :period", verifiedValue: 3800000, status: "bound" as const },
          reason: null,
        },
        {
          id: "rev_growth", kind: "value" as const, anchor: { sectionKey: "overview", blockIndex: 0, spanIndex: 1 },
          raw: "12%", parsed: 0.12, binding: null, reason: "styling number",
        },
      ],
    },
  },
];
const BIND_PRIOR = {
  version: 1,
  items: [
    {
      id: "rev_total", kind: "value", anchor: { sectionKey: "overview", blockIndex: 0, spanIndex: 0 },
      raw: "$4.2M", parsed: 4200000,
      binding: { familyId: "fam_rev", sql: "SELECT sum(amount) FROM fam_rev WHERE _period = :period" }, reason: null,
    },
    {
      id: "rev_table", kind: "table", anchor: { sectionKey: "overview", blockIndex: 2, spanIndex: null },
      raw: "table: channel, amount", parsed: null, binding: null, reason: "no query covers this table",
    },
  ],
};
const BIND_FEEDBACK = "The revenue total should exclude refunds; rebind rev_total accordingly.";

// ---------------------------------------------------------------------------
// unify: a filename + a deterministic > 24 000-char text (a base paragraph
// repeated) so the head/tail cap in capExemplarText is captured.
// ---------------------------------------------------------------------------
const UNIFY_FILENAME = "q2_report.txt";
const UNIFY_PARAGRAPH =
  "Revenue grew steadily across every paid channel this quarter, and the team reported strong performance. ";
const UNIFY_TEXT = UNIFY_PARAGRAPH.repeat(300);
const UNIFY_DOC_JSON =
  '{"document":{"title":"Q2 Report","eyebrow":"","dateline":"","sections":[{"key":"overview",' +
  '"heading":"Overview","blocks":[{"type":"paragraph","spans":[{"text":"Revenue grew."}]}]}]},' +
  '"period":"2026-Q2"}';

async function main(): Promise<void> {
  // Dynamic import: evaluates @runoff/engine (and prompts.ts's MODEL) only now,
  // after the RUNOFF_MODEL pin above has taken effect.
  const { draftSection, classifySource, proposeParsePlan, distillRun, copilotTurn, bindGolden, unifyGoldenReport, renderGoldenForPrompt, boundnessLine } = await import("@runoff/engine");
  // scaffoldDigestFor lives in the web app (not the engine); dynamic-import it
  // AFTER the RUNOFF_MODEL pin, since it pulls in @runoff/engine transitively.
  const { scaffoldDigestFor } = await import("../apps/web/lib/goldens.js");

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

  // --- copilot.json: first create() of a copilotTurn (no-tool-call finish) ---
  {
    // Build the golden + scaffold caches through the REAL renderers, mirroring the
    // copilot route. Not part of the captured payload — a construction-time smoke
    // test that both stacks run the annotation + digest paths without diverging.
    const g = COPILOT_RESOLVED_GOLDEN;
    const goldenCache = new Map<string, { description: string; text: string }>();
    const scaffoldCache = new Map<string, string>();
    goldenCache.set(g.id, {
      description: `${g.label} — ${boundnessLine(g.inventory as any)}`,
      text: renderGoldenForPrompt(g as any),
    });
    scaffoldCache.set(g.id, scaffoldDigestFor(g as any));
    const ctx: any = {
      families: COPILOT_FAMILIES,
      defaultFiles: [],
      periodFiles: [],
      catalog: COPILOT_CATALOG,
      runSql: () => { throw new Error("no data ingested yet"); },
      listRuns: () => [],
      getRunSection: () => null,
      listGoldens: () => [],
      getGolden: (id: string) => goldenCache.get(id) ?? null,
      scaffoldDigest: (id: string) => scaffoldCache.get(id) ?? "golden not found",
      saveMemory: () => "mem_1",
    };
    const rec = recording([[{ text: "I baked a total-spend query for the Spend section." }]]);
    await copilotTurn({
      client: rec.client,
      draft: COPILOT_DRAFT,
      selectedKey: COPILOT_SELECTED_KEY,
      message: COPILOT_MESSAGE,
      thread: COPILOT_THREAD,
      memories: COPILOT_MEMORIES,
      ctx,
      io: COPILOT_IO,
    });
    writeFixture("copilot.json", rec.params);
  }

  // --- bind.json: two variants (initial / rebind), first create() of each ---
  {
    const initial = recording([[{ text: "ok" }]]);
    await bindGolden({
      client: initial.client, catalog: BIND_CATALOG as any, runSql: () => "",
      document: BIND_DOCUMENT as any, period: BIND_PERIOD, siblings: BIND_SIBLINGS as any,
    });
    const rebind = recording([[{ text: "ok" }]]);
    await bindGolden({
      client: rebind.client, catalog: BIND_CATALOG as any, runSql: () => "",
      document: BIND_DOCUMENT as any, period: BIND_PERIOD, siblings: BIND_SIBLINGS as any,
      priorInventory: BIND_PRIOR as any, feedback: BIND_FEEDBACK,
    });
    writeFixture("bind.json", { initial: initial.params[0], rebind: rebind.params[0] });
  }

  // --- unify.json: first create() with the head/tail-capped exemplar text ---
  {
    const rec = recording([[{ text: UNIFY_DOC_JSON }]]);
    await unifyGoldenReport({ client: rec.client, filename: UNIFY_FILENAME, text: UNIFY_TEXT });
    writeFixture("unify.json", rec.params);
  }
}

main().then(() => {
  if (skipped > 0) {
    console.error(`${skipped} fixture(s) skipped`);
    process.exit(1);
  }
});
