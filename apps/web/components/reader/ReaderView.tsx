"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { Block, DocSection, GoldenRow, RunDocument, RunProjection, RunStats } from "@runoff/core";
import { diffRuns } from "@runoff/core/src/diff.js";
// Deep import the reducer (not the barrel) so this client bundle never pulls in
// the SQLite db layer — same guard the diff import above follows. Type-only
// imports from the barrel are erased and stay safe.
import { reduceRun } from "@runoff/core/src/reducer.js";
// Deep import (not the barrel) keeps this client bundle free of the db layer.
import { formatPeriod } from "@runoff/core/src/types/sources.js";
import type { FlagRow, GetRunResponse } from "@/lib/api";
import { deleteGolden, getBlueprint, getGoldens, resolveFlag, saveRevision, starGolden } from "@/lib/api";
import { showToast } from "@/components/Toast";
import { Topbar } from "@/components/Topbar";
import { DocumentPage } from "@/components/doc/DocumentPage";
import { SectionBlocks, type Annotate } from "@/components/doc/SectionBlocks";
import { StatusBanner } from "./StatusBanner";
import { RunReport } from "./RunReport";
import { DeltaCard } from "./DeltaCard";
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
  projection: projectionProp,
}: {
  payload: GetRunResponse;
  projection?: RunProjection;
}) {
  const { run, blueprint, project, sourceLabels, content } = payload;

  // The live surface hands its projection down; a run opened cold (or a test that
  // renders the Reader directly) has none, so derive it from the seeded events.
  const projection = useMemo(
    () => projectionProp ?? reduceRun(payload.events, payload.sectionMeta),
    [projectionProp, payload.events, payload.sectionMeta],
  );

  // A run complete on load carries its final document + stats as JSON columns;
  // a run that just completed live has them on the projection instead.
  const doc: RunDocument | null = projection.document ?? parseJson<RunDocument>(run.document);
  const stats: RunStats | null = projection.stats ?? parseJson<RunStats>(run.stats);

  const diff = doc && payload.previous ? diffRuns(doc, payload.previous.document) : null;
  const showDeltaCard =
    diff !== null &&
    (diff.deltas.length > 0 || Object.values(diff.sections).some((s) => s !== "unchanged"));
  const deltasFor = (key: string) =>
    diff
      ? Object.fromEntries(
          diff.deltas
            .filter((d) => d.sectionKey === key)
            .map((d) => [`${d.sourceId}|${d.locator}`, { before: d.before, after: d.after }]),
        )
      : undefined;

  const [flags, setFlags] = useState<FlagRow[]>(payload.flags);
  const [autoDeliver, setAutoDeliver] = useState(content.delivery.autoDeliverOnClear);

  // The standing notes that shaped this run: all of the blueprint's memories,
  // filtered to the ones the run actually loaded (`projection.memoryIds`).
  const [memoriesOpen, setMemoriesOpen] = useState(false);
  const usedMemories = payload.memories.filter((m) => projection.memoryIds.includes(m.id));

  // Star state is orthogonal to the run payload: load the blueprint's goldens once
  // on mount so the run/section stars can render filled. Mutations update this list
  // optimistically (the POST/DELETE reconcile server-side).
  const [goldens, setGoldens] = useState<GoldenRow[]>([]);
  useEffect(() => {
    getGoldens(blueprint.id)
      .then((r) => setGoldens(r.goldens))
      .catch(() => {});
  }, [blueprint.id]);

  const runStar = goldens.find((g) => g.kind === "run" && g.runId === run.id) ?? null;
  const sectionStar = (key: string) =>
    goldens.find((g) => g.kind === "section" && g.runId === run.id && g.sectionKey === key) ?? null;

  const addStar = (id: string, kind: "run" | "section", sectionKey: string | null) =>
    setGoldens((cur) => [
      ...cur,
      { id, blueprintId: blueprint.id, kind, runId: run.id, sectionKey, name: null, mime: null, storedFilename: null, note: null, period: null, document: null, unifyError: null, bindings: null, createdAt: "" },
    ]);

  function toggleRunStar() {
    if (runStar) {
      setGoldens((cur) => cur.filter((g) => g.id !== runStar.id));
      deleteGolden(runStar.id).catch(() => showToast("Could not update stars."));
      return;
    }
    starGolden(blueprint.id, { kind: "run", runId: run.id })
      .then((r) => addStar(r.id, "run", null))
      .catch(() => showToast("Could not update stars."));
  }

  function toggleSectionStar(key: string) {
    const existing = sectionStar(key);
    if (existing) {
      setGoldens((cur) => cur.filter((g) => g.id !== existing.id));
      deleteGolden(existing.id).catch(() => showToast("Could not update stars."));
      return;
    }
    starGolden(blueprint.id, { kind: "section", runId: run.id, sectionKey: key })
      .then((r) => addStar(r.id, "section", key))
      .catch(() => showToast("Could not update stars."));
  }

  const openCount = flags.filter((f) => f.status === "open").length;
  const resolvedCount = flags.filter((f) => f.status !== "open").length;
  const allCleared = openCount === 0;

  const title = doc?.title ?? content.title;
  const eyebrow = doc?.eyebrow ?? content.eyebrow;
  const dateline = doc?.dateline ?? content.dateline;
  const datelineNode = run.period ? (
    <>
      {dateline}
      <span className="ml-2 font-mono text-[11px] not-italic tracking-tight text-ink/45">{formatPeriod(run.period)}</span>
    </>
  ) : (
    dateline
  );
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
      <Link href={`/projects/${project.id}`} className="font-sans text-[13px] text-ink/60">
        ← {project.name || "Project"}
      </Link>
      <span className="font-serif text-[15px] font-semibold text-ink">{title}</span>
      <button
        type="button"
        onClick={() => showToast("Run history coming soon.")}
        className="flex items-center gap-[6px] rounded-full border border-ink/30 px-[12px] py-[5px] font-mono text-[10.5px] tracking-[0.5px] text-ink/70"
      >
        Run #{shortId} — {dateLabel} ▾
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
          <DocumentPage eyebrow={eyebrow} title={title} dateline={datelineNode}>
            {sections.map((s) => (
              <section key={s.key} className="mt-[28px] first:mt-0">
                <div className="mb-[10px] flex items-baseline gap-[8px]">
                  <h2 className="font-serif text-[19px] font-medium text-ink">{s.heading}</h2>
                  <button
                    type="button"
                    aria-label="Star section"
                    onClick={() => toggleSectionStar(s.key)}
                    className="no-print font-mono text-[13px] leading-none text-ink/35 transition-colors hover:text-amber"
                  >
                    {sectionStar(s.key) ? "★" : "☆"}
                  </button>
                </div>
                <SectionBlocks blocks={s.blocks} sourceLabels={sourceLabels} annotate={makeAnnotate(s)} figureDeltas={deltasFor(s.key)} />
              </section>
            ))}
          </DocumentPage>
        </div>

        <aside className="no-print flex flex-col gap-[14px]">
          {stats ? (
            <RunReport stats={stats} resolvedCount={resolvedCount} allCleared={allCleared} />
          ) : null}

          {stats ? (
            <div className="no-print border border-ink/12 bg-card px-[16px] py-[10px]">
              <button
                type="button"
                aria-label="Star this run"
                onClick={toggleRunStar}
                className="flex items-center gap-[6px] font-sans text-[11px] font-medium text-ink/65 transition-colors hover:text-amber"
              >
                <span className="text-[13px] leading-none">{runStar ? "★" : "☆"}</span>
                Star this run
              </button>
              {usedMemories.length > 0 ? (
                <div data-testid="memory-line" className="no-print mt-2 border-t border-ink/10 pt-2">
                  <button
                    type="button"
                    className="font-mono text-[8.5px] uppercase tracking-[1px] text-ink/45"
                    onClick={() => setMemoriesOpen((v) => !v)}
                  >
                    Memory — {usedMemories.length} standing note{usedMemories.length === 1 ? "" : "s"}
                  </button>
                  {memoriesOpen
                    ? usedMemories.map((m) => (
                        <p key={m.id} className="mt-1 font-serif text-[12px] leading-[1.5] text-ink/70">
                          <span className="mr-1.5 font-mono text-[8px] uppercase tracking-[1px] text-ink/40">{m.scope}</span>
                          {m.body}
                        </p>
                      ))
                    : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {showDeltaCard ? (
            <DeltaCard
              diff={diff}
              sourceLabels={sourceLabels}
              previousDate={formatDate(payload.previous!.completedAt)}
            />
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
