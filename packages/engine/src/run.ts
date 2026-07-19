import type OpenAI from "openai";
import type {
  Block,
  BlueprintContent,
  BlueprintSection,
  DocSection,
  RunDocument,
  RunEvent,
  RunStats,
} from "@runoff/core";
import { countWords, blocksToPlainText } from "@runoff/core";
import { parseSectionText } from "./dialect.js";
import { buildSourcePack, type EngineFile } from "./sourcePack.js";
import { sectionDataBlock, type RunData } from "./runData.js";
import { evaluateAssert, auditCitations, countCitations } from "./checks.js";
import { draftSection, RefusalError, type DraftCallbacks } from "./draft.js";
import type { ScopedMemory } from "./prompts.js";

/** A message a paused/steering worker feeds into a live run. */
export interface RunInputMsg {
  kind: "pause" | "resume" | "steer" | "answer";
  text?: string;
  questionId?: string;
}

/** Side-channel the orchestrator drives: emit events, poll worker inputs, sleep (injected for tests). */
export interface EngineIO {
  emit(e: RunEvent): void;
  pollInputs(): RunInputMsg[]; // drains pending inputs (worker marks consumed)
  sleep(ms: number): Promise<void>; // injected for tests
}

export interface ExecuteRunResult {
  document: RunDocument;
  stats: RunStats;
}

interface OpenQuestion {
  question: string;
  options: string[];
  fallback: string;
  deadlineSection: string;
  status: "open" | "answered" | "fallback";
}

/**
 * Heart of the run engine. Streams a blueprint through the model section by
 * section — draining live inputs, applying question fallbacks, running checks
 * with a single retry, raising flags — then assembles the document and stats.
 * Emits `run_failed` and re-throws on any unrecoverable error (rule 9).
 */
export async function executeRun(opts: {
  client: OpenAI;
  content: BlueprintContent;
  files: EngineFile[];
  data: RunData;
  io: EngineIO;
  blueprintRev: number;
  previousDocument?: RunDocument;
  memories?: ScopedMemory[];
  period?: string | null;
  gaps?: string[];
}): Promise<ExecuteRunResult> {
  const { client, content, files, data, io, blueprintRev, previousDocument, memories = [], period, gaps } = opts;
  // Project-scope memories are listed first (they set standing context), then
  // blueprint-scope; this order is what run_started.memoryIds records.
  const orderedMemories = [
    ...memories.filter((m) => m.scope === "project"),
    ...memories.filter((m) => m.scope === "blueprint"),
  ];
  const emit = (e: RunEvent) => io.emit(e);
  const runStart = Date.now();

  // Run-wide mutable state.
  const steers: string[] = [];
  const answers: { question: string; answer: string }[] = [];
  const completed: DocSection[] = [];
  const openQuestions = new Map<string, OpenQuestion>();
  const modelFlaggedSections = new Set<string>();

  let questionCounter = 0;
  let flagCounter = 0;
  let checksPassed = 0;
  let checksFailed = 0;
  let flagCount = 0;
  let totalRetries = 0;

  const raiseFlag = (sectionKey: string, question: string, options: string[]): void => {
    flagCounter++;
    emit({ type: "flag_raised", flagId: `flag_${flagCounter}`, code: `F${flagCounter}`, sectionKey, question, options });
    flagCount++;
  };

  // --- live inputs (rule 3) ------------------------------------------------
  const handleSteer = (text: string): void => {
    steers.push(text);
    emit({ type: "steer_received", text });
  };

  const handleAnswer = (msg: RunInputMsg): void => {
    const questionId = msg.questionId ?? "";
    const answer = msg.text ?? "";
    const q = openQuestions.get(questionId);
    if (q) {
      q.status = "answered";
      answers.push({ question: q.question, answer });
    } else {
      answers.push({ question: questionId, answer });
    }
    emit({ type: "question_answered", questionId, answer });
  };

  const waitForResume = async (): Promise<void> => {
    for (;;) {
      await io.sleep(200);
      let resumed = false;
      for (const msg of io.pollInputs()) {
        if (msg.kind === "resume") resumed = true;
        else if (msg.kind === "steer") handleSteer(msg.text ?? "");
        else if (msg.kind === "answer") handleAnswer(msg);
        // a nested pause while already paused is a no-op
      }
      if (resumed) {
        emit({ type: "resumed" });
        return;
      }
    }
  };

  const drainInputs = async (): Promise<void> => {
    for (const msg of io.pollInputs()) {
      if (msg.kind === "steer") handleSteer(msg.text ?? "");
      else if (msg.kind === "answer") handleAnswer(msg);
      else if (msg.kind === "pause") {
        emit({ type: "paused" });
        await waitForResume();
      }
      // a stray resume with no active pause is a no-op
    }
  };

  // --- question fallbacks (rule 4) -----------------------------------------
  const applyFallbacks = (currentKey: string): void => {
    for (const [questionId, q] of openQuestions) {
      if (q.status === "open" && q.deadlineSection === currentKey) {
        q.status = "fallback";
        steers.push(`Assume: ${q.fallback}`);
        emit({ type: "question_fallback_applied", questionId });
      }
    }
  };

  // --- draft callbacks (rule 5) --------------------------------------------
  const makeCallbacks = (sectionKey: string): DraftCallbacks => ({
    onDelta: (text) => emit({ type: "text_delta", sectionKey, text }),
    onQuestion: (q) => {
      questionCounter++;
      const questionId = `q${questionCounter}`;
      openQuestions.set(questionId, {
        question: q.question,
        options: q.options,
        fallback: q.fallback,
        deadlineSection: q.deadlineSection,
        status: "open",
      });
      emit({ type: "question_raised", questionId, sectionKey, question: q.question, options: q.options, fallback: q.fallback, deadlineSection: q.deadlineSection });
    },
    onFlag: (f) => {
      modelFlaggedSections.add(sectionKey);
      raiseFlag(sectionKey, f.question, f.options);
    },
  });

  // --- checks (rule 6) -----------------------------------------------------
  // Returns the failure details (empty ⇒ clean). Emits check_passed/check_failed.
  const runChecks = (section: BlueprintSection, blocks: Block[]): string[] => {
    const details: string[] = [];

    for (const rule of section.rules) {
      if (rule.kind !== "assert") continue;
      // v1 semantics: an assert without `sql` is prompt-only guidance (its text is
      // already woven into the drafting prompt). Skip it at run time so it can't
      // hard-fail via evaluateAssert's defensive "missing sql/op/value" contract.
      if (rule.sql == null) continue;
      const ruleName = rule.text.trim() ? rule.text : (rule.sql ?? "assert");
      const { pass, detail } = evaluateAssert(rule, data);
      if (pass) {
        emit({ type: "check_passed", sectionKey: section.key, rule: ruleName });
        checksPassed++;
      } else {
        emit({ type: "check_failed", sectionKey: section.key, rule: ruleName, detail });
        checksFailed++;
        details.push(detail);
      }
    }

    const audit = auditCitations(blocks, data, section.familyIds);
    if (audit.pass) {
      emit({ type: "check_passed", sectionKey: section.key, rule: "citations" });
      checksPassed++;
    } else {
      emit({ type: "check_failed", sectionKey: section.key, rule: "citations", detail: audit.failures.join("; ") });
      checksFailed++;
      details.push(...audit.failures);
    }

    return details;
  };

  try {
    // Rule 1: announce the run, build the source pack, surface each source.
    emit({
      type: "run_started",
      sectionKeys: content.sections.map((s) => s.key),
      blueprintRev,
      ...(orderedMemories.length ? { memoryIds: orderedMemories.map((m) => m.id) } : {}),
      ...(period ? { period } : {}),
      ...(gaps && gaps.length ? { gaps } : {}),
    });
    const pack = await buildSourcePack(files);
    for (const src of pack.sources) {
      emit({ type: "source_read", sourceId: src.id, label: src.label, summary: src.summary });
    }

    // Rule 2: process sections in `number` order.
    const ordered = [...content.sections].sort((a, b) => a.number - b.number);
    for (const section of ordered) {
      const sectionStart = Date.now();

      // Rule 3: drain live inputs (steer / answer / pause-resume).
      await drainInputs();
      // Rule 4 (before draft): questions whose deadline is this section fall back.
      applyFallbacks(section.key);

      // Rule 2: fixed sections take no model call.
      if (section.mode === "fixed") {
        emit({ type: "section_started", sectionKey: section.key });
        const blocks = parseSectionText(section.fixedText ?? "");
        completed.push({ key: section.key, heading: section.heading, blocks });
        emit({ type: "section_completed", sectionKey: section.key, blocks, words: countWords(blocks), ms: Date.now() - sectionStart, retries: 0 });
        continue;
      }

      // Rule 5: draft the section, wiring streaming/question/flag callbacks.
      // A refusal is contained to this section (emit `section_failed`, skip it,
      // keep going); any other draft error propagates and fails the whole run.
      emit({ type: "section_started", sectionKey: section.key });
      const cb = makeCallbacks(section.key);
      const prevSection = previousDocument?.sections.find((s) => s.key === section.key);
      const previousSectionText = prevSection ? blocksToPlainText(prevSection.blocks) : undefined;
      const dataBlock = sectionDataBlock(section, data, pack);
      try {
        let draft = await draftSection({ client, content, section, dataBlock, completed, steers, answers, previousSectionText, memories, cb });
        let blocks = draft.blocks;
        // Rule 4 (same section): a question raised during this draft, deadlined here, falls back now.
        applyFallbacks(section.key);

        // Rule 6: checks, with at most one retry, then flag-and-keep.
        let retries = 0;
        let failures = runChecks(section, blocks);
        if (failures.length > 0) {
          emit({ type: "retry_started", sectionKey: section.key, reason: failures.join("; ") });
          retries = 1;
          totalRetries++;
          // An answer or steer posted while the first draft was being written or
          // checked must reach the redraft (v1.1 spec §4b).
          await drainInputs();
          draft = await draftSection({ client, content, section, dataBlock, completed, steers, answers, retryFeedback: failures.join("; "), previousSectionText, memories, cb });
          blocks = draft.blocks;
          applyFallbacks(section.key);
          failures = runChecks(section, blocks);
          if (failures.length > 0) {
            raiseFlag(section.key, `Section '${section.heading}' failed checks: ${failures.join("; ")}. Keep it anyway?`, ["Keep", "Redraft next run"]);
          }
        }

        // Rule 7: review sections get a flag unless the model already raised one.
        if (section.mode === "review" && !modelFlaggedSections.has(section.key)) {
          raiseFlag(section.key, `Review '${section.heading}' before release.`, ["Approve", "Needs work"]);
        }

        completed.push({ key: section.key, heading: section.heading, blocks });
        emit({ type: "section_completed", sectionKey: section.key, blocks, words: countWords(blocks), ms: Date.now() - sectionStart, retries });
      } catch (err) {
        if (err instanceof RefusalError) {
          emit({ type: "section_failed", sectionKey: section.key, error: err.message });
          continue;
        }
        throw err;
      }
    }

    // Rule 8: render, assemble the document, tally stats, complete.
    emit({ type: "render_started" });
    const document: RunDocument = {
      title: content.title,
      eyebrow: content.eyebrow,
      dateline: content.dateline,
      sections: completed,
    };
    const stats: RunStats = {
      durationMs: Date.now() - runStart,
      words: completed.reduce((n, s) => n + countWords(s.blocks), 0),
      sourcesUsed: pack.sources.length,
      checksPassed,
      checksFailed,
      flagCount,
      citationCount: completed.reduce((n, s) => n + countCitations(s.blocks), 0),
      retries: totalRetries,
    };
    emit({ type: "run_completed", stats, document });
    return { document, stats };
  } catch (err) {
    // Rule 9: surface the failure, then propagate.
    emit({ type: "run_failed", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}
