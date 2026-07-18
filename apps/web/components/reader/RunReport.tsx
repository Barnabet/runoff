import type { RunStats } from "@runoff/core";

/** Group a whole number with thousands separators (2140 → "2,140"). */
function grouped(n: number): string {
  return n.toLocaleString("en-US");
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The RUN REPORT card in the Reader's right rail: a two-column mono ledger read
 * straight from the run's final `stats`. When every flag has been cleared the
 * CHECKS row gains a ` · N resolved ✓` tail so the ledger reflects the judgment
 * work the reader just did.
 */
export function RunReport({
  stats,
  resolvedCount,
  allCleared,
}: {
  stats: RunStats;
  resolvedCount: number;
  allCleared: boolean;
}) {
  const checks =
    `${plural(stats.checksPassed, "pass", "pass")} · ${plural(stats.flagCount, "flag", "flags")}` +
    (allCleared && resolvedCount > 0 ? ` · ${resolvedCount} resolved ✓` : "");

  const rows: [string, string][] = [
    ["Duration", `${(stats.durationMs / 1000).toFixed(1)}s · ${plural(stats.retries, "retry", "retries")}`],
    ["Length", `${grouped(stats.words)} words`],
    ["Sources", `${stats.sourcesUsed} used`],
    ["Checks", checks],
    ["Citations", `${stats.citationCount} figures`],
  ];

  return (
    <div data-testid="run-report" className="border border-ink/12 bg-card p-[16px]">
      <div className="mb-[12px] font-sans text-[9.5px] font-semibold uppercase tracking-[2px] text-ink/45">
        Run report
      </div>
      <dl className="flex flex-col gap-[8px]">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-[10px]">
            <dt className="font-sans text-[9px] font-semibold uppercase tracking-[1.8px] text-ink/45">
              {label}
            </dt>
            <dd className="text-right font-mono text-[10.5px] text-ink/80">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
