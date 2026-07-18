"use client";

import { useState } from "react";
import { Topbar } from "@/components/Topbar";
import type { SourceRow } from "@/lib/api";
import { isStale } from "@/lib/format";
import { SourceLedger } from "./SourceLedger";
import { AddSourceModal } from "./AddSourceModal";

/**
 * The Sources screen. Owns the add-source modal's open state, shows the
 * connected/stale count, and composes the ledger with the connect modal.
 * Rendered by the server `app/sources/page.tsx`, which supplies the rows.
 */
export function SourcesView({ sources }: { sources: SourceRow[] }) {
  const [modalOpen, setModalOpen] = useState(false);

  const connected = sources.length;
  const staleCount = sources.filter((s) => isStale(s.refreshedAt ?? s.uploadedAt)).length;

  return (
    <>
      <Topbar
        tab="sources"
        right={
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="rounded-full bg-ink px-4 py-2 font-sans text-[12.5px] font-medium text-paper"
            >
              Add source
            </button>
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-ink font-serif text-[13px] font-medium italic text-paper">
              L
            </div>
          </div>
        }
      />

      <main className="mx-auto w-full max-w-[1360px] px-10 pb-[34px] pt-7">
        <div className="flex items-baseline gap-[14px]">
          <h1 className="font-serif text-[30px] font-medium text-ink">Sources</h1>
          <span className="font-mono text-[11px] text-ink/50">
            {connected} CONNECTED · {staleCount} STALE
          </span>
        </div>

        <SourceLedger sources={sources} />

        <div className="mt-4 font-serif text-[13px] italic text-ink/45">
          Every source is read-only. The agent queries and quotes; it never writes
          back.
        </div>
      </main>

      {modalOpen && <AddSourceModal onClose={() => setModalOpen(false)} />}
    </>
  );
}
