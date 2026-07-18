"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { RunProjection } from "@runoff/core";
import type { GetRunResponse } from "@/lib/api";
import { createRun, postRunInput } from "@/lib/api";
import { showToast } from "@/components/Toast";
import { Topbar } from "@/components/Topbar";
import { DocumentPage } from "@/components/doc/DocumentPage";
import { Greeked } from "@/components/doc/Greeked";
import { RunRail } from "./RunRail";
import { AgentDesk } from "./AgentDesk";
import { LiveSection } from "./LiveSection";

/** Parse a SQLite/ISO timestamp to epoch ms; SQLite's `datetime` has no T/Z. */
function tsToMs(iso: string | null): number | null {
  if (!iso) return null;
  const normalized = iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`;
  const ms = new Date(normalized).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** Format elapsed milliseconds as MM:SS. */
function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/**
 * The Live Run surface: topbar with the live phase badge and elapsed clock, a
 * completion-fraction progress bar, and the three rails — THIS RUN (left), the
 * page writing itself (center), and THE AGENT'S DESK (right). Rendered while the
 * run is in-flight and once it completes (the completion card offers the handoff
 * to the Reader); a failed run shows a banner in place of the progress bar.
 */
export function LiveRunView({
  payload,
  projection,
  connectionLost,
  onOpenReport,
}: {
  payload: GetRunResponse;
  projection: RunProjection;
  connectionLost: boolean;
  onOpenReport: () => void;
}) {
  const router = useRouter();
  const { run, blueprint, sectionMeta, sourceLabels, content } = payload;
  const terminal = projection.status === "complete" || projection.status === "failed";

  const shortId = run.id.replace(/^run_/, "").slice(0, 4);
  const sourceCount = Object.keys(sourceLabels).length;

  // Elapsed clock: hydration-safe (renders "—" until mounted), ticks every second
  // from startedAt while running, and freezes at the reported duration once done.
  const [mounted, setMounted] = useState(false);
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    setMounted(true);
    setNowMs(Date.now());
    if (terminal) return;
    const iv = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [terminal]);

  const startMs = tsToMs(run.startedAt);
  let elapsed = "—";
  if (mounted) {
    if (terminal && projection.stats) elapsed = mmss(projection.stats.durationMs);
    else if (startMs != null) elapsed = mmss(nowMs - startMs);
    else elapsed = "00:00";
  }

  function togglePause() {
    const kind = projection.status === "paused" ? "resume" : "pause";
    postRunInput(run.id, { kind }).catch(() => showToast("Could not reach the run."));
  }

  function runAgain() {
    createRun(blueprint.id)
      .then(({ id }) => router.push(`/runs/${id}`))
      .catch(() => showToast("Could not start a new run."));
  }

  const completedFraction = (() => {
    const sections = Object.values(projection.sections);
    const total = sections.length || sectionMeta.length;
    if (total === 0) return 0;
    return sections.filter((s) => s.state === "done").length / total;
  })();

  const center = (
    <div className="flex items-center gap-[16px]">
      <Link
        href={`/blueprints/${blueprint.id}`}
        className="font-sans text-[13px] text-ink/60"
      >
        ← Blueprint
      </Link>
      <span className="font-serif text-[14px] text-ink">
        {blueprint.name} — run #{shortId}
      </span>
      {projection.status === "complete" ? (
        <span className="rounded-full bg-ink px-[10px] py-[3px] font-mono text-[10px] tracking-[1px] text-paper">
          COMPLETE · {projection.flags.length} FLAGS
        </span>
      ) : (
        <span className="flex items-center gap-[6px] rounded-full border border-pencil px-[10px] py-[3px] font-mono text-[10px] tracking-[1px] text-pencil">
          <span
            className={`inline-block h-[6px] w-[6px] rounded-full ${
              connectionLost ? "bg-ink/30" : `bg-pencil${terminal ? "" : " blink"}`
            }`}
          />
          {projection.status === "paused" ? "PAUSED" : projection.phase || "STARTING"}
        </span>
      )}
    </div>
  );

  const right = (
    <div className="flex items-center gap-[16px] font-sans text-[12px] font-medium">
      <span className="font-mono text-[10.5px] tracking-[1px] text-ink/55">
        {elapsed} ELAPSED
      </span>
      {!terminal ? (
        <button
          type="button"
          onClick={togglePause}
          className="rounded-full border border-ink/30 px-[14px] py-[6px] text-ink"
        >
          {projection.status === "paused" ? "Resume run" : "Pause run"}
        </button>
      ) : null}
    </div>
  );

  return (
    <>
      <Topbar center={center} right={right} />

      {connectionLost ? (
        <div
          data-testid="connection-lost"
          className="bg-amber-accent/14 px-[40px] py-[8px] font-mono text-[10.5px] tracking-[1px] text-amber"
        >
          CONNECTION LOST — refresh to resume the live view
        </div>
      ) : null}

      {projection.status === "failed" ? (
        <div
          data-testid="failed-banner"
          className="flex items-center gap-[12px] bg-pencil/10 px-[40px] py-[10px] font-serif text-[13px] text-pencil"
        >
          <span className="italic">{projection.error ?? "The run failed."}</span>
          <button type="button" onClick={runAgain} className="underline">
            Run it again
          </button>
        </div>
      ) : (
        <div className="h-[3px] w-full bg-ink/10">
          <div
            className="h-full bg-ink"
            style={{ width: `${Math.round(completedFraction * 100)}%` }}
          />
        </div>
      )}

      <main className="mx-auto grid w-full max-w-[1360px] grid-cols-[248px_1fr_312px] gap-6 px-[40px] py-[28px]">
        <RunRail
          sectionMeta={sectionMeta}
          projection={projection}
          triggerKind={run.triggerKind}
          blueprintRev={run.blueprintRev}
          sourceCount={sourceCount}
          terminal={terminal}
          onRunAgain={runAgain}
        />

        <div className="flex flex-col items-center">
          <DocumentPage eyebrow={content.eyebrow} title={content.title} dateline={content.dateline}>
            {sectionMeta.map((m) => {
              const s = projection.sections[m.key];
              return (
                <LiveSection
                  key={m.key}
                  heading={m.heading}
                  state={s?.state ?? "queued"}
                  blocks={s?.blocks ?? []}
                  typedText={s?.typedText ?? ""}
                  sourceLabels={sourceLabels}
                />
              );
            })}
            {projection.phase === "RENDERING" ? (
              <div className="mt-[28px]">
                <Greeked lines={3} caption="rendering document…" />
              </div>
            ) : null}
          </DocumentPage>
        </div>

        <AgentDesk
          runId={run.id}
          projection={projection}
          sectionMeta={sectionMeta}
          terminal={terminal}
          onOpenReport={onOpenReport}
        />
      </main>
    </>
  );
}
