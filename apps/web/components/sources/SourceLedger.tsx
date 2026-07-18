"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SourceRow } from "@/lib/api";
import { deleteSource } from "@/lib/api";
import { fmtRel, isStale } from "@/lib/format";
import { showToast } from "@/components/Toast";

const COLS = [
  ["SOURCE", "flex-[2.5]"],
  ["KIND", "flex-[1]"],
  ["USED BY", "flex-[1.4]"],
  ["FRESHNESS", "flex-[1.5]"],
  ["SYNC", "flex-[1.4]"],
] as const;

/**
 * The sources ledger: SOURCE / KIND / USED BY / FRESHNESS / SYNC. Freshness is
 * derived from `uploadedAt`; sources older than the stale
 * threshold get an amber row wash, a `▲ … — STALE` marker, and a "Request
 * update" action that optimistically swaps to "REMINDER SENT ✓". Each row
 * reveals a delete affordance on hover. Client component (delete + refresh).
 */
export function SourceLedger({ sources }: { sources: SourceRow[] }) {
  const router = useRouter();

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

      {sources.length === 0 ? (
        <div className="px-[2px] py-[13px] font-serif text-[14px] italic text-ink/45">
          No sources connected yet.
        </div>
      ) : (
        sources.map((s) => <LedgerRow key={s.id} source={s} router={router} />)
      )}
    </div>
  );
}

function LedgerRow({
  source,
  router,
}: {
  source: SourceRow;
  router: ReturnType<typeof useRouter>;
}) {
  const [requested, setRequested] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const ts = source.uploadedAt;
  const stale = isStale(ts);
  const rel = fmtRel(ts);
  const usedBy = source.usedBy ?? 0;

  function requestUpdate() {
    // Purely optimistic: "Request update" nudges the source owner; the data
    // isn't refreshed here, so the row legitimately stays stale.
    setRequested(true);
    showToast("Reminder sent.");
  }

  async function remove() {
    if (deleting) return;
    if (!window.confirm(`Remove "${source.name}"? This can't be undone.`)) return;
    setDeleting(true);
    try {
      await deleteSource(source.id);
      router.refresh();
    } catch {
      setDeleting(false);
      showToast("Couldn't remove the source.");
    }
  }

  return (
    <div
      data-testid={`source-row-${source.id}`}
      className={`group flex items-baseline border-b border-ink/10 px-[2px] py-[13px] ${
        stale ? "bg-amber-accent/10" : ""
      } ${deleting ? "opacity-50" : ""}`}
    >
      <span className="flex-[2.5] font-serif text-[15px] text-ink">{source.name}</span>
      <span className="flex-[1] font-mono text-[10.5px] uppercase text-ink/55">
        {source.kind.toUpperCase()}
      </span>
      <span className="flex-[1.4] font-mono text-[10.5px] text-ink/60">
        {usedBy} {usedBy === 1 ? "BLUEPRINT" : "BLUEPRINTS"}
      </span>
      <span className="flex-[1.5] font-mono text-[10.5px]">
        {stale ? (
          <span className="text-amber">▲ {rel} — STALE</span>
        ) : (
          <span className="text-ink/60">✓ {rel} AGO</span>
        )}
      </span>
      <span className="flex-[1.4] font-mono text-[10.5px]">
        {stale ? (
          requested ? (
            <span className="text-ink/50">REMINDER SENT ✓</span>
          ) : (
            <button
              type="button"
              onClick={requestUpdate}
              className="text-amber underline underline-offset-2"
            >
              Request update
            </button>
          )
        ) : (
          <span className="text-ink/40">—</span>
        )}
      </span>
      <button
        type="button"
        onClick={remove}
        disabled={deleting}
        aria-label={`Remove ${source.name}`}
        className="w-[22px] text-left text-[13px] text-ink/30 opacity-0 transition-opacity hover:text-pencil group-hover:opacity-100"
      >
        ✕
      </button>
    </div>
  );
}
