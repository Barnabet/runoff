import type OpenAI from "openai";
import {
  ClassifyProposalSchema,
  PERIOD_REGEX,
  type ClassifyProposal,
  type FamilyKind,
  type Granularity,
} from "@runoff/core";
import { MODEL } from "./prompts.js";

export interface ClassifyFamily {
  key: string;
  label: string;
  kind: FamilyKind;
  granularity: Granularity | null;
}

/**
 * Propose where one uploaded file belongs in the project's family/period
 * taxonomy. One chat call, JSON-object response. Returns null on ANY failure —
 * API error, unparseable output, schema mismatch, or a semantically invalid
 * proposal — the caller treats null as "no proposal; user files manually".
 */
export async function classifySource(opts: {
  client: OpenAI;
  filename: string;
  contentSample: string;
  families: ClassifyFamily[];
}): Promise<ClassifyProposal | null> {
  const familyLines = opts.families.length
    ? opts.families
        .map((f) => `- ${f.key} ("${f.label}"): ${f.kind}${f.granularity ? `, one file per ${f.granularity}` : ""}`)
        .join("\n")
    : "(none yet)";

  let raw: string;
  try {
    const res = await (opts.client as any).chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: "system",
          content:
            `You file uploaded data files into a project's source taxonomy: families of one kind ` +
            `("periodic" = one file per period, or "constant" = reference material with no period), ` +
            `each periodic family having ONE fixed granularity. Existing families:\n${familyLines}\n\n` +
            `Strongly prefer filing into an existing family. Propose a new family only when nothing fits; ` +
            `propose "constant" only for clearly non-periodic reference material. Periods MUST be canonical: ` +
            `quarter "2026-Q1", month "2026-06", year "2026" — matching the family's granularity; null for constant. ` +
            `Return JSON {"familyKey": string, "newFamily"?: {"key","label","kind","granularity"|null}, ` +
            `"period": string|null, "confidence": "high"|"medium"|"low"}. New-family keys are short snake_case slugs.`,
        },
        { role: "user", content: `Filename: ${opts.filename}\n\nContent sample:\n${opts.contentSample.slice(0, 2000)}` },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 500,
    });
    raw = res.choices?.[0]?.message?.content ?? "";
  } catch {
    return null;
  }

  let parsed: ClassifyProposal;
  try {
    const r = ClassifyProposalSchema.safeParse(JSON.parse(raw));
    if (!r.success) return null;
    parsed = r.data;
  } catch {
    return null;
  }

  const existing = opts.families.find((f) => f.key === parsed.familyKey);
  if (existing) {
    if (parsed.newFamily) return null;
    if (existing.kind === "constant") return parsed.period === null ? parsed : null;
    return parsed.period !== null && PERIOD_REGEX[existing.granularity as Granularity].test(parsed.period) ? parsed : null;
  }
  const nf = parsed.newFamily;
  if (!nf || nf.key !== parsed.familyKey) return null;
  if (nf.kind === "constant") return nf.granularity === null && parsed.period === null ? parsed : null;
  if (nf.granularity === null) return null;
  return parsed.period !== null && PERIOD_REGEX[nf.granularity].test(parsed.period) ? parsed : null;
}
