import type { RunProjection, SectionRunState } from "@runoff/core";
import type { SectionMeta } from "@/lib/api";

/**
 * The left "THIS RUN" rail: the same ToC geometry as the Builder, but each row's
 * glyph, weight, and trailing meta follow the section's live run state — done
 * rows show word count and retries, the writing row gets the wash + pencil spine,
 * queued rows stay faint. Below the list, a mono ledger of the run's trigger,
 * pinned revision, and source count; after a terminal run, a "Run it again" link.
 */
export function RunRail({
  sectionMeta,
  projection,
  triggerKind,
  blueprintRev,
  sourceCount,
  terminal,
  onRunAgain,
}: {
  sectionMeta: SectionMeta[];
  projection: RunProjection;
  triggerKind: string;
  blueprintRev: number;
  sourceCount: number;
  terminal: boolean;
  onRunAgain: () => void;
}) {
  return (
    <div className="flex flex-col gap-[2px]">
      <div className="mb-[12px] font-sans text-[9.5px] font-semibold uppercase tracking-[2.5px] text-ink/45">
        This run
      </div>

      {sectionMeta.map((m) => {
        const s = projection.sections[m.key];
        const state: SectionRunState = s?.state ?? "queued";
        return (
          <RailRow
            key={m.key}
            sectionKey={m.key}
            heading={m.heading}
            state={state}
            words={s?.words ?? 0}
            retries={s?.retries ?? 0}
          />
        );
      })}

      <div className="mt-[22px] flex flex-col gap-[4px] border-t border-ink/12 pt-[14px] font-mono text-[10.5px] text-ink/55">
        <div>TRIGGER — {triggerKind.toUpperCase()}</div>
        <div>BLUEPRINT — REV {blueprintRev}</div>
        <div>SOURCES — {sourceCount}</div>
      </div>

      {terminal ? (
        <button
          type="button"
          onClick={onRunAgain}
          className="mt-[14px] self-start font-serif text-[13px] italic text-ink/70 underline"
        >
          Run it again
        </button>
      ) : null}
    </div>
  );
}

function RailRow({
  sectionKey,
  heading,
  state,
  words,
  retries,
}: {
  sectionKey: string;
  heading: string;
  state: SectionRunState;
  words: number;
  retries: number;
}) {
  if (state === "done") {
    return (
      <div
        data-testid={`rail-row-${sectionKey}`}
        className="flex items-baseline gap-[10px] py-[7px]"
      >
        <span className="font-mono text-[11px] text-ink/45">✓</span>
        <span className="font-serif text-[14px] text-ink/55">{heading}</span>
        <span className="ml-auto font-mono text-[10px] text-ink/45">
          {words}w{retries > 0 ? ` · retry ${retries}` : ""}
        </span>
      </div>
    );
  }

  if (state === "writing") {
    return (
      <div
        data-testid={`rail-row-${sectionKey}`}
        className="-ml-[10px] flex items-baseline gap-[10px] border-l-2 border-pencil bg-wash py-[7px] pl-[8px]"
      >
        <span className="font-mono text-[11px] text-pencil">✎</span>
        <span className="font-serif text-[14px] text-ink">{heading}</span>
        <span className="ml-auto font-serif text-[12px] italic text-pencil">writing…</span>
      </div>
    );
  }

  if (state === "failed") {
    return (
      <div
        data-testid={`rail-row-${sectionKey}`}
        className="flex items-baseline gap-[10px] py-[7px]"
      >
        <span className="font-mono text-[11px] text-pencil">✕</span>
        <span className="font-serif text-[14px] text-pencil">{heading}</span>
        <span className="ml-auto font-serif text-[12px] italic text-pencil">failed</span>
      </div>
    );
  }

  return (
    <div
      data-testid={`rail-row-${sectionKey}`}
      className="flex items-baseline gap-[10px] py-[7px]"
    >
      <span className="font-mono text-[11px] text-ink/30">○</span>
      <span className="font-serif text-[14px] text-ink/45">{heading}</span>
    </div>
  );
}
