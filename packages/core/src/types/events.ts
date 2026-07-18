import type { Block, RunDocument } from "./document.js";

export interface RunStats {
  durationMs: number; words: number; sourcesUsed: number;
  checksPassed: number; checksFailed: number; flagCount: number;
  citationCount: number; retries: number;
}
export type RunEvent =
  | { type: "run_started"; sectionKeys: string[]; blueprintRev: number }
  | { type: "source_read"; sourceId: string; label: string; summary: string }
  | { type: "section_started"; sectionKey: string }
  | { type: "text_delta"; sectionKey: string; text: string }
  | { type: "section_completed"; sectionKey: string; blocks: Block[]; words: number; ms: number; retries: number }
  | { type: "section_failed"; sectionKey: string; error: string }
  | { type: "check_passed"; sectionKey: string; rule: string }
  | { type: "check_failed"; sectionKey: string; rule: string; detail: string }
  | { type: "retry_started"; sectionKey: string; reason: string }
  | { type: "question_raised"; questionId: string; sectionKey: string; question: string; options: string[]; fallback: string; deadlineSection: string }
  | { type: "question_answered"; questionId: string; answer: string }
  | { type: "question_fallback_applied"; questionId: string }
  | { type: "flag_raised"; flagId: string; code: string; sectionKey: string; question: string; options: string[] }
  | { type: "steer_received"; text: string }
  | { type: "paused" } | { type: "resumed" }
  | { type: "render_started" }
  | { type: "run_completed"; stats: RunStats; document: RunDocument }
  | { type: "run_failed"; error: string }
  | { type: "log"; level: "info" | "warn" | "error" | "user"; message: string };
