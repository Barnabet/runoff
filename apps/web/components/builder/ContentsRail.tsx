"use client";

import { useState } from "react";
import type { BlueprintContent, BlueprintSection } from "@runoff/core";
import type { SourceRow } from "@/lib/api";
import { fmtRel, isStale } from "@/lib/format";

/** The badge shown at the right of a ToC row, derived from the section's mode. */
function sectionBadge(section: BlueprintSection): { label: string; review: boolean } {
  if (section.mode === "fixed") return { label: "FIXED", review: false };
  if (section.mode === "review") return { label: "REVIEW", review: true };
  // auto: surface the bound-source count when it carries sources, else AUTO.
  if (section.familyIds.length > 0) return { label: `${section.familyIds.length} SRC`, review: false };
  return { label: "AUTO", review: false };
}

function Badge({ label, review }: { label: string; review: boolean }) {
  const tone = review ? "border-pencil text-pencil" : "border-ink/20 text-ink/45";
  return (
    <span
      className={`ml-auto rounded-[3px] border px-[5px] py-[2px] font-mono text-[8.5px] font-medium tracking-[1px] ${tone}`}
    >
      {label}
    </span>
  );
}

/**
 * The left ToC rail: numbered section rows with mode badges, an add-section
 * affordance, and a bound-source mini-list pinned to the bottom that expands
 * into a checkbox binding editor over every connected source.
 */
export function ContentsRail({
  content,
  selectedKey,
  onSelect,
  onAddSection,
  allSources,
  boundIds,
  onBoundIdsChange,
}: {
  content: BlueprintContent;
  selectedKey: string;
  onSelect: (key: string) => void;
  onAddSection: () => void;
  allSources: SourceRow[];
  boundIds: string[];
  onBoundIdsChange: (ids: string[]) => void;
}) {
  const [editingSources, setEditingSources] = useState(false);
  const bound = allSources.filter((s) => boundIds.includes(s.id));

  function toggle(id: string) {
    const next = boundIds.includes(id) ? boundIds.filter((x) => x !== id) : [...boundIds, id];
    onBoundIdsChange(next);
  }

  return (
    <div className="flex flex-col gap-[2px]">
      <div className="mb-[12px] font-sans text-[9.5px] font-semibold uppercase tracking-[2.5px] text-ink/45">
        Contents
      </div>

      {content.sections.map((section) => {
        const selected = section.key === selectedKey;
        const badge = sectionBadge(section);
        return (
          <button
            type="button"
            key={section.key}
            data-testid={`toc-row-${section.key}`}
            aria-current={selected}
            onClick={() => onSelect(section.key)}
            className={`flex items-baseline gap-[10px] py-[7px] text-left ${
              selected ? "-ml-[10px] border-l-2 border-pencil bg-wash pl-[8px]" : ""
            }`}
          >
            <span className="font-mono text-[10px] text-ink/40">
              {String(section.number).padStart(2, "0")}
            </span>
            <span className="font-serif text-[14px] text-ink">{section.heading}</span>
            <Badge label={badge.label} review={badge.review} />
          </button>
        );
      })}

      <button
        type="button"
        onClick={onAddSection}
        className="py-[10px] text-left font-serif text-[13px] italic text-ink/50"
      >
        + add a section…
      </button>

      <div className="mt-auto border-t border-ink/12 pr-[18px] pt-[14px]">
        <button
          type="button"
          onClick={() => setEditingSources((v) => !v)}
          className="mb-[10px] mt-[4px] block font-sans text-[9.5px] font-semibold uppercase tracking-[2.5px] text-ink/45"
        >
          Sources
        </button>

        {editingSources ? (
          <div className="flex flex-col gap-[6px]">
            {allSources.length === 0 ? (
              <div className="font-serif text-[12px] italic text-ink/45">No sources connected.</div>
            ) : (
              allSources.map((s) => (
                <label
                  key={s.id}
                  className="flex cursor-pointer items-center gap-[7px] font-mono text-[10.5px] text-ink/70"
                >
                  <input
                    type="checkbox"
                    checked={boundIds.includes(s.id)}
                    onChange={() => toggle(s.id)}
                    aria-label={s.name}
                  />
                  {s.name}
                </label>
              ))
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-[6px] font-mono text-[10.5px] text-ink/70">
            {bound.length === 0 ? (
              <div className="font-serif text-[12px] italic text-ink/45">No sources bound.</div>
            ) : (
              bound.map((s) => {
                const ts = s.uploadedAt;
                const stale = isStale(ts);
                return (
                  <div key={s.id}>
                    {s.name}{" "}
                    <span className={stale ? "text-amber" : "text-ink/40"}>
                      — {fmtRel(ts)}
                      {stale ? " stale" : ""}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    </div>
  );
}
