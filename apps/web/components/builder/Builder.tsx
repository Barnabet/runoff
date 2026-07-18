"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { BlueprintContent, BlueprintSection } from "@runoff/core";
import { Topbar } from "@/components/Topbar";
import { showToast } from "@/components/Toast";
import {
  createRun,
  getBlueprint,
  patchBlueprint,
  saveRevision,
  type NoteRow,
  type SourceRow,
} from "@/lib/api";
import { ContentsRail } from "./ContentsRail";
import { SectionEditor } from "./SectionEditor";
import { MarginNotes } from "./MarginNotes";

/** A client-side section key — browsers can't import the server-only `newId`. */
function slugId(): string {
  const rand =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().replaceAll("-", "").slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `section_${rand}`;
}

export interface BuilderProps {
  blueprintId: string;
  name: string;
  clientName: string;
  initialStatus: string;
  initialRev: number;
  initialContent: BlueprintContent;
  allSources: SourceRow[];
  initialBoundIds: string[];
  initialSectionKey: string;
  initialNotes: NoteRow[];
}

/**
 * The Blueprint Builder root. Owns the editable `content` draft, the selected
 * section, the dirty flag, and the current revision; the three rails read that
 * state and mutate it through callbacks. Saves are explicit (a floating pill or
 * Cmd/Ctrl+S) and post a new revision.
 */
export function Builder({
  blueprintId,
  name,
  clientName,
  initialStatus,
  initialRev,
  initialContent,
  allSources,
  initialBoundIds,
  initialSectionKey,
  initialNotes,
}: BuilderProps) {
  const router = useRouter();
  const [content, setContent] = useState<BlueprintContent>(initialContent);
  const [selectedKey, setSelectedKey] = useState(initialSectionKey);
  const [dirty, setDirty] = useState(false);
  const [rev, setRev] = useState(initialRev);
  const [, setStatus] = useState(initialStatus);
  const [boundIds, setBoundIds] = useState<string[]>(initialBoundIds);

  // Refs keep the stable Cmd/Ctrl+S handler reading the latest draft.
  const contentRef = useRef(content);
  contentRef.current = content;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const labelFor = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of allSources) map[s.id] = s.name;
    return (id: string) => map[id] ?? id;
  }, [allSources]);

  function updateContent(next: BlueprintContent) {
    setContent(next);
    setDirty(true);
  }

  function addSection() {
    const nextNumber = content.sections.reduce((max, s) => Math.max(max, s.number), 0) + 1;
    const section: BlueprintSection = {
      key: slugId(),
      number: nextNumber,
      heading: "New section",
      mode: "auto",
      instruction: "",
      sourceIds: [],
      rules: [],
    };
    updateContent({ ...content, sections: [...content.sections, section] });
    setSelectedKey(section.key);
  }

  async function save(): Promise<void> {
    const { rev: newRev } = await saveRevision(blueprintId, contentRef.current);
    setRev(newRev);
    setDirty(false);
    showToast(`Saved as REV ${newRev}`);
  }

  async function previewRun() {
    if (dirtyRef.current) await save();
    const { id } = await createRun(blueprintId);
    router.push(`/runs/${id}`);
  }

  async function publish() {
    if (dirtyRef.current) await save();
    await patchBlueprint(blueprintId, { status: "active" });
    setStatus("active");
    showToast("Published");
  }

  function changeBoundIds(ids: string[]) {
    setBoundIds(ids);
    patchBlueprint(blueprintId, { sourceIds: ids }).catch(() =>
      showToast("Could not update sources."),
    );
  }

  async function reloadContent() {
    const res = await getBlueprint(blueprintId);
    if (res.content) setContent(res.content);
    setRev(res.blueprint.currentRev);
    setBoundIds(res.sources.map((s) => s.id));
    setDirty(false);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (dirtyRef.current) void save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedHeading = content.sections.find((s) => s.key === selectedKey)?.heading ?? "";

  const center = (
    <div className="flex items-center gap-4">
      <Link href="/" className="font-sans text-[13px] text-ink/60">
        ← Blueprints
      </Link>
      <span className="text-[13px] text-ink">
        {clientName} — <b className="font-semibold">{name}</b>
      </span>
      <span className="rounded-full border border-amber/40 px-[8px] py-[3px] font-mono text-[8.5px] font-medium tracking-[1px] text-amber">
        DRAFT · REV {rev}
      </span>
    </div>
  );

  const right = (
    <div className="flex items-center gap-[18px] font-sans text-[12.5px] font-medium">
      <button
        type="button"
        onClick={() => showToast("Revision history coming soon")}
        className="text-ink/60"
      >
        History
      </button>
      <Link href="/sources" className="text-ink/60">
        Sources
      </Link>
      <button
        type="button"
        onClick={() => void previewRun()}
        className="rounded-full border border-ink/30 px-[14px] py-[7px] text-ink"
      >
        Preview run
      </button>
      <button
        type="button"
        onClick={() => void publish()}
        className="rounded-full bg-ink px-[16px] py-[8px] text-paper"
      >
        Publish
      </button>
    </div>
  );

  return (
    <>
      <Topbar center={center} right={right} />
      <main className="mx-auto grid w-full max-w-[1360px] grid-cols-[248px_1fr_312px] gap-6 px-[40px] py-[28px]">
        <ContentsRail
          content={content}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
          onAddSection={addSection}
          allSources={allSources}
          boundIds={boundIds}
          onBoundIdsChange={changeBoundIds}
        />

        <div className="relative flex flex-col items-center">
          <SectionEditor
            content={content}
            selectedKey={selectedKey}
            onChange={updateContent}
            onSelect={setSelectedKey}
            labelFor={labelFor}
          />
          {dirty ? (
            <button
              type="button"
              onClick={() => void save()}
              className="sticky bottom-6 z-10 mt-6 self-end rounded-full bg-ink px-[16px] py-[8px] font-sans text-[12px] font-medium text-paper shadow-lg"
            >
              Save · REV {rev + 1}
            </button>
          ) : null}
        </div>

        <MarginNotes
          blueprintId={blueprintId}
          sectionKey={selectedKey}
          sectionHeading={selectedHeading}
          initialSectionKey={initialSectionKey}
          initialNotes={initialNotes}
          onRevChange={setRev}
          reloadContent={reloadContent}
        />
      </main>
    </>
  );
}
