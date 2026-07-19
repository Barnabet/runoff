import type OpenAI from "openai";
import type { ExecReport, Granularity, ParsePlan, PlanPreview } from "@runoff/core";
import {
  buildGridSample, executeParsePlan, fitParsePlan, isDegenerate, loadGrids,
  proposeParsePlan, scanSample, type ExecTable, type SheetGrid, type TabularScan,
} from "@runoff/engine";

const PREVIEW_ROWS = 8;

export function buildPreview(tables: ExecTable[]): PlanPreview {
  return {
    tables: tables.map((t) => ({
      name: t.logical,
      columns: t.columns.map((c) => c.name),
      rows: t.rows.slice(0, PREVIEW_ROWS).map((r) =>
        r.map((v) => (v === null || typeof v === "number" ? (v as number | null) : String(v)))),
    })),
  };
}

export type PlanOutcome =
  | {
      plan: ParsePlan;
      planStatus: "stored" | "proposed" | "amended";
      preview: PlanPreview;
      report: ExecReport;
      /** Logical-name output schemas for drift enrichment; NOT persisted in the proposal JSON. */
      outputSchemas: { name: string; columns: { name: string; type: "TEXT" | "INTEGER" | "REAL" }[] }[];
    }
  | { planStatus: "none" };

/**
 * The full plan decision for one upload: stored-plan fit (zero LLM) →
 * amendment → fresh proposal, with the single automatic self-check round.
 * `slotPeriod`/`granularity` come from the CLASSIFY proposal (they may be
 * null; period validation simply skips).
 */
export async function planForUpload(opts: {
  client: OpenAI;
  filename: string;
  path: string;
  mime: string;
  scan: TabularScan;
  storedPlan: ParsePlan | null;
  slotPeriod: string | null;
  granularity: Granularity | null;
  feedback?: string;
}): Promise<PlanOutcome> {
  const grids: SheetGrid[] = await loadGrids(opts.path, opts.mime, opts.filename);
  const exec = (plan: ParsePlan) => executeParsePlan(grids, plan, opts.slotPeriod, opts.granularity);

  // Stored plan, no feedback: fit → execute without any LLM.
  if (opts.storedPlan && !opts.feedback) {
    const fit = fitParsePlan(grids, opts.storedPlan);
    if (fit.verdict === "fit") {
      const { tables, report } = exec(opts.storedPlan);
      return { plan: opts.storedPlan, planStatus: "stored", preview: buildPreview(tables), report, outputSchemas: schemasOf(tables) };
    }
    const amended = await proposeWithSelfCheck({ existingPlan: opts.storedPlan, fitDetail: fit.detail });
    return amended ?? { planStatus: "none" };
  }

  // Fresh proposal, or feedback revision of the current plan.
  const proposed = await proposeWithSelfCheck({
    existingPlan: opts.feedback ? opts.storedPlan ?? undefined : undefined,
    feedback: opts.feedback,
  });
  return proposed ?? { planStatus: "none" };

  async function proposeWithSelfCheck(extra: {
    existingPlan?: ParsePlan;
    fitDetail?: string[];
    feedback?: string;
  }): Promise<PlanOutcome | null> {
    const gridSample = buildGridSample(grids, scanSample(opts.scan));
    const base = { client: opts.client, filename: opts.filename, gridSample, ...extra };
    let plan = await proposeParsePlan(base);
    if (!plan) return null;
    let { tables, report } = exec(plan);
    if (isDegenerate(report)) {
      const retry = await proposeParsePlan({ ...base, execReport: report });
      if (retry) {
        plan = retry;
        ({ tables, report } = exec(plan));
      }
    }
    const planStatus = extra.existingPlan ? "amended" : "proposed";
    return { plan, planStatus, preview: buildPreview(tables), report, outputSchemas: schemasOf(tables) };
  }
}

function schemasOf(tables: ExecTable[]): { name: string; columns: { name: string; type: "TEXT" | "INTEGER" | "REAL" }[] }[] {
  return tables.map((t) => ({ name: t.logical, columns: t.columns }));
}
