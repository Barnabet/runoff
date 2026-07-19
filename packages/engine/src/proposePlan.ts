import type OpenAI from "openai";
import { ParsePlanSchema, validateParsePlan, type ExecReport, type ParsePlan } from "@runoff/core";
import type { SheetGrid } from "./parsePlan.js";
import { rawCell } from "./parsePlan.js";
import { MODEL } from "./prompts.js";

const SAMPLE_ROWS = 30;
const SAMPLE_COLS = 15;
const SAMPLE_CAP = 6000;
const CELL_CAP = 20;

export function buildGridSample(grids: SheetGrid[], hints: string): string {
  const parts: string[] = [];
  for (const { sheet, grid } of grids) {
    const rows = Math.max(grid.length, 0);
    const cols = grid.reduce((m, r) => Math.max(m, (r ?? []).length), 0);
    const lines = [`## sheet: ${sheet} (${rows}×${cols})`];
    for (let r = 0; r < Math.min(rows, SAMPLE_ROWS); r++) {
      const cells = (grid[r] ?? []).slice(0, SAMPLE_COLS).map((v) => rawCell(v).slice(0, CELL_CAP));
      lines.push(`R${r + 1}: ${cells.join(" | ")}`);
    }
    parts.push(lines.join("\n"));
  }
  parts.push(`## detector hints\n${hints}`);
  return parts.join("\n\n").slice(0, SAMPLE_CAP);
}

const PLAN_CONTRACT =
  `Return JSON matching: {"version":1,"tables":[{"name":snake_case,"anchor":{"sheet"?:slug,` +
  `"headerSignature":[normalized header cell texts],"minMatch":int},"headerRows":1-3,` +
  `"exclude":[{"column":canonical|null,"pattern":regex}],"columns":[{"from":normalized merged header,` +
  `"name":snake_case,"type":"TEXT"|"INTEGER"|"REAL","parse"?:"number"|"currency"|"percent"|"date"}],` +
  `"unpivot"?:{"keep":[canonical],"valuePattern":regex,"keyColumn":snake_case,"valueColumn":snake_case,` +
  `"valueType":"INTEGER"|"REAL"|"TEXT","valueParse"?:"number"|"currency"|"percent"},` +
  `"periodColumn"?:canonical (its column MUST have parse "date"),"onPeriodMismatch"?:"keep"|"exclude"}]}. ` +
  `Header/from texts are lowercase, whitespace-collapsed. One entry per REAL data table; title rows, ` +
  `notes and total rows are NOT tables. Exclude total/subtotal rows with an exclude rule on a key column. ` +
  `Set minMatch ≈ two-thirds of the signature length. Unpivot wide period-like column layouts. ` +
  `Use parse for formatted values ("$1,234"→currency, "12%"→percent, dates→date).`;

/**
 * One structured call proposing (or amending) a ParsePlan. Zod + structural
 * validation; one retry on invalid; null on any failure — callers fall back to
 * the plan-less flow.
 */
export async function proposeParsePlan(opts: {
  client: OpenAI;
  filename: string;
  gridSample: string;
  existingPlan?: ParsePlan;
  fitDetail?: string[];
  execReport?: ExecReport;
  feedback?: string;
}): Promise<ParsePlan | null> {
  const amendment = opts.existingPlan
    ? ` You are AMENDING a working plan. You MUST keep every existing logical table name and canonical column name; ` +
      `re-anchor and re-map "from" texts onto them. You may ADD new columns; never remove or rename existing ones.`
    : "";
  const system =
    `You write parse plans that turn one uploaded spreadsheet/CSV into clean database tables. ` +
    `A deterministic engine executes your plan; anchors locate each table's header row by cell-text ` +
    `signature, so plans survive moved/renamed sheets. ${PLAN_CONTRACT}${amendment}`;
  const userParts = [`Filename: ${opts.filename}`, `File sample:\n${opts.gridSample}`];
  if (opts.existingPlan) userParts.push(`Existing plan:\n${JSON.stringify(opts.existingPlan)}`);
  if (opts.fitDetail?.length) userParts.push(`Fit problems:\n${opts.fitDetail.join("\n")}`);
  if (opts.execReport) userParts.push(`Execution report of the previous attempt:\n${JSON.stringify(opts.execReport)}`);
  if (opts.feedback) userParts.push(`User feedback:\n${opts.feedback}`);

  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string;
    try {
      const res = await (opts.client as any).chat.completions.create({
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userParts.join("\n\n") },
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: 2000,
      });
      raw = res.choices?.[0]?.message?.content ?? "";
    } catch {
      return null;
    }
    try {
      const parsed = ParsePlanSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) continue;
      validateParsePlan(parsed.data);
      return parsed.data;
    } catch {
      continue;
    }
  }
  return null;
}

/** Should the self-check round fire? See plan Global Constraints for the pinned criteria. */
export function isDegenerate(report: ExecReport): boolean {
  return report.tables.some(
    (t) =>
      t.problems.length > 0 ||
      t.rowsKept === 0 ||
      t.coercionFailures.some((f) => t.rowsKept > 0 && f.count >= t.rowsKept),
  );
}
