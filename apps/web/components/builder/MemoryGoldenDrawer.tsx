"use client";

import { useEffect, useState } from "react";
import type { BindingItem, GoldenRow, MemoryRow } from "@runoff/core/client";
import { formatPeriod, parseBindings, boundnessCounts } from "@runoff/core/client";
import {
  bindGoldenApi,
  deleteGolden,
  deleteMemory,
  getGoldens,
  getMemories,
  patchGoldenPeriod,
  patchMemory,
  unifyGoldenApi,
  uploadGolden,
} from "@/lib/api";

/** UI boundness line — counts from core `boundnessCounts`, drawer's ` · ` format kept locally. */
function boundness(bindings: string | null): string {
  if (!bindings) return "not yet bound";
  const inv = parseBindings(bindings);
  if (!inv) return "bindings unreadable";
  const c = boundnessCounts(inv)!;
  if (c.total === 0) return "nothing to bind";
  return `${c.bound}/${c.total} bound · ${c.mismatch} mismatch · ${c.total - c.bound - c.mismatch} unbound`;
}

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fmtVal = (v: number | string | null): string => (typeof v === "number" ? v.toLocaleString("en-US") : String(v));

/** The server's `{ error }` string out of a rejected fetchJson promise; raw fallback. */
function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.match(/\{.*\}/);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]) as { error?: unknown };
      if (typeof parsed.error === "string") return parsed.error;
    } catch {
      // fall through to the raw message
    }
  }
  return raw;
}

const BADGE = "border border-ink/20 px-1 py-[1px] font-mono text-[8.5px] uppercase tracking-[1px]";
const AMBER_BADGE = "border border-amber/40 px-1 py-[1px] font-mono text-[8.5px] uppercase tracking-[1px] text-amber";
const ACTION = "font-mono text-[8.5px] uppercase tracking-[1px] text-ink/50 hover:text-ink disabled:opacity-40";

export function GoldenCard({ g, blueprintId, reload }: { g: GoldenRow; blueprintId: string; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingPeriod, setEditingPeriod] = useState(false);
  const [draftPeriod, setDraftPeriod] = useState("");
  const [periodErr, setPeriodErr] = useState<string | null>(null);

  const inv = parseBindings(g.bindings);
  const isExemplar = g.kind === "exemplar";
  const label = isExemplar ? g.name : `run ${g.runId}${g.sectionKey ? ` · §${g.sectionKey}` : ""}`;

  const call = (p: Promise<unknown>) => {
    setBusy(true);
    setError(null);
    p.then(() => reload()).catch((e) => setError(errText(e))).finally(() => setBusy(false));
  };

  function commitPeriod() {
    patchGoldenPeriod(g.id, draftPeriod.trim() || null)
      .then(() => { setEditingPeriod(false); setPeriodErr(null); reload(); })
      .catch((e) => setPeriodErr(errText(e)));
  }

  return (
    <div data-testid={`golden-${g.id}`} className="mt-2 border-b border-ink/10 pb-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-serif text-[12.5px] text-ink">{label}</span>

        {isExemplar ? (
          g.document ? (
            <span className={`${BADGE} text-ink/55`}>unified</span>
          ) : g.unifyError ? (
            <>
              <span className={AMBER_BADGE}>unify failed</span>
              <button type="button" className={ACTION} disabled={busy} onClick={() => call(unifyGoldenApi(blueprintId, g.id))}>
                retry unify
              </button>
            </>
          ) : (
            <span className={`${BADGE} text-ink/40`}>unifying…</span>
          )
        ) : null}

        {editingPeriod ? (
          <input
            data-testid={`period-input-${g.id}`}
            autoFocus
            value={draftPeriod}
            onChange={(e) => setDraftPeriod(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") commitPeriod(); }}
            onBlur={commitPeriod}
            placeholder="2026-Q2"
            className="w-24 border border-ink/20 bg-paper px-2 py-[1px] font-mono text-[10px]"
          />
        ) : (
          <button
            type="button"
            data-testid={`period-chip-${g.id}`}
            onClick={() => { setDraftPeriod(g.period ?? ""); setPeriodErr(null); setEditingPeriod(true); }}
            className="border border-ink/15 px-1 py-[1px] font-mono text-[8.5px] uppercase tracking-[1px] text-ink/45 hover:text-ink"
          >
            {g.period ? formatPeriod(g.period) : "set period"}
          </button>
        )}

        <span className="font-mono text-[8.5px] uppercase tracking-[1px] text-ink/40">{boundness(g.bindings)}</span>

        <span className="ml-auto flex items-center gap-3">
          {inv ? (
            <button type="button" className={ACTION} onClick={() => setOpen((o) => !o)}>
              {open ? "hide" : "inventory"}
            </button>
          ) : null}
          <button type="button" className="font-mono text-[8.5px] uppercase tracking-[1px] text-pencil" onClick={() => deleteGolden(g.id).then(reload)}>
            delete
          </button>
        </span>
      </div>

      {isExemplar && g.unifyError ? <p className="mt-1 font-serif text-[12px] italic text-amber">{g.unifyError}</p> : null}

      {open && inv ? (
        <div className="mt-1">
          {inv.items.map((it: BindingItem) => (
            <div key={it.id} className="mt-1 font-mono text-[9px] leading-[1.6]">
              <span className="text-ink">{it.raw}</span>
              {it.binding?.status === "bound" ? (
                <span className="text-ink/40"> ← {it.binding.familyId} · {truncate(it.binding.sql, 80)}</span>
              ) : null}
              {it.binding?.status === "mismatch" ? (
                <span className="text-amber-700"> says {it.raw} · data {fmtVal(it.binding.verifiedValue)}</span>
              ) : null}
              {!it.binding || it.binding.status === "error" ? <span className="text-pencil"> {it.reason}</span> : null}
            </div>
          ))}

          {isExemplar ? (
            <div className="mt-2 flex items-center gap-2">
              <input
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="what should bind differently?"
                className="flex-1 border-b border-ink/20 bg-transparent font-mono text-[10px] outline-none"
              />
              <button
                type="button"
                className={ACTION}
                disabled={busy || !feedback.trim()}
                onClick={() => { call(bindGoldenApi(blueprintId, g.id, feedback.trim())); setFeedback(""); }}
              >
                rebind
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-2 flex items-center gap-3">
        <button type="button" className={ACTION} disabled={busy} onClick={() => call(bindGoldenApi(blueprintId, g.id))}>
          {isExemplar && !g.bindings ? "Bind to data" : "verify bindings"}
        </button>
      </div>

      {error ? <p className="mt-1 font-serif text-[12px] italic text-pencil" role="alert">{error}</p> : null}
      {periodErr ? <p className="mt-1 font-serif text-[12px] italic text-pencil" role="alert">{periodErr}</p> : null}
    </div>
  );
}

export function MemoryGoldenDrawer({ blueprintId }: { blueprintId: string }) {
  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [goldens, setGoldens] = useState<GoldenRow[]>([]);

  const reload = () => {
    getMemories(blueprintId).then((r) => setMemories(r.memories)).catch(() => {});
    getGoldens(blueprintId).then((r) => setGoldens(r.goldens)).catch(() => {});
  };
  useEffect(reload, [blueprintId]);

  return (
    <div className="flex-1 overflow-y-auto pr-1">
      <div className="font-mono text-[8.5px] uppercase tracking-[1px] text-ink/45">Memory</div>
      {memories.length === 0 ? <p className="mt-1 font-serif text-[12.5px] italic text-ink/40">Nothing learned yet.</p> : null}
      {memories.map((m) => (
        <div key={m.id} className="mt-2 border-b border-ink/10 pb-2">
          <p className={`font-serif text-[12.5px] leading-[1.5] ${m.status === "disabled" ? "text-ink/35 line-through" : "text-ink"}`}>{m.body}</p>
          <div className="mt-1 flex items-center gap-3 font-mono text-[8.5px] uppercase tracking-[1px] text-ink/35">
            <span className="border border-ink/20 px-1 py-[1px] text-ink/55">{m.scope}</span>
            <span>{m.source}</span>
            <button type="button" className="text-ink/60" onClick={() => patchMemory(m.id, m.status === "active" ? "disabled" : "active").then(reload)}>
              {m.status === "active" ? "disable" : "enable"}
            </button>
            <button type="button" className="text-pencil" onClick={() => deleteMemory(m.id).then(reload)}>delete</button>
          </div>
        </div>
      ))}

      <div className="mt-5 font-mono text-[8.5px] uppercase tracking-[1px] text-ink/45">Goldens</div>
      {goldens.map((g) => (
        <GoldenCard key={g.id} g={g} blueprintId={blueprintId} reload={reload} />
      ))}
      <label className="mt-3 inline-block cursor-pointer font-sans text-[11px] text-ink/60 underline">
        Upload exemplar
        <input
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadGolden(blueprintId, f).then(reload);
          }}
        />
      </label>
    </div>
  );
}
