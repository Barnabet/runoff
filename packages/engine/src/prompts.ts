import type { BlueprintContent, BlueprintSection, DocSection } from "@runoff/core";
import { blocksToPlainText } from "@runoff/core";
import { packForPrompt, type SourcePack } from "./sourcePack.js";

export const MODEL = "claude-opus-4-8";

/**
 * Global rules + dialect contract. STABLE per blueprint — no timestamps or
 * per-section content — so it is byte-identical across every section of a run
 * and can carry `cache_control`. Per-section content goes in the user turn.
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
[[figure|sourceId|locator]] where locator is sum|avg|min|max|count(sourceId.column) when derived \
from a table, else a short quote reference; only use sourceIds bound to this section.

Tools: use ask_user only for genuine ambiguity; use raise_flag for judgment calls the rules mark as \
needing review.${globalRules}`;
}

/**
 * Per-section user turn: heading + instruction, the packed sources bound to the
 * section, the plain text of completed sections (continuity), numbered steers,
 * answered questions, and an optional retry-feedback block.
 *
 * When a bound source is a PDF, returns a content-block array (document block(s)
 * with base64 + a text block) so Claude reads the PDF at run time; otherwise a
 * plain string.
 */
export function sectionUserPrompt(args: {
  section: BlueprintSection;
  pack: SourcePack;
  completed: DocSection[];
  steers: string[];
  answers: { question: string; answer: string }[];
  retryFeedback?: string;
}): string | any[] {
  const { section, pack, completed, steers, answers, retryFeedback } = args;

  const parts: string[] = [
    `Section ${section.number}: ${section.heading}`,
    `Instruction: ${section.instruction}`,
    `\nSources bound to this section:\n${packForPrompt(pack, section.sourceIds)}`,
  ];

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
    parts.push(`\nA previous draft failed checks: ${retryFeedback}\nFix and redraft the full section.`);
  }

  parts.push(`\nWrite the section now.`);
  const prompt = parts.join("\n");

  const pdfs = pack.sources.filter(
    (s) => section.sourceIds.includes(s.id) && s.kind === "pdf" && s.pdfBase64,
  );
  if (pdfs.length) {
    return [
      ...pdfs.map((s) => ({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: s.pdfBase64 },
      })),
      { type: "text", text: prompt },
    ];
  }

  return prompt;
}
