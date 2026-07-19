"use client";

import { useEffect, useRef, useState } from "react";
import type { BlueprintContent, CopilotAction, EditOp } from "@runoff/core";
import { getCopilotThread, type CopilotMessage } from "@/lib/api";
import { invertEditOp } from "@/lib/editOps";
import { CopilotMarkdown } from "./CopilotMarkdown";
import { MemoryGoldenDrawer } from "./MemoryGoldenDrawer";

type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_activity"; label: string }
  | { type: "edit"; op: EditOp }
  | { type: "memory_saved"; memoryId: string; body: string }
  | { type: "done"; messageId: string }
  | { type: "error"; message: string };

export interface CopilotRailProps {
  blueprintId: string;
  selectedKey: string | null;
  selectedHeading: string;
  getDraft: () => BlueprintContent;
  onEditOp: (op: EditOp) => void;
}

interface LiveTurn {
  text: string;
  activities: string[];
  actions: CopilotAction[];
  error: string | null;
  failedMessage?: string; // the user message to retry
}

function opTitle(op: EditOp, draft: BlueprintContent): string {
  switch (op.type) {
    case "edit_section": {
      const s = draft.sections.find((x) => x.key === op.key);
      const fields = Object.keys(op.after).join(", ");
      return `§${s?.number ?? "?"} ${s?.heading ?? op.key} · ${fields}`;
    }
    case "add_section": return `added §"${op.section.heading}"`;
    case "remove_section": return `removed §"${op.removed.heading}"`;
    case "update_masthead": return `masthead · ${Object.keys(op.after).join(", ")}`;
    case "update_global_rules": return "global rules";
    case "update_section_queries": return "data queries";
  }
}

function diffText(op: EditOp): { before: string; after: string } | null {
  if (op.type === "edit_section" || op.type === "update_masthead") {
    return { before: Object.values(op.before).map(String).join(" · "), after: Object.values(op.after).map(String).join(" · ") };
  }
  if (op.type === "update_global_rules") return { before: op.before.join("; "), after: op.after.join("; ") };
  if (op.type === "update_section_queries") {
    return { before: op.before.map((qy) => qy.name).join("; "), after: op.after.map((qy) => qy.name).join("; ") };
  }
  return null;
}

function EditCard({ op, draft, onRevert }: { op: EditOp; draft: BlueprintContent; onRevert: (op: EditOp) => void }) {
  const [reverted, setReverted] = useState(false);
  const diff = diffText(op);
  return (
    <div className="mt-2 rounded-[4px] border border-ink/15 px-3 py-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[8.5px] uppercase tracking-[1px] text-ink/45">{opTitle(op, draft)}</span>
        {reverted ? (
          <span className="font-mono text-[8.5px] uppercase tracking-[1px] text-pencil">reverted</span>
        ) : (
          <button
            type="button"
            className="font-sans text-[11px] text-ink/60 hover:text-ink"
            onClick={() => { onRevert(invertEditOp(op)); setReverted(true); }}
          >
            Revert
          </button>
        )}
      </div>
      {diff ? (
        <div className="mt-1 font-serif text-[12.5px] leading-[1.5]">
          <div className="text-pencil line-through decoration-pencil/50">{diff.before}</div>
          <div className="text-ink">{diff.after}</div>
        </div>
      ) : null}
    </div>
  );
}

export function CopilotRail({ blueprintId, selectedKey, selectedHeading, getDraft, onEditOp }: CopilotRailProps) {
  const [messages, setMessages] = useState<CopilotMessage[]>([]);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [input, setInput] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getCopilotThread(blueprintId).then((r) => setMessages(r.messages)).catch(() => {});
  }, [blueprintId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, live]);

  async function send(message: string) {
    if (!message.trim() || (live && !live.error)) return;
    setMessages((m) => [...m, { id: `tmp_${Date.now()}`, role: "user", body: message, actions: [], status: "ok", createdAt: "" }]);
    setInput("");
    const turn: LiveTurn = { text: "", activities: [], actions: [], error: null };
    setLive({ ...turn });
    try {
      const res = await fetch(`/api/blueprints/${blueprintId}/copilot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, draft: getDraft(), selectedKey }),
      });
      if (!res.ok || !res.body) throw new Error(`request failed (${res.status})`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (!frame.startsWith("data: ")) continue;
          const e = JSON.parse(frame.slice(6)) as StreamEvent;
          if (e.type === "text_delta") turn.text += e.text;
          if (e.type === "tool_activity") turn.activities.push(e.label);
          if (e.type === "edit") { onEditOp(e.op); turn.actions.push({ kind: "edit", op: e.op }); }
          if (e.type === "memory_saved") turn.actions.push({ kind: "memory", memoryId: e.memoryId, body: e.body });
          if (e.type === "error") { turn.error = e.message; turn.failedMessage = message; }
          if (e.type === "done") {
            setMessages((m) => [...m, { id: e.messageId, role: "assistant", body: turn.text, actions: turn.actions, status: "ok", createdAt: "" }]);
            setLive(null);
            return;
          }
          setLive({ ...turn });
        }
      }
      // Stream ended without done: treat as an error unless one was reported.
      if (!turn.error) turn.error = "stream ended unexpectedly";
      turn.failedMessage = message;
      setLive({ ...turn });
    } catch (err) {
      turn.error = err instanceof Error ? err.message : String(err);
      turn.failedMessage = message;
      setLive({ ...turn });
    }
  }

  function retry() {
    const msg = live?.failedMessage;
    // send() replaces the errored `live` turn with a fresh streaming turn and re-POSTs the message.
    if (msg) void send(msg);
  }

  const draft = getDraft();

  return (
    <aside className="flex h-[calc(100vh-140px)] flex-col border-l border-ink/15 pl-5">
      <div className="flex items-center justify-between pb-2">
        <span className="font-mono text-[8.5px] uppercase tracking-[1px] text-ink/45">Copilot</span>
        <button type="button" className="font-sans text-[11px] text-ink/60" onClick={() => setDrawerOpen((v) => !v)}>
          {drawerOpen ? "Close" : "Memory · Goldens"}
        </button>
      </div>

      {drawerOpen ? (
        <MemoryGoldenDrawer blueprintId={blueprintId} />
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto pr-1">
          {messages.map((m) => (
            <div key={m.id} className="mb-4">
              <div className="font-mono text-[8.5px] uppercase tracking-[1px] text-ink/35">{m.role === "user" ? "You" : "Copilot"}</div>
              {m.role === "user" ? (
                <p className="mt-1 font-serif text-[13.5px] leading-[1.55] text-ink">{m.body}</p>
              ) : (
                <CopilotMarkdown>{m.body}</CopilotMarkdown>
              )}
              {m.actions.filter((a) => a.kind === "edit").map((a, i) =>
                a.kind === "edit" ? <EditCard key={i} op={a.op} draft={draft} onRevert={onEditOp} /> : null,
              )}
            </div>
          ))}
          {live ? (
            <div className="mb-4">
              <div className="font-mono text-[8.5px] uppercase tracking-[1px] text-ink/35">Copilot</div>
              {live.activities.map((a, i) => (
                <div key={i} className="mt-1 font-mono text-[10px] text-ink/45">· {a}</div>
              ))}
              {live.text ? <CopilotMarkdown>{live.text}</CopilotMarkdown> : null}
              {live.actions.filter((a) => a.kind === "edit").map((a, i) =>
                a.kind === "edit" ? <EditCard key={i} op={a.op} draft={draft} onRevert={onEditOp} /> : null,
              )}
              {live.error ? (
                <div className="mt-2 font-serif text-[12.5px] italic text-pencil">
                  {live.error}{" "}
                  <button type="button" className="font-sans not-italic text-[11px] text-ink/60 underline" onClick={retry}>
                    Retry
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      <form
        data-testid="copilot-composer"
        className="mt-2 border-t border-ink/15 pt-3"
        onSubmit={(e) => { e.preventDefault(); void send(input); }}
      >
        {selectedKey ? (
          <span className="font-mono text-[8.5px] uppercase tracking-[1px] text-ink/35">§ {selectedHeading}</span>
        ) : null}
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); } }}
          placeholder="Ask the copilot — edit sections, check the data, mine past runs…"
          rows={2}
          disabled={!!live && !live.error}
          className="mt-1 w-full resize-none rounded-[4px] border border-ink/20 bg-transparent px-3 py-2 font-serif text-[13px] leading-[1.5] text-ink outline-none placeholder:text-ink/30"
        />
      </form>
    </aside>
  );
}
