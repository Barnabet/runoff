import { PERIOD_REGEX, RunDocumentSchema, type RunDocument } from "@runoff/core";
import { MODEL } from "./prompts.js";

/** Head+tail sample long exemplars: first 20k + last 4k of a >24k text (spec §3). */
export function capExemplarText(text: string): string {
  if (text.length <= 24000) return text;
  return `${text.slice(0, 20000)}\n…\n${text.slice(-4000)}`;
}

/** Reports, not data: tabular exemplars are not unified (spec §3). */
export function isUnsupportedExemplarMime(mime: string): boolean {
  return mime === "text/csv" || mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

const UNIFY_CONTRACT = `You convert a report file into Runoff's universal document JSON.
Return ONLY a JSON object: {"document": {...}, "period": "2026-Q1" | null}.
document = {"title","eyebrow","dateline","sections":[{"key","heading","blocks":[...]}]}.
Blocks: {"type":"paragraph","spans":[{"text":"..."}]} or {"type":"table","columns":[...],"rows":[{"cells":[[{"text":"..."}], ...]}]}.
Rules:
- Preserve the original wording VERBATIM wherever possible. Restructure, never paraphrase.
- Section keys: lowercase snake_case (^[a-z][a-z0-9_]*$), unique.
- Put each figure that comes from data in its own span within its paragraph (e.g. "reached ", "$4.2M", " this quarter" as three spans) so figures are individually addressable.
- Tabular content in the report becomes table blocks, one row per data row (keep total rows if the report shows them).
- No citations: spans carry text only.
- period: the period this report covers, as "YYYY-Q<n>", "YYYY-MM", or "YYYY" — null if unclear.`;

const isDegenerateDoc = (doc: RunDocument): string | null => {
  if (doc.sections.length === 0) return "the document has zero sections";
  const hasContent = doc.sections.some((s) =>
    s.blocks.some((b) => (b.type === "paragraph" ? b.spans.some((sp) => sp.text.trim()) : b.rows.length > 0)));
  return hasContent ? null : "every block is empty";
};

export async function unifyGoldenReport(opts: {
  client: unknown; filename: string; text: string;
}): Promise<{ document: RunDocument; period: string | null } | null> {
  const messages: { role: "system" | "user"; content: string }[] = [
    { role: "system", content: UNIFY_CONTRACT },
    { role: "user", content: `File: ${opts.filename}\n\n${capExemplarText(opts.text)}` },
  ];
  // 2 structural attempts + at most 1 degeneracy retry (spec §3): the loop
  // below allows 2 base attempts; a degenerate success consumes one attempt
  // and appends the reason, exactly once.
  let degenerateRetried = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    let content: string;
    try {
      const res = await (opts.client as {
        chat: { completions: { create: (a: unknown) => Promise<{ choices: { message: { content: string | null } }[] }> } };
      }).chat.completions.create({
        model: MODEL, messages, response_format: { type: "json_object" }, max_completion_tokens: 4000,
      });
      content = res.choices[0]?.message?.content ?? "";
    } catch { return null; }
    try {
      const parsed = JSON.parse(content) as { document?: unknown; period?: unknown };
      const document = RunDocumentSchema.parse(parsed.document);
      const degenerate = isDegenerateDoc(document);
      if (degenerate && !degenerateRetried) {
        degenerateRetried = true;
        messages.push({ role: "user", content: `That document is degenerate: ${degenerate}. Produce the full document.` });
        attempt--; // degeneracy retry does not consume a structural attempt
        continue;
      }
      if (degenerate) return null;
      const rawPeriod = typeof parsed.period === "string" ? parsed.period : null;
      const period = rawPeriod && Object.values(PERIOD_REGEX).some((re) => re.test(rawPeriod)) ? rawPeriod : null;
      return { document, period };
    } catch {
      messages.push({ role: "user", content: "That was not valid document JSON. Return exactly the specified JSON object." });
      continue;
    }
  }
  return null;
}
