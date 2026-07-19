import type { ParsePlan, TablePlan } from "@runoff/core";

// Plain-language, deterministic rendering of a ParsePlan for the confirm panel.
// Line formats are pinned by the v1.4 spec §7 — treat as contract.
export function renderPlanSteps(plan: ParsePlan): string[] {
  return plan.tables.flatMap((t) => tableSteps(t));
}

function tableSteps(t: TablePlan): string[] {
  const lines = [`table ${t.name}: anchored by ${t.anchor.headerSignature.length}-cell header signature (min ${t.anchor.minMatch})`];
  lines.push(t.headerRows === 1 ? `header: 1 row` : `header: rows 1–${t.headerRows} merged`);
  for (const r of t.exclude) lines.push(`excluding rows where ${r.column ?? "any cell"} matches /${r.pattern}/i`);
  for (const c of t.columns) lines.push(`${c.from} → ${c.name} (${c.parse ?? c.type})`);
  if (t.unpivot) lines.push(`unpivot: headers matching /${t.unpivot.valuePattern}/i → ${t.unpivot.keyColumn}/${t.unpivot.valueColumn}`);
  if (t.periodColumn) lines.push(`period check: ${t.periodColumn} vs slot (${t.onPeriodMismatch} mismatches)`);
  return lines;
}
