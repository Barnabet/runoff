"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { BlueprintContent, BlueprintSection, EditOp } from "@runoff/core";
import { Topbar } from "@/components/Topbar";
import { showToast } from "@/components/Toast";
import {
  createRun,
  patchBlueprint,
  saveRevision,
  type SourceRow,
} from "@/lib/api";
import { applyEditOp } from "@/lib/editOps";
import { ContentsRail } from "./ContentsRail";
import { SectionEditor } from "./SectionEditor";
import { CopilotRail } from "./CopilotRail";

/** Best-effort human message from a rejected API promise. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
  projectId: string;
  projectName: string;
  initialStatus: string;
  initialRev: number;
  initialContent: BlueprintContent;
  allSources: SourceRow[];
  initialBoundIds: string[];
  initialSectionKey: string;
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
  projectId,
  projectName,
  initialStatus,
  initialRev,
  initialContent,
  allSources,
  initialBoundIds,
  initialSectionKey,
}: BuilderProps) {
  const router = useRouter();
  const [content, setContent] = useState<BlueprintContent>(initialContent);
  const [selectedKey, setSelectedKey] = useState(initialSectionKey);
  const [dirty, setDirty] = useState(false);
  const [rev, setRev] = useState(initialRev);
  const [status, setStatus] = useState(initialStatus);
  const [boundIds, setBoundIds] = useState<string[]>(initialBoundIds);
  const [touched, setTouched] = useState<Set<string>>(new Set());

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
      familyIds: [],
      rules: [],
    };
    updateContent({ ...content, sections: [...content.sections, section] });
    setSelectedKey(section.key);
  }

  // Throws on failure so callers can abort; `dirty` only clears once the write
  // resolves, so a rejected save leaves the draft dirty and re-savable.
  async function save(): Promise<void> {
    const { rev: newRev } = await saveRevision(blueprintId, contentRef.current);
    setRev(newRev);
    setDirty(false);
    showToast(`Saved as REV ${newRev}`);
  }

  // The direct-save affordances (pill, Cmd/Ctrl+S) surface their own errors.
  function runSave() {
    save().catch((err) => showToast(`Save failed — ${errMsg(err)}`));
  }

  async function previewRun() {
    try {
      if (dirtyRef.current) await save();
      const { id } = await createRun(blueprintId);
      router.push(`/runs/${id}`);
    } catch (err) {
      showToast(`Could not start preview run — ${errMsg(err)}`);
    }
  }

  async function publish() {
    try {
      if (dirtyRef.current) await save();
      await patchBlueprint(blueprintId, { status: "active" });
      setStatus("active");
      showToast("Published");
    } catch (err) {
      showToast(`Publish failed — ${errMsg(err)}`);
    }
  }

  function changeBoundIds(ids: string[]) {
    setBoundIds(ids);
    patchBlueprint(blueprintId, { sourceIds: ids }).catch(() =>
      showToast("Could not update sources."),
    );
  }

  // A copilot edit op applies to the client draft (marking it dirty, like any
  // manual edit) and briefly flashes the fields it touched so the change is
  // visible in the center editor.
  function handleEditOp(op: EditOp) {
    setContent((prev) => applyEditOp(prev, op));
    setDirty(true);
    const keys =
      op.type === "edit_section" ? Object.keys(op.after).map((f) => `${op.key}.${f}`)
      : op.type === "add_section" ? [`${op.section.key}.*`]
      : [];
    if (keys.length) {
      setTouched(new Set(keys));
      setTimeout(() => setTouched(new Set()), 2500);
    }
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (dirtyRef.current) runSave();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedHeading = content.sections.find((s) => s.key === selectedKey)?.heading ?? "";

  const center = (
    <div className="flex items-center gap-4">
      <Link href={`/projects/${projectId}`} className="font-sans text-[13px] text-ink/60">
        ← {projectName || "Project"}
      </Link>
      <span className="text-[13px] text-ink">
        {clientName} — <b className="font-semibold">{name}</b>
      </span>
      <span
        className={`rounded-full border px-[8px] py-[3px] font-mono text-[8.5px] font-medium tracking-[1px] ${
          status === "active" ? "border-ink/20 text-ink/45" : "border-amber/40 text-amber"
        }`}
      >
        {status === "active" ? "ACTIVE" : "DRAFT"} · REV {rev}
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
            touched={touched}
          />
          {dirty ? (
            <button
              type="button"
              onClick={runSave}
              className="sticky bottom-6 z-10 mt-6 self-end rounded-full bg-ink px-[16px] py-[8px] font-sans text-[12px] font-medium text-paper shadow-lg"
            >
              Save · REV {rev + 1}
            </button>
          ) : null}
        </div>

        <CopilotRail
          blueprintId={blueprintId}
          selectedKey={selectedKey}
          selectedHeading={selectedHeading}
          getDraft={() => contentRef.current}
          onEditOp={handleEditOp}
        />
      </main>
    </>
  );
}
