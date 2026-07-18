"use client";

import { useState } from "react";
import type { BlueprintContent, BlueprintSection } from "@runoff/core";
import type { FamilySummary } from "@/lib/api";

/** The badge shown at the right of a ToC row, derived from the section's mode. */
function sectionBadge(section: BlueprintSection): { label: string; review: boolean } {
  if (section.mode === "fixed") return { label: "FIXED", review: false };
  if (section.mode === "review") return { label: "REVIEW", review: true };
  // auto: surface the bound-family count when it carries sources, else AUTO.
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

/** The mono granularity/kind tag for a family (e.g. `quarter`, `constant`). */
function familyTag(f: FamilySummary): string {
  return f.kind === "constant" ? "constant" : (f.granularity ?? "periodic");
}

/**
 * The left ToC rail: numbered section rows with mode badges, an add-section
 * affordance, and a bound-family binder pinned to the bottom. When nothing is
 * bound the binder offers a discoverable `+ bind sources…` affordance; edit mode
 * exposes one checkbox per project family and disables periodic families whose
 * granularity would clash with an already-ticked one.
 */
export function ContentsRail({
  content,
  selectedKey,
  onSelect,
  onAddSection,
  families,
  boundIds,
  onBoundIdsChange,
  bindError,
}: {
  content: BlueprintContent;
  selectedKey: string;
  onSelect: (key: string) => void;
  onAddSection: () => void;
  families: FamilySummary[];
  boundIds: string[];
  onBoundIdsChange: (ids: string[]) => void;
  bindError?: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const bound = families.filter((f) => boundIds.includes(f.id));

  // The single granularity already anchored by a ticked periodic family; any
  // periodic family of a different granularity is then locked out.
  const activeGran = bound.find((f) => f.kind === "periodic" && f.granularity)?.granularity ?? null;

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
        <div className="mb-[10px] mt-[4px] font-sans text-[9.5px] font-semibold uppercase tracking-[2.5px] text-ink/45">
          Sources
        </div>

        {editing ? (
          <div className="flex flex-col gap-[6px]">
            {families.length === 0 ? (
              <div className="font-serif text-[12px] italic text-ink/45">No families in this project.</div>
            ) : (
              families.map((f) => {
                const checked = boundIds.includes(f.id);
                const locked =
                  !checked &&
                  f.kind === "periodic" &&
                  !!f.granularity &&
                  !!activeGran &&
                  f.granularity !== activeGran;
                return (
                  <label
                    key={f.id}
                    className={`flex cursor-pointer items-center gap-[7px] font-mono text-[10.5px] ${
                      locked ? "text-ink/30" : "text-ink/70"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={locked}
                      onChange={() => toggle(f.id)}
                      aria-label={f.key}
                    />
                    <span>{f.key}</span>
                    <span className="text-ink/40">{familyTag(f)}</span>
                    {locked ? (
                      <span className="ml-auto font-mono text-[9px] text-ink/40">— granularity differs</span>
                    ) : null}
                  </label>
                );
              })
            )}
            {bindError ? (
              <div className="font-serif text-[11.5px] italic text-pencil">{bindError}</div>
            ) : null}
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="mt-[2px] text-left font-serif text-[12px] italic text-ink/50"
            >
              done
            </button>
          </div>
        ) : bound.length === 0 ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-left font-serif text-[13px] italic text-ink/50"
          >
            + bind sources…
          </button>
        ) : (
          <div className="flex flex-col gap-[6px]">
            {bound.map((f) => (
              <div key={f.id} className="font-mono text-[10.5px] text-ink/70">
                {f.key} <span className="text-ink/40">{familyTag(f)}</span>
              </div>
            ))}
            {bindError ? (
              <div className="font-serif text-[11.5px] italic text-pencil">{bindError}</div>
            ) : null}
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="mt-[2px] text-left font-serif text-[12px] italic text-ink/50"
            >
              edit bindings…
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
