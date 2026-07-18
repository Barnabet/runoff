"use client";

import { useState } from "react";
import Link from "next/link";
import type { MemoryRow, ProjectSourceRow } from "@runoff/core";
import { Topbar } from "@/components/Topbar";
import { LibraryView } from "@/components/library/LibraryView";
import { SourceManager } from "@/components/projects/SourceManager";
import { patchMemory } from "@/lib/api";
import type { BlueprintListItem, FamilySummary } from "@/lib/api";

/**
 * One project's workspace: the blueprint zone (embedding the LibraryView grid),
 * the SOURCES zone (the smart source manager) and the MEMORY zone (project-scoped
 * standing guidance the copilot and runs learn). The server page supplies the
 * project header, its scoped blueprint rows, its source families + unfiled
 * uploads, and its project-scoped memories.
 */
export function ProjectPage({
  project,
  blueprints,
  families,
  unfiled,
  memories,
}: {
  project: { id: string; name: string; createdAt: string };
  blueprints: BlueprintListItem[];
  families: FamilySummary[];
  unfiled: ProjectSourceRow[];
  memories: MemoryRow[];
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

        <MemoryZone memories={memories} />
      </main>
    </>
  );
}

/** The project's standing guidance: body (serif) with a source + date mono line and a disable/enable toggle. */
function MemoryZone({ memories: initial }: { memories: MemoryRow[] }) {
  const [memories, setMemories] = useState<MemoryRow[]>(initial);

  const toggle = (m: MemoryRow) => {
    const next = m.status === "active" ? "disabled" : "active";
    patchMemory(m.id, next)
      .then(() => setMemories((cur) => cur.map((x) => (x.id === m.id ? { ...x, status: next } : x))))
      .catch(() => {});
  };

  return (
    <section className="mt-9">
      <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[2px] text-ink/50">Memory</h2>
      {memories.length === 0 ? (
        <div className="mt-3 border border-dashed border-ink/20 bg-card/40 px-4 py-[18px] font-serif text-[13px] italic text-ink/45">
          Standing guidance for this project will collect here as the copilot and runs learn it.
        </div>
      ) : (
        <div className="mt-3 border border-ink/12 bg-card/40">
          {memories.map((m) => (
            <div key={m.id} className="border-b border-ink/10 px-4 py-3 last:border-b-0">
              <p className={`font-serif text-[13px] leading-[1.5] ${m.status === "disabled" ? "text-ink/35 line-through" : "text-ink"}`}>
                {m.body}
              </p>
              <div className="mt-1 flex items-center gap-3 font-mono text-[8.5px] uppercase tracking-[1px] text-ink/35">
                <span>{m.source}</span>
                <span>{m.createdAt.slice(0, 10)}</span>
                <button type="button" className="text-ink/60" onClick={() => toggle(m)}>
                  {m.status === "active" ? "disable" : "enable"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
