"use client";

import Link from "next/link";
import type { ProjectSourceRow } from "@runoff/core";
import { Topbar } from "@/components/Topbar";
import { LibraryView } from "@/components/library/LibraryView";
import { SourceManager } from "@/components/projects/SourceManager";
import type { BlueprintListItem, FamilySummary } from "@/lib/api";

/**
 * One project's workspace: the blueprint zone (embedding the LibraryView grid),
 * the SOURCES zone (the smart source manager) and a MEMORY zone placeholder that
 * Task 11 fills in. The server page supplies the project header, its scoped
 * blueprint rows, and the project's source families + unfiled uploads.
 */
export function ProjectPage({
  project,
  blueprints,
  families,
  unfiled,
}: {
  project: { id: string; name: string; createdAt: string };
  blueprints: BlueprintListItem[];
  families: FamilySummary[];
  unfiled: ProjectSourceRow[];
}) {
  return (
    <>
      <Topbar
        center={
          <span className="font-serif text-[15px] font-semibold text-ink">{project.name}</span>
        }
      />

      <main className="mx-auto w-full max-w-[1360px] px-10 pb-[34px] pt-7">
        <Link href="/" className="font-mono text-[11px] text-ink/50 hover:text-ink">
          ← Projects
        </Link>
        <h1 className="mt-2 font-serif text-[30px] font-medium text-ink">{project.name}</h1>

        <LibraryView blueprints={blueprints} projectId={project.id} />

        <SourceManager projectId={project.id} families={families} unfiled={unfiled} />

        <ZoneStub
          heading="Memory"
          note="Standing guidance for this project will collect here as the copilot and runs learn it."
        />
      </main>
    </>
  );
}

/** A placeholder project zone: a mono heading over an italic serif note. */
function ZoneStub({ heading, note }: { heading: string; note: string }) {
  return (
    <section className="mt-9">
      <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[2px] text-ink/50">
        {heading}
      </h2>
      <div className="mt-3 border border-dashed border-ink/20 bg-card/40 px-4 py-[18px] font-serif text-[13px] italic text-ink/45">
        {note}
      </div>
    </section>
  );
}
