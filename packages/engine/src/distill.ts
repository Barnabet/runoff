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
export type DistilledMemory = { body: string; scope: "blueprint" | "project" };

export async function distillRun(opts: {
  client: OpenAI;
  title: string;
  sectionHeadings: string[];
  interactions: RunInteractions;
  existing: { body: string; scope: string }[];
}): Promise<DistilledMemory[]> {
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
            `Return JSON {"memories": [{"body": string, "scope": "blueprint"|"project"}]} with 0-${MAX_MEMORIES_PER_RUN} entries. Each entry must be a ` +
            `generalized preference that will apply to every future run (e.g. "Always express spend deltas in ` +
            `percentages"), never a one-off fact about this period's data. ` +
            `Each entry is {"body": string, "scope": "blueprint"|"project"} — scope "blueprint" for guidance about this document's content or structure, "project" for guidance about the client or its data that applies to every document in the project. ` +
            `Return {"memories": []} when nothing generalizes.`,
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
    ? parsed.memories.filter(
        (m): m is DistilledMemory =>
          !!m &&
          typeof m === "object" &&
          typeof (m as { body?: unknown }).body === "string" &&
          (m as { body: string }).body.trim().length > 0 &&
          ((m as { scope?: unknown }).scope === "blueprint" || (m as { scope?: unknown }).scope === "project"),
      )
    : [];
  // Dedup on lowercased body regardless of scope (an existing project row still
  // knocks out a blueprint-scoped duplicate).
  const seen = new Set(opts.existing.map((e) => e.body.trim().toLowerCase()));
  const out: DistilledMemory[] = [];
  for (const c of candidates) {
    const body = c.body.trim().slice(0, MAX_MEMORY_CHARS);
    const key = body.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ body, scope: c.scope });
    if (out.length >= MAX_MEMORIES_PER_RUN) break;
  }
  return out;
}
