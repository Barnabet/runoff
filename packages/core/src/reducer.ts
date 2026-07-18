import type { Block, RunDocument } from "./types/document.js";
import { blocksToPlainText } from "./types/document.js";
import type { RunEvent, RunStats } from "./types/events.js";

export type SectionRunState = "queued" | "writing" | "done" | "failed";

export interface RunProjection {
  status: "idle" | "running" | "paused" | "complete" | "failed";
  phase: string; // "READING SOURCES" | "DRAFTING §02" | "RENDERING" | "COMPLETE" | "FAILED" | "PAUSED"
  sections: Record<string, { state: SectionRunState; typedText: string; blocks: Block[]; retries: number; words: number; error?: string }>;
  log: { level: "info" | "warn" | "error" | "user"; message: string }[];
  questions: Record<string, { sectionKey: string; question: string; options: string[]; fallback: string; deadlineSection: string; status: "open" | "answered" | "fallback"; answer?: string }>;
  flags: { flagId: string; code: string; sectionKey: string; question: string; options: string[] }[];
  memoryIds: string[];
  document?: RunDocument;
  stats?: RunStats;
  error?: string;
}

/**
 * Deterministic projection of a run's event log. Same events + sectionMeta in
 * always yield the same projection out — no clocks, no randomness. This is the
 * shared reducer consumed by both engine integration tests and the Live Run UI.
 */
export function reduceRun(
  events: RunEvent[],
  sectionMeta: { key: string; number: number }[],
): RunProjection {
  const p: RunProjection = {
    status: "idle",
    phase: "",
    sections: {},
    log: [],
    questions: {},
    flags: [],
    memoryIds: [],
  };

  const numberOf = (key: string): number | undefined =>
    sectionMeta.find((m) => m.key === key)?.number;

  const draftingPhase = (key: string): string =>
    `DRAFTING §${String(numberOf(key) ?? 0).padStart(2, "0")}`;

  // Ensure a section slot exists before mutating it (run_started normally
  // creates them all, but stay robust if an event references a fresh key).
  const section = (key: string) => {
    let s = p.sections[key];
    if (!s) {
      s = { state: "queued", typedText: "", blocks: [], retries: 0, words: 0 };
      p.sections[key] = s;
    }
    return s;
  };

  // Phase in effect before a pause, restored on resume.
  let phaseBeforePause = "";

  for (const e of events) {
    switch (e.type) {
      case "run_started": {
        p.status = "running";
        p.phase = "READING SOURCES";
        p.memoryIds = e.memoryIds ?? [];
        for (const key of e.sectionKeys) {
          p.sections[key] = { state: "queued", typedText: "", blocks: [], retries: 0, words: 0 };
        }
        break;
      }
      case "source_read": {
        p.log.push({ level: "info", message: `Read ${e.label} — ${e.summary}` });
        break;
      }
      case "section_started": {
        section(e.sectionKey).state = "writing";
        p.phase = draftingPhase(e.sectionKey);
        break;
      }
      case "text_delta": {
        section(e.sectionKey).typedText += e.text;
        break;
      }
      case "section_completed": {
        const s = section(e.sectionKey);
        s.state = "done";
        s.blocks = e.blocks;
        s.words = e.words;
        s.retries = e.retries;
        // Reset typed text to the final rendered wording so replays match output.
        s.typedText = blocksToPlainText(e.blocks);
        break;
      }
      case "section_failed": {
        // A section that could not be drafted (e.g. the model refused). The run
        // continues without it, so the phase is left unchanged.
        section(e.sectionKey).state = "failed";
        section(e.sectionKey).error = e.error;
        p.log.push({ level: "error", message: `§ ${e.sectionKey} failed — ${e.error}` });
        break;
      }
      case "check_failed": {
        p.log.push({ level: "warn", message: `Check failed on ${e.sectionKey} — ${e.rule}: ${e.detail}` });
        break;
      }
      case "retry_started": {
        p.log.push({ level: "info", message: `Retrying ${e.sectionKey} — ${e.reason}` });
        break;
      }
      case "steer_received": {
        p.log.push({ level: "user", message: e.text });
        break;
      }
      case "log": {
        p.log.push({ level: e.level, message: e.message });
        break;
      }
      case "question_raised": {
        p.questions[e.questionId] = {
          sectionKey: e.sectionKey,
          question: e.question,
          options: e.options,
          fallback: e.fallback,
          deadlineSection: e.deadlineSection,
          status: "open",
        };
        break;
      }
      case "question_answered": {
        const q = p.questions[e.questionId];
        if (q) {
          q.status = "answered";
          q.answer = e.answer;
        }
        break;
      }
      case "question_fallback_applied": {
        const q = p.questions[e.questionId];
        if (q) q.status = "fallback";
        break;
      }
      case "flag_raised": {
        p.flags.push({
          flagId: e.flagId,
          code: e.code,
          sectionKey: e.sectionKey,
          question: e.question,
          options: e.options,
        });
        break;
      }
      case "paused": {
        p.status = "paused";
        phaseBeforePause = p.phase;
        p.phase = "PAUSED";
        break;
      }
      case "resumed": {
        p.status = "running";
        p.phase = phaseBeforePause;
        break;
      }
      case "render_started": {
        p.phase = "RENDERING";
        break;
      }
      case "run_completed": {
        p.status = "complete";
        p.phase = "COMPLETE";
        p.stats = e.stats;
        p.document = e.document;
        break;
      }
      case "run_failed": {
        p.status = "failed";
        p.phase = "FAILED";
        p.error = e.error;
        p.log.push({ level: "error", message: e.error });
        break;
      }
      // check_passed is intentionally not projected (no log/state change).
    }
  }

  return p;
}
