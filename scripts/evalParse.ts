/**
 * Live smoke for proposeParsePlan: give the model the messy AR-aging fixture
 * (glued title + Grand Total + currency strings + wide months sheet) and
 * assert the plan it writes actually parses the file correctly. Name-agnostic:
 * assertions check row counts and sums, not the model's choice of names.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import {
  buildGridSample, executeParsePlan, isDegenerate, loadGrids, proposeParsePlan,
  scanSample, scanTabular,
} from "@runoff/engine";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function fail(detail: string): never {
  console.error(`EVAL PARSE FAIL: ${detail}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const client = new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL ?? "http://localhost:8317/v1",
    apiKey: process.env.OPENAI_API_KEY ?? "",
  });
  const path = join(HERE, "fixtures", "ar_aging_q2_2026.xlsx");
  const name = "ar_aging_q2_2026.xlsx";
  const grids = await loadGrids(path, MIME, name);
  const scan = await scanTabular(path, MIME, name);
  let plan = await proposeParsePlan({ client, filename: name, gridSample: buildGridSample(grids, scanSample(scan)) });
  if (!plan) fail("no plan proposed");
  let { tables, report } = executeParsePlan(grids, plan, "2026-Q2", "quarter");
  if (isDegenerate(report)) {
    const retry = await proposeParsePlan({ client, filename: name, gridSample: buildGridSample(grids, scanSample(scan)), execReport: report });
    if (retry) { plan = retry; ({ tables, report } = executeParsePlan(grids, plan, "2026-Q2", "quarter")); }
  }
  const problems = report.tables.flatMap((t) => t.problems);
  if (problems.length) fail(`plan has problems: ${problems.join("; ")}`);
  if (plan.tables.length < 2) fail(`expected 2 tables, plan has ${plan.tables.length}`);

  // The aging table: 6 data rows, Grand Total excluded, currency parsed —
  // some numeric column must sum to exactly 61,000 (7 rows or unparsed
  // currency cannot produce it: the total row would double it to 122,000).
  const hit = tables.find((t) =>
    t.rows.length === 6 &&
    t.columns.some((_, ci) => {
      const sum = t.rows.reduce((a, r) => a + (typeof r[ci] === "number" ? (r[ci] as number) : 0), 0);
      return Math.abs(sum - 61000) < 0.01;
    }));
  if (!hit) fail(`no table kept exactly 6 rows summing to 61000 (kept: ${tables.map((t) => t.rows.length).join(", ")})`);
  console.log(`EVAL PARSE OK: ${plan.tables.length} tables · aging kept 6 · sum 61,000 verified`);
}

main().catch((err) => { console.error(err); process.exit(1); });
