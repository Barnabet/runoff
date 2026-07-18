import Link from "next/link";
import type { BlueprintListItem } from "@/lib/api";
import { fmtDate } from "@/lib/format";

const COLS = [
  ["BLUEPRINT", "flex-[2.5]"],
  ["CLIENT", "flex-[1.4]"],
  ["CADENCE", "flex-[1]"],
  ["SOURCES", "flex-[0.8]"],
  ["LAST RUN", "flex-[1.5]"],
  ["NEXT RUN", "flex-[1]"],
] as const;

/**
 * The blueprint ledger: an editorial table (mono values, serif names) with one
 * clickable row per blueprint routing to its Builder. The LAST RUN cell folds
 * the latest run's date and status (open flags in red, clean in muted, else a
 * dash). Server-safe (rows are plain links, no hooks).
 */
export function BlueprintLedger({ blueprints }: { blueprints: BlueprintListItem[] }) {
  return (
    <div className="mt-[26px]">
      <div className="flex border-b border-ink/30 px-[2px] pb-[9px] font-sans text-[9.5px] font-semibold uppercase tracking-[1.8px] text-ink/45">
        {COLS.map(([label, flex]) => (
          <span key={label} className={flex}>
            {label}
          </span>
        ))}
        <span className="w-[22px]" />
      </div>

      {blueprints.length === 0 ? (
        <div className="px-[2px] py-[13px] font-serif text-[14px] italic text-ink/45">
          No blueprints match.
        </div>
      ) : (
        blueprints.map((b) => <LedgerRow key={b.id} b={b} />)
      )}
    </div>
  );
}

function LedgerRow({ b }: { b: BlueprintListItem }) {
  const draft = b.status === "draft";
  return (
    <Link
      href={`/blueprints/${b.id}`}
      className="flex items-baseline border-b border-ink/10 px-[2px] py-[13px] transition-colors hover:bg-ink/[0.03]"
    >
      <span className="flex-[2.5] font-serif text-[15.5px] font-medium">
        <span className={draft ? "text-ink/45" : "text-ink"}>{b.name}</span>
        {draft && (
          <span className="ml-[6px] inline-block rounded-[3px] border border-ink/20 px-[5px] py-[2px] align-[2px] font-mono text-[8.5px] uppercase tracking-[1px] text-ink/50">
            DRAFT
          </span>
        )}
      </span>
      <span className="flex-[1.4] text-[12px] text-ink/65">{b.clientName || "—"}</span>
      <span className="flex-[1] font-mono text-[10.5px] text-ink/60">{b.cadenceLabel}</span>
      <span className="flex-[0.8] font-mono text-[10.5px] text-ink/60">{b.sourceCount}</span>
      <span className="flex-[1.5] font-mono text-[10.5px] text-ink/60">
        <LastRunCell b={b} />
      </span>
      <span className="flex-[1] font-mono text-[10.5px] text-ink/60">MANUAL</span>
      <span className="w-[22px] text-ink/40">→</span>
    </Link>
  );
}

/** The date + status fold shown in the LAST RUN column. */
function LastRunCell({ b }: { b: BlueprintListItem }) {
  const run = b.lastRun;
  if (!run) return <span className="text-ink/45">—</span>;

  const date = fmtDate(run.finishedAt);
  let statusText = "";
  let statusClass = "";
  if (run.openFlags > 0) {
    statusText = `${run.openFlags} ${run.openFlags === 1 ? "FLAG" : "FLAGS"}`;
    statusClass = "text-pencil";
  } else if (run.status === "complete") {
    statusText = "✓ CLEAN";
    statusClass = "text-ink/45";
  }

  if (!date && !statusText) return <span className="text-ink/45">—</span>;

  return (
    <>
      {date && (
        <span>
          {date}
          {statusText ? " · " : ""}
        </span>
      )}
      {statusText && <span className={statusClass}>{statusText}</span>}
    </>
  );
}
