"use client";

import { useEffect, useRef, useState } from "react";
import { showToast } from "@/components/Toast";
import { acceptNote, getNotes, postNote, resolveNote, type NoteRow } from "@/lib/api";
import { fmtRel } from "@/lib/format";
import { PencilEdit } from "./PencilEdit";

const CANNED_REVIEW = "Review this section's instruction against its rules and propose improvements.";

function isActionable(note: NoteRow): boolean {
  return note.author === "agent" && note.proposedEdit != null && note.status === "open";
}

function NoteCard({
  note,
  heading,
  onAccept,
  onDismiss,
}: {
  note: NoteRow;
  heading: string;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const agent = note.author === "agent";
  const actionable = isActionable(note);
  const cardClass = agent
    ? "border border-ink/14 border-t-2 border-t-pencil bg-card shadow-[0_1px_6px_rgba(32,26,21,0.06)]"
    : "border border-ink/14 bg-wash";
  return (
    <div className={`${cardClass} px-[14px] py-[13px]`}>
      <div className="flex items-center gap-[8px]">
        <span
          className={
            agent
              ? "flex h-[20px] w-[20px] items-center justify-center rounded-full bg-ink font-serif text-[11px] font-medium italic text-paper"
              : "flex h-[20px] w-[20px] items-center justify-center rounded-full border border-ink/40 font-serif text-[11px] font-medium italic text-ink"
          }
        >
          {agent ? "R" : "L"}
        </span>
        <span className="font-sans text-[11.5px] font-semibold text-ink">
          {agent ? "Agent" : "You"}
        </span>
        <span className="font-mono text-[10px] text-ink/45">
          ¶ {heading} · {fmtRel(note.createdAt) || "now"}
        </span>
      </div>
      <div className="mt-[9px] font-serif text-[13px] leading-[1.6] text-ink">{note.body}</div>
      {note.proposedEdit ? <PencilEdit edit={note.proposedEdit} /> : null}
      {actionable ? (
        <div className="mt-[11px] flex gap-[8px] font-sans text-[11px] font-medium">
          <button
            type="button"
            onClick={onAccept}
            className="rounded-full bg-ink px-[13px] py-[6px] text-paper"
          >
            Accept
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-full border border-ink/30 px-[13px] py-[5px] text-ink"
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The right rail: the agent's margin conversation for the selected section.
 * Fetches the thread on every section switch, renders agent/user cards (agent
 * cards with a proposed edit expose Accept/Dismiss), and posts new notes with an
 * optimistic user card while the agent is "annotating".
 */
export function MarginNotes({
  blueprintId,
  sectionKey,
  sectionHeading,
  initialSectionKey,
  initialNotes,
  onRevChange,
  reloadContent,
}: {
  blueprintId: string;
  sectionKey: string;
  sectionHeading: string;
  initialSectionKey: string;
  initialNotes: NoteRow[];
  onRevChange: (rev: number) => void;
  reloadContent: () => Promise<void>;
}) {
  const [notes, setNotes] = useState<NoteRow[]>(initialNotes);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const seededRef = useRef(false);

  useEffect(() => {
    if (!sectionKey) {
      setNotes([]);
      return;
    }
    // Reuse the server-seeded thread for the section we first landed on; fetch
    // fresh for every other section (and on any later switch back).
    if (!seededRef.current && sectionKey === initialSectionKey) {
      seededRef.current = true;
      setNotes(initialNotes);
      return;
    }
    seededRef.current = true;
    let cancelled = false;
    getNotes(blueprintId, sectionKey)
      .then((r) => {
        if (!cancelled) setNotes(r.notes);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [blueprintId, sectionKey, initialSectionKey, initialNotes]);

  function refetch() {
    return getNotes(blueprintId, sectionKey)
      .then((r) => setNotes(r.notes))
      .catch(() => {});
  }

  function postBody(body: string) {
    const temp: NoteRow = {
      id: `temp_${Date.now()}`,
      author: "user",
      body,
      proposedEdit: null,
      status: "open",
      createdAt: new Date().toISOString(),
    };
    setNotes((prev) => [...prev, temp]);
    setSending(true);
    postNote(blueprintId, { sectionKey, body })
      .then(({ agentNote }) => setNotes((prev) => [...prev, agentNote]))
      .catch(() => showToast("Could not reach the agent."))
      .finally(() => setSending(false));
  }

  function send() {
    const body = draft.trim();
    if (!body) {
      showToast("Type a note first.");
      return;
    }
    setDraft("");
    postBody(body);
  }

  function onAccept(note: NoteRow) {
    acceptNote(note.id)
      .then(({ rev }) => {
        onRevChange(rev);
        showToast(`Edit applied — REV ${rev}`);
        return reloadContent();
      })
      .then(refetch)
      .catch((err) => showToast(err instanceof Error ? err.message : "Could not apply the edit."));
  }

  function onDismiss(note: NoteRow) {
    resolveNote(note.id).then(refetch).catch(() => {});
  }

  const openCount = notes.filter(isActionable).length;

  return (
    <div className="flex h-full flex-col gap-[12px]">
      <div className="flex items-baseline justify-between">
        <span className="font-sans text-[9.5px] font-semibold uppercase tracking-[2.5px] text-ink/45">
          Margin notes
        </span>
        {openCount > 0 ? (
          <span className="font-mono text-[10px] text-pencil">{openCount} OPEN</span>
        ) : null}
      </div>

      <div className="-mt-[6px] font-serif text-[11.5px] italic text-ink/55">
        <span className="text-pencil/70 line-through">struck</span> = removal ·{" "}
        <span className="border-b-2 border-pencil">underline</span> = insertion
      </div>

      <div className="flex flex-col gap-[12px]">
        {notes.map((note) => (
          <NoteCard
            key={note.id}
            note={note}
            heading={sectionHeading}
            onAccept={() => onAccept(note)}
            onDismiss={() => onDismiss(note)}
          />
        ))}
        {sending ? (
          <div className="font-serif text-[12px] italic text-ink/50">Agent is annotating…</div>
        ) : null}
      </div>

      <div className="flex items-center rounded-[2px] border border-ink/30 bg-card/60 py-[6px] pl-[12px] pr-[6px]">
        <input
          aria-label="note to the agent"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Note to the agent about this section…"
          className="min-w-0 flex-1 bg-transparent font-serif text-[13px] italic text-ink outline-none placeholder:text-ink/45"
        />
        <button
          type="button"
          onClick={send}
          className="flex-none rounded-full border border-ink/30 px-[10px] py-[4px] font-sans text-[10px] font-medium text-ink"
        >
          Send
        </button>
      </div>

      <button
        type="button"
        onClick={() => postBody(CANNED_REVIEW)}
        className="text-left font-sans text-[11px] font-medium text-ink/60 underline"
      >
        Review this section
      </button>
    </div>
  );
}
