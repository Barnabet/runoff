import type OpenAI from "openai";
import { MODEL } from "./prompts.js";

export interface RunInteractions {
  steers: string[];
  answers: { question: string; answer: string }[];
  flagResolutions: { question: string; resolution: string }[];
}

const MAX_MEMORIES_PER_RUN = 3;
const MAX_MEMORY_CHARS = 500;

/**
 * Turn one run's human interventions into 0–3 durable, generalized memories.
 * Returns [] (never throws) when there is nothing to learn, the model output is
 * unparseable, or every candidate duplicates an existing memory — the caller
 * (the worker, post-completion) must never be affected by distillation failure.
 */
export async function distillRun(opts: {
  client: OpenAI;
  title: string;
  sectionHeadings: string[];
  interactions: RunInteractions;
  existing: string[];
}): Promise<string[]> {
  const { steers, answers, flagResolutions } = opts.interactions;
  if (!steers.length && !answers.length && !flagResolutions.length) return [];

  const lines: string[] = [];
  if (steers.length) lines.push(`Steers the user sent mid-run:\n${steers.map((s) => `- ${s}`).join("\n")}`);
  if (answers.length) lines.push(`Questions the user answered:\n${answers.map((a) => `- Q: ${a.question} A: ${a.answer}`).join("\n")}`);
  if (flagResolutions.length) lines.push(`Flags the user resolved:\n${flagResolutions.map((f) => `- ${f.question} → ${f.resolution}`).join("\n")}`);

  let raw: string;
  try {
    const res = await (opts.client as any).chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            `You distill a report-automation run's human interventions into durable standing guidance ` +
            `for future runs of the same blueprint ("${opts.title}", sections: ${opts.sectionHeadings.join(", ")}). ` +
            `Return JSON {"memories": string[]} with 0-${MAX_MEMORIES_PER_RUN} entries. Each entry must be a ` +
            `generalized preference that will apply to every future run (e.g. "Always express spend deltas in ` +
            `percentages"), never a one-off fact about this period's data. Return {"memories": []} when nothing generalizes.`,
        },
        { role: "user", content: lines.join("\n\n") },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 1000,
    });
    raw = res.choices?.[0]?.message?.content ?? "";
  } catch {
    return [];
  }

  let parsed: { memories?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const candidates = Array.isArray(parsed.memories)
    ? parsed.memories.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
    : [];
  const seen = new Set(opts.existing.map((e) => e.trim().toLowerCase()));
  return candidates
    .map((m) => m.trim().slice(0, MAX_MEMORY_CHARS))
    .filter((m) => !seen.has(m.toLowerCase()))
    .slice(0, MAX_MEMORIES_PER_RUN);
}
