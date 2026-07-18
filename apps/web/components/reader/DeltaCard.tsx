import type { RunDiff } from "@runoff/core";

/**
 * The Reader rail's "SINCE LAST RUN" card: one row per changed cited figure
 * (source label + locator, before → after) and a section-status summary line.
 * Screen-only (`no-print`) — the exported document never carries diff chrome.
 */
export function DeltaCard({
  diff,
  sourceLabels,
  previousDate,
}: {
  diff: RunDiff;
  sourceLabels: Record<string, string>;
  previousDate: string;
}) {
  const statuses = Object.values(diff.sections);
  const summary = (["changed", "unchanged", "new", "removed"] as const)
    .map((s) => [statuses.filter((x) => x === s).length, s] as const)
    .filter(([n]) => n > 0)
    .map(([n, s]) => `${n} ${s}`)
    .join(" · ");

  return (
    <div
      data-testid="delta-card"
      className="no-print border border-t-2 border-ink/12 border-t-ink bg-card p-[14px]"
    >
      <div className="font-sans text-[9.5px] font-semibold uppercase tracking-[2.5px] text-ink/45">
        Since last run — {previousDate}
      </div>
      <div className="mt-[10px] flex flex-col gap-[6px]">
        {diff.deltas.map((d, i) => (
          <div key={i} className="flex items-baseline justify-between gap-[10px]">
            <span className="truncate font-serif text-[12px] text-ink/70">
              {sourceLabels[d.sourceId] ?? d.sourceId} · {d.locator}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-ink">
              {d.before.toLocaleString("en-US")} → {d.after.toLocaleString("en-US")}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-[10px] font-serif text-[11.5px] italic text-ink/55">{summary}</p>
    </div>
  );
}
