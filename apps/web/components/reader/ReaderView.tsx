"use client";

import { useState } from "react";
import Link from "next/link";
import type { Block, DocSection, RunDocument, RunProjection, RunStats } from "@runoff/core";
import type { FlagRow, GetRunResponse } from "@/lib/api";
import { getBlueprint, resolveFlag, saveRevision } from "@/lib/api";
import { showToast } from "@/components/Toast";
import { Topbar } from "@/components/Topbar";
import { DocumentPage } from "@/components/doc/DocumentPage";
import { SectionBlocks, type Annotate } from "@/components/doc/SectionBlocks";
import { StatusBanner } from "./StatusBanner";
import { RunReport } from "./RunReport";
import { FlagCard } from "./FlagCard";
import { DeliveryCard } from "./DeliveryCard";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Format a SQLite/ISO timestamp as "Jul 1, 2026" in UTC (hydration-safe). */
function formatDate(iso: string | null): string {
  if (!iso) return "";
  const norm = iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`;
  const d = new Date(norm);
  if (Number.isNaN(d.getTime())) return "";
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/** Parse a `string | null` JSON column, tolerating malformed data. */
function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * The Reader surface for a finished run: a clean document flanked by a status
 * banner and a right rail of run report / flag cards / delivery. Flags come from
 * the server rows (not the live projection) so resolutions survive a reload;
 * resolving a flag optimistically clears its highlight and, when the last one
 * closes, flips the banner from amber to ink. "Export PDF" is `window.print()`
 * against the print stylesheet; all other chrome carries `.no-print`.
 */
export function ReaderView({
  payload,
  projection,
}: {
  payload: GetRunResponse;
  projection: RunProjection;
}) {
  const { run, blueprint, sourceLabels, content } = payload;

  // A run complete on load carries its final document + stats as JSON columns;
  // a run that just completed live has them on the projection instead.
  const doc: RunDocument | null = projection.document ?? parseJson<RunDocument>(run.document);
  const stats: RunStats | null = projection.stats ?? parseJson<RunStats>(run.stats);

  const [flags, setFlags] = useState<FlagRow[]>(payload.flags);
  const [autoDeliver, setAutoDeliver] = useState(content.delivery.autoDeliverOnClear);

  const openCount = flags.filter((f) => f.status === "open").length;
  const resolvedCount = flags.filter((f) => f.status !== "open").length;
  const allCleared = openCount === 0;

  const title = doc?.title ?? content.title;
  const eyebrow = doc?.eyebrow ?? content.eyebrow;
  const dateline = doc?.dateline ?? content.dateline;
  const sections: DocSection[] = doc?.sections ?? [];

  const shortId = run.id.replace(/^run_/, "").slice(0, 4);
  const dateLabel = formatDate(run.finishedAt ?? run.createdAt);

  function handleResolve(flag: FlagRow, option: string) {
    setFlags((cur) =>
      cur.map((f) =>
        f.id === flag.id ? { ...f, status: "resolved", resolution: { option } } : f,
      ),
    );
    // The banner flips off the derived `openCount`; when this was the last open
    // flag, `remainingOpen` from the server confirms the same. On failure, flip
    // ONLY this flag back to open (a functional update, so a sibling flag
    // resolved concurrently is not clobbered by a stale whole-array snapshot).
    resolveFlag(flag.id, { option }).catch(() => {
      setFlags((cur) =>
        cur.map((f) =>
          f.id === flag.id ? { ...f, status: "open", resolution: null } : f,
        ),
      );
      showToast("Could not save your judgment.");
    });
  }

  function handleToggleDelivery() {
    const next = !autoDeliver;
    setAutoDeliver(next); // optimistic
    // The run pins an old revision, so persist against the blueprint's CURRENT
    // content: fetch it, flip the flag, save a new revision. Revert on failure.
    getBlueprint(blueprint.id)
      .then(({ content: current }) =>
        saveRevision(blueprint.id, {
          ...current,
          delivery: { ...current.delivery, autoDeliverOnClear: next },
        }),
      )
      .catch(() => {
        setAutoDeliver(!next);
        showToast("Could not save delivery settings.");
      });
  }

  /** Per-section highlight for its open flag: wrap the first paragraph's spans in
   * an amber mark, with the flag marker superscripted on the last span only. */
  function makeAnnotate(section: DocSection): Annotate | undefined {
    const flag = flags.find((f) => f.sectionKey === section.key && f.status === "open");
    if (!flag) return undefined;
    const firstParaIdx = section.blocks.findIndex((b: Block) => b.type === "paragraph");
    if (firstParaIdx < 0) return undefined;
    const para = section.blocks[firstParaIdx];
    const lastSpanIdx = para.type === "paragraph" ? para.spans.length - 1 : -1;
    return (_span, key, nodeContent) => {
      const parts = key.split("-");
      if (Number(parts[0]) !== firstParaIdx) return null;
      const isLast = Number(parts[1]) === lastSpanIdx;
      return (
        <mark className="bg-amber-accent/30">
          {nodeContent}
          {isLast ? (
            <sup className="ml-1 font-mono text-[8.5px] text-amber">{flag.code}</sup>
          ) : null}
        </mark>
      );
    };
  }

  const center = (
    <div className="flex items-center gap-[16px]">
      <Link href="/" className="font-sans text-[13px] text-ink/60">
        ← Blueprints
      </Link>
      <span className="font-serif text-[15px] font-semibold text-ink">{title}</span>
      <button
        type="button"
        onClick={() => showToast("Run history coming soon.")}
        className="flex items-center gap-[6px] rounded-full border border-ink/30 px-[12px] py-[5px] font-mono text-[10.5px] tracking-[0.5px] text-ink/70"
      >
        Run #{shortId} — {dateLabel} ▾
      </button>
      <button
        type="button"
        onClick={() => showToast("Comparison with previous runs coming soon.")}
        className="font-sans text-[12px] text-ink/60 underline"
      >
        compare with previous
      </button>
    </div>
  );

  const right = (
    <div className="flex items-center gap-[16px] font-sans text-[12px] font-medium">
      <button type="button" onClick={() => showToast("Sharing coming soon.")} className="text-ink/70">
        Share
      </button>
      <button
        type="button"
        onClick={() => showToast("DOCX export coming soon.")}
        className="rounded-full border border-ink/30 px-[14px] py-[6px] text-ink"
      >
        DOCX
      </button>
      <button
        type="button"
        onClick={() => window.print()}
        className="rounded-full bg-ink px-[14px] py-[6px] text-paper"
      >
        Export PDF
      </button>
    </div>
  );

  return (
    <>
      <div className="no-print">
        <Topbar center={center} right={right} />
      </div>

      <StatusBanner openCount={openCount} delivery={{ recipient: content.delivery.recipient, autoDeliverOnClear: autoDeliver }} />

      <main className="print-doc-root mx-auto grid w-full max-w-[1360px] grid-cols-[1fr_322px] gap-6 px-[40px] py-[28px]">
        <div className="flex flex-col items-center">
          <DocumentPage eyebrow={eyebrow} title={title} dateline={dateline}>
            {sections.map((s) => (
              <section key={s.key} className="mt-[28px] first:mt-0">
                <h2 className="mb-[10px] font-serif text-[19px] font-medium text-ink">{s.heading}</h2>
                <SectionBlocks blocks={s.blocks} sourceLabels={sourceLabels} annotate={makeAnnotate(s)} />
              </section>
            ))}
          </DocumentPage>
        </div>

        <aside className="no-print flex flex-col gap-[14px]">
          {stats ? (
            <RunReport stats={stats} resolvedCount={resolvedCount} allCleared={allCleared} />
          ) : null}

          {flags.map((flag) => (
            <FlagCard key={flag.id} flag={flag} onResolve={handleResolve} />
          ))}

          <DeliveryCard
            recipient={content.delivery.recipient}
            autoDeliver={autoDeliver}
            onToggle={handleToggleDelivery}
          />
        </aside>
      </main>
    </>
  );
}
