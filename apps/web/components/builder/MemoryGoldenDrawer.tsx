"use client";

import { useEffect, useState } from "react";
import type { GoldenRow, MemoryRow } from "@runoff/core";
import { deleteGolden, deleteMemory, getGoldens, getMemories, patchMemory, uploadGolden } from "@/lib/api";

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
        <div key={g.id} className="mt-2 flex items-center justify-between border-b border-ink/10 pb-2">
          <span className="font-serif text-[12.5px] text-ink">
            {g.kind === "exemplar" ? g.name : `run ${g.runId}${g.sectionKey ? ` · §${g.sectionKey}` : ""}`}
          </span>
          <button type="button" className="font-mono text-[8.5px] uppercase tracking-[1px] text-pencil" onClick={() => deleteGolden(g.id).then(reload)}>
            delete
          </button>
        </div>
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
