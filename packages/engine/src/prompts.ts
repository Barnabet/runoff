import type { BlueprintContent, BlueprintSection, DocSection } from "@runoff/core";
import { blocksToPlainText } from "@runoff/core";
import { packForPrompt, type SourcePack } from "./sourcePack.js";

export const MODEL = process.env.RUNOFF_MODEL ?? "gpt-5.6-sol";

/**
 * Global rules + dialect contract. STABLE per blueprint — no timestamps or
 * per-section content — so it is byte-identical across every section of a run.
 * Per-section content goes in the user turn.
 */
export function systemPrompt(content: BlueprintContent): string {
  const globalRules = content.globalRules.length
    ? `\n\nGlobal rules for this report:\n${content.globalRules.map((r) => `- ${r}`).join("\n")}`
    : "";

  return `You are drafting one section of a formal business report for ${content.clientName}. \
Write in the report's dialect exactly as specified below. Ground every claim in the sources bound \
to this section; never invent figures.

Dialect contract: write plain paragraphs separated by blank lines; NO markdown headings/bold/lists; \
tables as GitHub markdown tables; every figure sourced from data must be written as \
[[numeral|sourceId|locator]] — the first field is the exact text the reader sees, so it must be the \
actual number (e.g. [[220,500|src_ab12|sum(src_ab12.amount)]]), never the word "figure" or any other \
placeholder; locator is sum|avg|min|max|count(sourceId.column) when derived from a table, else a \
short quote reference; only use sourceIds bound to this section.

Tools: use ask_user only for genuine ambiguity; use raise_flag for judgment calls the rules mark as \
needing review.${globalRules}`;
}

/**
 * Per-section user turn: heading + instruction, the packed sources bound to the
 * section, the plain text of completed sections (continuity), numbered steers,
 * answered questions, and an optional retry-feedback block.
 *
 * PDFs are text-extracted locally into the source pack (see sourcePack.ts), so
 * they flow through `packForPrompt` like any other document — this always
 * returns a plain string.
 */
export function sectionUserPrompt(args: {
  section: BlueprintSection;
  pack: SourcePack;
  completed: DocSection[];
  steers: string[];
  answers: { question: string; answer: string }[];
  retryFeedback?: string;
}): string {
  const { section, pack, completed, steers, answers, retryFeedback } = args;

  const parts: string[] = [
    `Section ${section.number}: ${section.heading}`,
    `Instruction: ${section.instruction}`,
    `\nSources bound to this section:\n${packForPrompt(pack, section.sourceIds)}`,
  ];

  if (section.rules.length) {
    const lines = section.rules.map((r) => {
      const base = `- [${r.kind}] ${r.text}`;
      return r.kind === "assert" && r.expression ? `${base} (expression: ${r.expression})` : base;
    });
    parts.push(
      `\nRules for this section:\n${lines.join("\n")}\n` +
        `(assert rules are verified deterministically after drafting; style rules shape your ` +
        `writing; judgment rules should prompt raise_flag when triggered.)`,
    );
  }

  if (completed.length) {
    const prior = completed
      .map((s) => `${s.heading}\n${blocksToPlainText(s.blocks)}`)
      .join("\n\n");
    parts.push(`\nSections already written (for continuity — do not repeat their content):\n${prior}`);
  }

  if (steers.length) {
    parts.push(`\nUser steers:\n${steers.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
  }

  if (answers.length) {
    const qa = answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n");
    parts.push(`\nAnswered questions:\n${qa}`);
  }

  if (retryFeedback) {
    parts.push(
      `\nA previous draft failed checks: ${retryFeedback}\n` +
        `Fix and redraft the full section. Cite a figure by wrapping the numeral itself in the ` +
        `marker — [[220,500|sourceId|locator]] — the visible text must be the actual number, ` +
        `never the word "figure".`,
    );
  }

  parts.push(`\nWrite the section now.`);
  return parts.join("\n");
}
