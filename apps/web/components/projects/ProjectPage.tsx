"use client";

import Link from "next/link";
import { Topbar } from "@/components/Topbar";
import { LibraryView } from "@/components/library/LibraryView";
import type { BlueprintListItem } from "@/lib/api";

/**
 * One project's workspace: the blueprint zone (embedding the LibraryView grid)
 * plus SOURCES and MEMORY zone placeholders that Tasks 6 and 11 fill in. The
 * server page supplies the project header and its scoped blueprint rows.
 */
export function ProjectPage({
  project,
  blueprints,
}: {
  project: { id: string; name: string; createdAt: string };
  blueprints: BlueprintListItem[];
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

        <ZoneStub
          heading="Sources"
          note="The smart source manager lands here — periodic families, filed periods, and freshness."
        />
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
