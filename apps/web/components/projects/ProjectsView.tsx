"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Topbar } from "@/components/Topbar";
import { showToast } from "@/components/Toast";
import { createProject, type ProjectListItem } from "@/lib/api";
import { fmtDate } from "@/lib/format";

/**
 * The home screen: the manuscript of projects. Each card links into a project's
 * workspace; an italic "+ new project…" row swaps to an inline name input,
 * POSTs a project, and routes into it. Server `app/page.tsx` supplies the rows.
 */
export function ProjectsView({ projects }: { projects: ProjectListItem[] }) {
  return (
    <>
      <Topbar tab="blueprints" />

      <main className="mx-auto w-full max-w-[1360px] px-10 pb-[34px] pt-7">
        <div className="flex items-baseline gap-[14px]">
          <h1 className="font-serif text-[30px] font-medium text-ink">Projects</h1>
          <span className="font-mono text-[11px] uppercase tracking-[2px] text-ink/50">
            {projects.length} {projects.length === 1 ? "PROJECT" : "PROJECTS"}
          </span>
        </div>

        <div className="mt-7 grid grid-cols-1 gap-[14px] sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
          <NewProjectCard />
        </div>
      </main>
    </>
  );
}

function ProjectCard({ project }: { project: ProjectListItem }) {
  const count = project.blueprintCount;
  const activity = fmtDate(project.lastActivityAt);
  const meta = `${count} ${count === 1 ? "blueprint" : "blueprints"}${
    activity ? ` · last activity ${activity}` : ""
  }`;
  return (
    <Link
      href={`/projects/${project.id}`}
      className="flex min-h-[104px] flex-col justify-between border border-ink/[0.14] bg-card px-[18px] py-[16px] transition-colors hover:border-ink/30"
    >
      <div className="font-serif text-[18px] font-medium text-ink">{project.name}</div>
      <div className="mt-2 font-mono text-[10.5px] uppercase tracking-[0.5px] text-ink/50">
        {meta}
      </div>
    </Link>
  );
}

function NewProjectCard() {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setEditing(false);
      setName("");
      return;
    }
    setBusy(true);
    try {
      const { id } = await createProject({ name: trimmed });
      router.push(`/projects/${id}`);
    } catch {
      setBusy(false);
      showToast("Couldn't create the project.");
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex min-h-[104px] items-center border border-dashed border-ink/20 px-[18px] py-[16px] text-left font-serif text-[15px] italic text-ink/45 transition-colors hover:border-ink/35 hover:text-ink/60"
      >
        + new project…
      </button>
    );
  }

  return (
    <div className="flex min-h-[104px] flex-col justify-center border border-ink/25 bg-card px-[18px] py-[16px]">
      <input
        autoFocus
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") {
            setEditing(false);
            setName("");
          }
        }}
        onBlur={() => void submit()}
        placeholder="Project name"
        aria-label="New project name"
        className="w-full border-b border-ink/25 bg-transparent pb-1 font-serif text-[16px] text-ink outline-none placeholder:italic placeholder:text-ink/40 focus:border-ink/50"
      />
      <span className="mt-2 font-mono text-[9.5px] uppercase tracking-[1px] text-ink/40">
        {busy ? "Creating…" : "Enter to create · Esc to cancel"}
      </span>
    </div>
  );
}
