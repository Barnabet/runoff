"use client";

import { useMemo, useState } from "react";
import { showToast } from "@/components/Toast";
import type { BlueprintListItem } from "@/lib/api";
import { ReviewQueue } from "./ReviewQueue";
import { BlueprintLedger } from "./BlueprintLedger";
import { NewBlueprintButton } from "./NewBlueprintButton";

type Filter = "all" | "monthly" | "weekly" | "quarterly" | "drafts";

const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["monthly", "Monthly"],
  ["weekly", "Weekly"],
  ["quarterly", "Quarterly"],
  ["drafts", "Drafts"],
];

/**
 * The blueprint zone of a project page: owns the search + cadence-filter state
 * and composes the review queue (all flagged blueprints in the project) with the
 * client-filtered ledger. Embedded by `components/projects/ProjectPage.tsx`,
 * which supplies the project-scoped rows and the `projectId` new blueprints are
 * created under.
 */
export function LibraryView({
  blueprints,
  projectId,
}: {
  blueprints: BlueprintListItem[];
  projectId: string;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const activeCount = blueprints.filter((b) => b.status === "active").length;
  const awaitReview = blueprints.filter((b) => (b.lastRun?.openFlags ?? 0) > 0).length;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return blueprints.filter((b) => {
      const matchesFilter =
        filter === "all"
          ? true
          : filter === "drafts"
            ? b.status === "draft"
            : b.cadenceLabel.toLowerCase().startsWith(filter);
      const matchesSearch =
        !q ||
        b.name.toLowerCase().includes(q) ||
        b.clientName.toLowerCase().includes(q);
      return matchesFilter && matchesSearch;
    });
  }, [blueprints, search, filter]);

  return (
    <section className="mt-9">
      <div className="flex items-baseline gap-[14px]">
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[2px] text-ink/50">
          Blueprints
        </h2>
        <span className="font-mono text-[11px] text-ink/50">
          {activeCount} ACTIVE · {awaitReview} AWAIT REVIEW
        </span>
        <div className="ml-auto flex items-center gap-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search blueprints…"
            aria-label="Search blueprints"
            className="w-[200px] rounded-full border border-ink/25 px-4 py-[7px] font-serif text-[13px] text-ink outline-none placeholder:italic placeholder:text-ink/45 focus:border-ink/40"
          />
          <NewBlueprintButton projectId={projectId} />
        </div>
      </div>

      <div className="mt-[14px] flex gap-[7px] font-sans text-[11.5px] font-medium">
        {FILTERS.map(([key, label]) => {
          const on = filter === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              aria-pressed={on}
              className={
                on
                  ? "rounded-full bg-ink px-[13px] py-[5px] text-paper"
                  : "rounded-full border border-ink/25 px-[13px] py-1 text-ink/60"
              }
            >
              {label}
            </button>
          );
        })}
      </div>

      <ReviewQueue blueprints={blueprints} />
      <BlueprintLedger blueprints={filtered} />

      <div
        onClick={() => showToast("Blueprint import coming soon")}
        className="mt-4 cursor-pointer font-serif text-[13px] italic text-ink/45"
      >
        Start from a past report — drop any PDF or DOCX here and the agent will
        reverse-engineer it into a blueprint.
      </div>
    </section>
  );
}
