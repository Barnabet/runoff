import Link from "next/link";
import type { BlueprintListItem } from "@/lib/api";
import { fmtDate } from "@/lib/format";

/**
 * The triage strip above the ledger: one card per blueprint whose latest run
 * still has open flags. Cards sit side-by-side with a 2px red top border and a
 * solid "Review" pill linking to the run's Reader. Renders nothing when the
 * queue is empty. Server-safe (pure presentational).
 */
export function ReviewQueue({ blueprints }: { blueprints: BlueprintListItem[] }) {
  const flagged = blueprints.filter((b) => (b.lastRun?.openFlags ?? 0) > 0);
  if (flagged.length === 0) return null;

  return (
    <div className="mt-5 flex flex-wrap gap-[14px]">
      {flagged.map((b) => {
        const n = b.lastRun!.openFlags;
        const flagWord = n === 1 ? "FLAG" : "FLAGS";
        const date = fmtDate(b.lastRun!.finishedAt);
        const meta = date ? `${date} · ${n} ${flagWord}` : `${n} ${flagWord}`;
        return (
          <div
            key={b.id}
            className="flex min-w-[280px] flex-1 items-center gap-[14px] border border-t-2 border-ink/[0.14] border-t-pencil bg-card px-4 py-[14px]"
          >
            <div className="flex-1">
              <div className="font-serif text-[14.5px] font-medium text-ink">
                {b.clientName || b.name} — run finished with {n}{" "}
                {n === 1 ? "flag" : "flags"}
              </div>
              <div className="mt-[3px] font-mono text-[10.5px] uppercase text-ink/50">
                {meta}
              </div>
            </div>
            <Link
              href={`/runs/${b.lastRun!.id}`}
              className="shrink-0 rounded-full bg-ink px-[14px] py-[6px] font-sans text-[11.5px] font-medium text-paper"
            >
              Review
            </Link>
          </div>
        );
      })}
    </div>
  );
}
