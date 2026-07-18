"use client";

import { useMemo, useState } from "react";
import { Topbar } from "@/components/Topbar";
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
 * The Library home screen. Owns the search + cadence-filter state and composes
 * the review queue (all flagged blueprints) with the client-filtered ledger.
 * Rendered by the server `app/page.tsx`, which supplies the joined rows.
 */
export function LibraryView({ blueprints }: { blueprints: BlueprintListItem[] }) {
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
    <>
      <Topbar
        tab="blueprints"
        right={
          <div className="flex items-center gap-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search blueprints…"
              aria-label="Search blueprints"
              className="w-[200px] rounded-full border border-ink/25 px-4 py-[7px] font-serif text-[13px] text-ink outline-none placeholder:italic placeholder:text-ink/45 focus:border-ink/40"
            />
            <NewBlueprintButton />
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-ink font-serif text-[13px] font-medium italic text-paper">
              L
            </div>
          </div>
        }
      />

      <main className="mx-auto w-full max-w-[1360px] px-10 pb-[34px] pt-7">
        <div className="flex items-baseline gap-[14px]">
          <h1 className="font-serif text-[30px] font-medium text-ink">Blueprints</h1>
          <span className="font-mono text-[11px] text-ink/50">
            {activeCount} ACTIVE · {awaitReview} AWAIT REVIEW
          </span>
          <div className="ml-auto flex gap-[7px] font-sans text-[11.5px] font-medium">
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
      </main>
    </>
  );
}
