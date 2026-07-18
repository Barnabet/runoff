"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RunProjection } from "@runoff/core";
import type { SectionMeta } from "@/lib/api";
import { postRunInput } from "@/lib/api";
import { showToast } from "@/components/Toast";

type LogLine = RunProjection["log"][number];

/**
 * The right "THE AGENT'S DESK" rail: a live mono log feed (auto-scrolled to the
 * newest line), a question card whenever the agent is blocked on a decision, a
 * completion card once the run finishes, and a steer input pinned to the bottom.
 * Steering appends an optimistic user line immediately; the same line arrives
 * from the stream as a `steer_received` event and is de-duplicated on the way in.
 */
export function AgentDesk({
  runId,
  projection,
  sectionMeta,
  terminal,
  handingOff = false,
  onOpenReport,
}: {
  runId: string;
  projection: RunProjection;
  sectionMeta: SectionMeta[];
  terminal: boolean;
  handingOff?: boolean;
  onOpenReport: () => void;
}) {
  const [steer, setSteer] = useState("");
  const [optimistic, setOptimistic] = useState<string[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);

  const numberOf = (key: string): string => {
    const n = sectionMeta.find((m) => m.key === key)?.number;
    return n ? `§${String(n).padStart(2, "0")}` : key;
  };

  // Optimistic steer lines that the stream has not yet echoed back as a `user`
  // log line get appended to the real feed.
  const feed: LogLine[] = useMemo(() => {
    const pending = optimistic
      .filter((t) => !projection.log.some((l) => l.level === "user" && l.message === t))
      .map((t) => ({ level: "user" as const, message: t }));
    return [...projection.log, ...pending];
  }, [projection.log, optimistic]);

  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed.length]);

  function answer(questionId: string, option: string) {
    postRunInput(runId, { kind: "answer", questionId, text: option }).catch(() =>
      showToast("Could not send your answer."),
    );
  }

  function sendSteer() {
    const text = steer.trim();
    if (!text) {
      showToast("Type a steer first.");
      return;
    }
    setOptimistic((prev) => [...prev, text]);
    setSteer("");
    postRunInput(runId, { kind: "steer", text }).catch(() => {
      setOptimistic((prev) => prev.filter((t) => t !== text));
      showToast("Could not steer the run.");
    });
  }

  const openQuestions = Object.entries(projection.questions).filter(
    ([, q]) => q.status === "open",
  );
  const resolvedQuestions = Object.entries(projection.questions).filter(
    ([, q]) => q.status !== "open",
  );

  return (
    <div className="flex h-full flex-col gap-[14px]">
      <div className="font-sans text-[9.5px] font-semibold uppercase tracking-[2.5px] text-ink/45">
        The agent&rsquo;s desk
      </div>

      <div
        ref={feedRef}
        data-testid="log-feed"
        className="max-h-[280px] overflow-y-auto font-mono text-[10.5px] leading-[2]"
      >
        {feed.map((line, i) => (
          <div key={i} className={levelClass(line.level)}>
            <span className="mr-[6px] text-ink/35">{line.level === "user" ? "▸" : "·"}</span>
            {line.message}
          </div>
        ))}
      </div>

      {openQuestions.map(([qid, q]) => (
        <div
          key={qid}
          data-testid={`question-card-${qid}`}
          className="border border-t-2 border-ink/12 border-t-amber-accent bg-card p-[14px]"
        >
          <p className="font-serif text-[13px] leading-[1.5] text-ink">{q.question}</p>
          <div className="mt-[10px] flex flex-wrap gap-[8px]">
            {q.options.map((option, i) => (
              <button
                key={option}
                type="button"
                onClick={() => answer(qid, option)}
                className={
                  i === 0
                    ? "rounded-full bg-ink px-[13px] py-[5px] font-sans text-[11px] font-medium text-paper"
                    : "rounded-full border border-ink/30 px-[13px] py-[5px] font-sans text-[11px] font-medium text-ink"
                }
              >
                {option}
              </button>
            ))}
          </div>
          <p className="mt-[10px] font-serif text-[11.5px] italic text-ink/55">
            No answer by {numberOf(q.deadlineSection)}? {q.fallback}
          </p>
        </div>
      ))}

      {resolvedQuestions.map(([qid, q]) => (
        <div
          key={qid}
          data-testid={`question-resolved-${qid}`}
          className="bg-wash p-[12px] font-serif text-[12px] italic text-ink/60"
        >
          {q.status === "answered"
            ? `You chose “${q.answer}.”`
            : `No answer in time — ${q.fallback}`}
        </div>
      ))}

      {projection.status === "complete" && projection.stats ? (
        <div
          data-testid="completion-card"
          className="bg-ink p-[16px] text-paper"
        >
          <p className="font-serif text-[15px]">
            Run complete in {(projection.stats.durationMs / 1000).toFixed(1)}s
          </p>
          <p className="mt-[6px] font-mono text-[10.5px] text-paper/70">
            {projection.stats.words} words · {projection.stats.sourcesUsed} sources ·{" "}
            {projection.stats.checksPassed} checks · {projection.stats.flagCount} flags
          </p>
          <button
            type="button"
            onClick={onOpenReport}
            disabled={handingOff}
            className="mt-[12px] rounded-full bg-paper px-[14px] py-[6px] font-sans text-[11px] font-medium text-ink disabled:opacity-60"
          >
            {handingOff ? "Opening…" : "Open the report →"}
          </button>
        </div>
      ) : null}

      {!terminal ? (
        <div className="mt-auto flex items-center gap-[8px] pt-[6px]">
          <input
            value={steer}
            onChange={(e) => setSteer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") sendSteer();
            }}
            aria-label="steer the run"
            placeholder="Steer the run — 'skip web research'…"
            className="flex-1 border border-ink/20 bg-transparent px-[10px] py-[7px] font-serif text-[13px] italic text-ink placeholder:text-ink/40 focus:outline-none"
          />
          <button
            type="button"
            onClick={sendSteer}
            className="rounded-full border border-ink/30 px-[13px] py-[6px] font-sans text-[11px] font-medium text-ink"
          >
            Send
          </button>
        </div>
      ) : null}
    </div>
  );
}

function levelClass(level: LogLine["level"]): string {
  switch (level) {
    case "warn":
      return "text-amber";
    case "error":
      return "text-pencil";
    case "user":
      return "font-semibold text-ink";
    default:
      return "text-ink/70";
  }
}
