"use client";

import { useRef, useState } from "react";
import type { ClassifyProposal, Granularity, ProjectSourceRow } from "@runoff/core";
// `formatPeriod`/`PERIOD_REGEX` are VALUES: deep-import from the source module —
// the `@runoff/core` barrel pulls better-sqlite3 into the client bundle.
import { formatPeriod, PERIOD_REGEX } from "@runoff/core/src/types/sources.js";
import {
  classifySources,
  confirmSource,
  deleteProjectSource,
  getProjectSources,
  refileSource,
  uploadProjectSources,
  type FamilySummary,
} from "@/lib/api";

const NEW_FAMILY = "__new__";

interface NewFamilyDraft {
  key: string;
  label: string;
  kind: "periodic" | "constant";
  granularity: Granularity | null;
}

interface ChipEdit {
  familyValue: string; // a family id, "__new__", or "" (unchosen)
  period: string;
  newFamily: NewFamilyDraft;
}

/**
 * Enumerate every canonical period from `from` to `to` inclusive, inferring the
 * granularity from the shape of `from`. Used to render in-range gaps in a
 * periodic family's filed timeline. Exported for the UI test.
 */
export function enumeratePeriods(from: string, to: string): string[] {
  if (PERIOD_REGEX.quarter.test(from)) {
    let y = Number(from.slice(0, 4));
    let q = Number(from.slice(6));
    const ty = Number(to.slice(0, 4));
    const tq = Number(to.slice(6));
    const out: string[] = [];
    while (y < ty || (y === ty && q <= tq)) {
      out.push(`${y}-Q${q}`);
      if (++q > 4) { q = 1; y += 1; }
    }
    return out;
  }
  if (PERIOD_REGEX.month.test(from)) {
    let y = Number(from.slice(0, 4));
    let m = Number(from.slice(5));
    const ty = Number(to.slice(0, 4));
    const tm = Number(to.slice(5));
    const out: string[] = [];
    while (y < ty || (y === ty && m <= tm)) {
      out.push(`${y}-${String(m).padStart(2, "0")}`);
      if (++m > 12) { m = 1; y += 1; }
    }
    return out;
  }
  if (PERIOD_REGEX.year.test(from)) {
    const out: string[] = [];
    for (let y = Number(from); y <= Number(to); y += 1) out.push(String(y));
    return out;
  }
  return [from];
}

function emptyDraft(): NewFamilyDraft {
  return { key: "", label: "", kind: "periodic", granularity: "quarter" };
}

/** Seed a chip's editable state from its classifier proposal (if any). */
function deriveEdit(row: ProjectSourceRow, families: FamilySummary[]): ChipEdit {
  const p = row.proposal;
  if (p?.newFamily) {
    return {
      familyValue: NEW_FAMILY,
      period: p.period ?? "",
      newFamily: { ...p.newFamily },
    };
  }
  if (p) {
    const match = families.find((f) => f.key === p.familyKey);
    return { familyValue: match?.id ?? "", period: p.period ?? "", newFamily: emptyDraft() };
  }
  return { familyValue: "", period: "", newFamily: emptyDraft() };
}

/** Is the chip's target slot already occupied? Returns the occupant label, else null. */
function occupiedBy(edit: ChipEdit, families: FamilySummary[]): string | null {
  if (edit.familyValue === NEW_FAMILY || edit.familyValue === "") return null;
  const fam = families.find((f) => f.id === edit.familyValue);
  if (!fam) return null;
  if (fam.kind === "constant") return fam.liveFile ? fam.liveFile.name : null;
  if (edit.period) {
    const entry = fam.filedEntries.find((e) => e.period === edit.period);
    if (entry) return entry.name;
  }
  return null;
}

/** Can this chip be confirmed as filled? */
function canConfirm(edit: ChipEdit, families: FamilySummary[]): boolean {
  if (edit.familyValue === NEW_FAMILY) {
    const nf = edit.newFamily;
    if (!nf.key.trim() || !nf.label.trim()) return false;
    if (nf.kind === "constant") return true;
    return !!nf.granularity && PERIOD_REGEX[nf.granularity].test(edit.period);
  }
  if (edit.familyValue === "") return false;
  const fam = families.find((f) => f.id === edit.familyValue);
  if (!fam) return false;
  if (fam.kind === "constant") return true;
  return !!fam.granularity && PERIOD_REGEX[fam.granularity].test(edit.period);
}

/** Build the confirm/refile body for a chip. */
function bodyFor(edit: ChipEdit, families: FamilySummary[]) {
  if (edit.familyValue === NEW_FAMILY) {
    const nf = edit.newFamily;
    return { newFamily: nf, period: nf.kind === "constant" ? null : edit.period };
  }
  const fam = families.find((f) => f.id === edit.familyValue);
  return { familyId: edit.familyValue, period: fam?.kind === "constant" ? null : edit.period };
}

const LABEL = "font-mono text-[10px] font-semibold uppercase tracking-[2px] text-ink/45";

export function SourceManager({
  projectId,
  families: initialFamilies,
  unfiled: initialUnfiled,
}: {
  projectId: string;
  families: FamilySummary[];
  unfiled: ProjectSourceRow[];
}) {
  const [families, setFamilies] = useState(initialFamilies);
  const [unfiled, setUnfiled] = useState(initialUnfiled);
  const [edits, setEdits] = useState<Record<string, ChipEdit>>({});
  const [classifying, setClassifying] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  function editFor(row: ProjectSourceRow): ChipEdit {
    return edits[row.id] ?? deriveEdit(row, families);
  }
  function patchEdit(id: string, patch: Partial<ChipEdit>, row: ProjectSourceRow) {
    setEdits((prev) => ({ ...prev, [id]: { ...editFor(row), ...prev[id], ...patch } }));
  }

  async function refetch() {
    const next = await getProjectSources(projectId);
    setFamilies(next.families);
    setUnfiled(next.unfiled);
    // Preserve in-progress chip edits; only prune ids that left the unfiled list
    // (filed or deleted) so an unrelated refetch never wipes a mid-typed chip.
    const live = new Set(next.unfiled.map((r) => r.id));
    setEdits((prev) => {
      const kept: Record<string, ChipEdit> = {};
      for (const [id, edit] of Object.entries(prev)) if (live.has(id)) kept[id] = edit;
      return kept;
    });
  }

  function markClassifying(ids: string[], on: boolean) {
    setClassifying((prev) => {
      const next = new Set(prev);
      for (const id of ids) (on ? next.add(id) : next.delete(id));
      return next;
    });
  }

  async function runClassify(ids: string[]) {
    if (ids.length === 0) return;
    markClassifying(ids, true);
    try {
      await classifySources(projectId, ids);
      await refetch();
    } finally {
      markClassifying(ids, false);
    }
  }

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const { sources } = await uploadProjectSources(projectId, Array.from(files));
    await refetch();
    await runClassify(sources.map((s) => s.id));
  }

  async function confirmOne(row: ProjectSourceRow, edit = editFor(row)) {
    await confirmSource(projectId, { sourceId: row.id, ...bodyFor(edit, families) });
  }

  async function confirmAll() {
    const ready = unfiled.filter((r) => r.proposal && canConfirm(editFor(r), families));
    await Promise.all(ready.map((r) => confirmOne(r)));
    await refetch();
  }

  return (
    <section className="mt-9">
      <div className="flex items-baseline gap-4">
        <h2 className={LABEL}>Sources</h2>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="font-serif text-[13px] italic text-ink/50 hover:text-ink"
        >
          + add data…
        </button>
        <input
          ref={fileRef}
          data-testid="source-upload"
          type="file"
          multiple
          className="hidden"
          onChange={(e) => void onFiles(e.target.files)}
        />
      </div>

      {unfiled.length > 0 && (
        <div className="mt-4 border border-ink/15 bg-card/40">
          <div className="flex items-center justify-between border-b border-ink/15 px-4 py-[10px]">
            <span className={LABEL}>Unfiled · {unfiled.length}</span>
            <button
              type="button"
              onClick={() => void confirmAll()}
              className="font-mono text-[10px] font-semibold uppercase tracking-[1.5px] text-ink hover:text-pencil"
            >
              Confirm all
            </button>
          </div>
          {unfiled.map((r) => (
            <ChipRow
              key={r.id}
              row={r}
              edit={editFor(r)}
              families={families}
              classifying={classifying.has(r.id)}
              onPatch={(patch) => patchEdit(r.id, patch, r)}
              onConfirm={async () => { await confirmOne(r); await refetch(); }}
              onReclassify={() => void runClassify([r.id])}
              onDelete={async () => { await deleteProjectSource(projectId, r.id); await refetch(); }}
            />
          ))}
        </div>
      )}

      <div className="mt-6 flex flex-col gap-5">
        {families.length === 0 ? (
          <div className="font-serif text-[13px] italic text-ink/45">No families yet.</div>
        ) : (
          families.map((f) => (
            <FamilyNode
              key={f.id}
              family={f}
              onRefile={async (sourceId, period) => { await refileSource(projectId, sourceId, { familyId: f.id, period }); await refetch(); }}
              onDelete={async (sourceId) => { await deleteProjectSource(projectId, sourceId); await refetch(); }}
            />
          ))
        )}
      </div>
    </section>
  );
}

function ConfidenceTag({ proposal }: { proposal: ClassifyProposal }) {
  const tone =
    proposal.confidence === "high" ? "text-ink/55" : proposal.confidence === "medium" ? "text-amber" : "text-pencil";
  return (
    <span className={`font-mono text-[9px] uppercase tracking-[1.5px] ${tone}`}>{proposal.confidence}</span>
  );
}

function ChipRow({
  row,
  edit,
  families,
  classifying,
  onPatch,
  onConfirm,
  onReclassify,
  onDelete,
}: {
  row: ProjectSourceRow;
  edit: ChipEdit;
  families: FamilySummary[];
  classifying: boolean;
  onPatch: (patch: Partial<ChipEdit>) => void;
  onConfirm: () => void;
  onReclassify: () => void;
  onDelete: () => void;
}) {
  const occupant = occupiedBy(edit, families);
  const ready = canConfirm(edit, families);
  const isNew = edit.familyValue === NEW_FAMILY;
  const targetFam = families.find((f) => f.id === edit.familyValue);
  const showPeriod = isNew ? edit.newFamily.kind === "periodic" : targetFam?.kind !== "constant";

  return (
    <div data-testid={`chip-${row.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink/10 px-4 py-3 last:border-b-0">
      <span className="font-serif text-[14px] text-ink">{row.name}</span>

      {row.proposal && edit.familyValue !== "" && showPeriod && edit.period && (
        <span className="font-mono text-[11px] text-ink/50">
          {(isNew ? edit.newFamily.key : targetFam?.key) + " · " + formatPeriod(edit.period)}
        </span>
      )}
      {row.proposal && <ConfidenceTag proposal={row.proposal} />}
      {classifying && <span className="font-mono text-[10px] text-ink/40">classifying…</span>}

      <select
        data-testid={`family-${row.id}`}
        aria-label="family"
        value={edit.familyValue}
        onChange={(e) => onPatch({ familyValue: e.target.value })}
        className="border border-ink/20 bg-paper px-2 py-1 font-serif text-[13px] text-ink"
      >
        <option value="">choose family…</option>
        {families.map((f) => (
          <option key={f.id} value={f.id}>{f.label}</option>
        ))}
        <option value={NEW_FAMILY}>new family…</option>
      </select>

      {isNew && (
        <span className="flex flex-wrap items-center gap-2">
          <input
            data-testid={`nf-key-${row.id}`}
            placeholder="key"
            value={edit.newFamily.key}
            onChange={(e) => onPatch({ newFamily: { ...edit.newFamily, key: e.target.value } })}
            className="w-24 border border-ink/20 bg-paper px-2 py-1 font-mono text-[12px]"
          />
          <input
            placeholder="label"
            value={edit.newFamily.label}
            onChange={(e) => onPatch({ newFamily: { ...edit.newFamily, label: e.target.value } })}
            className="w-28 border border-ink/20 bg-paper px-2 py-1 font-serif text-[13px]"
          />
          <select
            aria-label="kind"
            value={edit.newFamily.kind}
            onChange={(e) => {
              const kind = e.target.value as "periodic" | "constant";
              onPatch({ newFamily: { ...edit.newFamily, kind, granularity: kind === "constant" ? null : (edit.newFamily.granularity ?? "quarter") } });
            }}
            className="border border-ink/20 bg-paper px-2 py-1 font-mono text-[12px]"
          >
            <option value="periodic">periodic</option>
            <option value="constant">constant</option>
          </select>
          {edit.newFamily.kind === "periodic" && (
            <select
              aria-label="granularity"
              value={edit.newFamily.granularity ?? "quarter"}
              onChange={(e) => onPatch({ newFamily: { ...edit.newFamily, granularity: e.target.value as Granularity } })}
              className="border border-ink/20 bg-paper px-2 py-1 font-mono text-[12px]"
            >
              <option value="quarter">quarter</option>
              <option value="month">month</option>
              <option value="year">year</option>
            </select>
          )}
        </span>
      )}

      {showPeriod && (
        <span className="flex items-center gap-2">
          <input
            data-testid={`period-${row.id}`}
            placeholder="2026-Q2"
            value={edit.period}
            onChange={(e) => onPatch({ period: e.target.value })}
            className="w-24 border border-ink/20 bg-paper px-2 py-1 font-mono text-[12px]"
          />
          {edit.period && <span className="font-serif text-[12px] text-ink/45">{formatPeriod(edit.period)}</span>}
        </span>
      )}

      {occupant && (
        <span className="font-serif text-[12px] italic text-pencil">replaces {occupant}</span>
      )}

      <span className="ml-auto flex items-center gap-3">
        <button
          type="button"
          onClick={onReclassify}
          className="font-mono text-[10px] uppercase tracking-[1.5px] text-ink/40 hover:text-ink"
        >
          reclassify
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="font-mono text-[10px] uppercase tracking-[1.5px] text-ink/40 hover:text-pencil"
        >
          delete
        </button>
        <button
          type="button"
          disabled={!ready}
          onClick={onConfirm}
          className="rounded-full bg-ink px-3 py-1 font-sans text-[12px] font-medium text-paper disabled:opacity-30"
        >
          Confirm
        </button>
      </span>
    </div>
  );
}

function FamilyNode({
  family,
  onRefile,
  onDelete,
}: {
  family: FamilySummary;
  onRefile: (sourceId: string, period: string | null) => void;
  onDelete: (sourceId: string) => void;
}) {
  const gran = family.granularity ?? "—";
  // Which filed entry's refile picker is open (by sourceId), and its draft period.
  const [refiling, setRefiling] = useState<string | null>(null);
  const [draftPeriod, setDraftPeriod] = useState("");

  function openRefile(sourceId: string, period: string) {
    setRefiling(sourceId);
    setDraftPeriod(period);
  }

  return (
    <div className="border-t border-ink/15 pt-3">
      <div className="font-mono text-[10px] uppercase tracking-[1.5px] text-ink/50">
        {family.key} · {family.kind} · {gran}
      </div>

      {family.kind === "constant" ? (
        <div className="group mt-2 flex items-center gap-3 font-serif text-[13px] text-ink/70">
          {family.liveFile ? (
            <>
              {family.liveFile.name}
              <button
                type="button"
                onClick={() => onDelete(family.liveFile!.sourceId)}
                className="font-mono text-[10px] uppercase tracking-[1.5px] text-ink/0 hover:text-pencil group-hover:text-ink/40"
              >
                delete
              </button>
            </>
          ) : (
            <span className="italic text-ink/45">no file</span>
          )}
        </div>
      ) : family.filedPeriods.length === 0 ? (
        <div className="mt-2 font-serif text-[13px] italic text-ink/45">no periods filed</div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          {enumeratePeriods(family.filedPeriods[0], family.filedPeriods[family.filedPeriods.length - 1]).map((p) => {
            const entry = family.filedEntries.find((e) => e.period === p);
            return (
              <span key={p} className="group inline-flex items-center gap-2" title={entry?.name}>
                <span className={`font-mono text-[11px] ${entry ? "text-ink/70" : "text-ink/30"}`}>
                  {formatPeriod(p)} {entry ? "✓" : "—"}
                </span>
                {entry && (
                  <span className="inline-flex items-center gap-2 text-ink/0 group-hover:text-ink/40">
                    <button
                      type="button"
                      data-testid={`refile-${entry.sourceId}`}
                      onClick={() => openRefile(entry.sourceId, entry.period)}
                      className="font-mono text-[9px] uppercase tracking-[1.5px] hover:text-ink"
                    >
                      refile
                    </button>
                    <button
                      type="button"
                      data-testid={`delete-${entry.sourceId}`}
                      onClick={() => onDelete(entry.sourceId)}
                      className="font-mono text-[9px] uppercase tracking-[1.5px] hover:text-pencil"
                    >
                      delete
                    </button>
                  </span>
                )}
              </span>
            );
          })}

          {refiling && (
            <span className="inline-flex items-center gap-2 border border-ink/15 bg-paper px-2 py-1">
              <span className="font-mono text-[9px] uppercase tracking-[1.5px] text-ink/45">refile to</span>
              <input
                data-testid={`refile-period-${refiling}`}
                value={draftPeriod}
                onChange={(e) => setDraftPeriod(e.target.value)}
                className="w-24 border border-ink/20 bg-paper px-2 py-1 font-mono text-[12px]"
              />
              <button
                type="button"
                data-testid={`refile-save-${refiling}`}
                disabled={!family.granularity || !PERIOD_REGEX[family.granularity].test(draftPeriod)}
                onClick={() => { onRefile(refiling, draftPeriod); setRefiling(null); }}
                className="font-mono text-[9px] uppercase tracking-[1.5px] text-ink hover:text-pencil disabled:opacity-30"
              >
                save
              </button>
              <button
                type="button"
                onClick={() => setRefiling(null)}
                className="font-mono text-[9px] uppercase tracking-[1.5px] text-ink/40 hover:text-ink"
              >
                cancel
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
