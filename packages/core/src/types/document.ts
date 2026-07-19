import { z } from "zod";

export interface Citation { sourceId: string; locator: string }
export interface Span { text: string; citation?: Citation }
export type Block =
  | { type: "paragraph"; spans: Span[] }
  | { type: "table"; columns: string[]; rows: { cells: Span[][] }[] };
export interface DocSection { key: string; heading: string; blocks: Block[] }
export interface RunDocument { title: string; eyebrow: string; dateline: string; sections: DocSection[] }

export function blocksToPlainText(blocks: Block[]): string {
  return blocks.map((b) =>
    b.type === "paragraph"
      ? b.spans.map((s) => s.text).join("")
      : b.rows.map((r) => r.cells.map((c) => c.map((s) => s.text).join("")).join(" · ")).join("\n")
  ).join("\n\n");
}

export function countWords(blocks: Block[]): number {
  return blocksToPlainText(blocks).split(/\s+/).filter(Boolean).length;
}

// ---- zod schemas (v1.5): validation for the shapes above ---------------------
const KEY_RE = /^[a-z][a-z0-9_]*$/;

export const CitationSchema = z.object({ sourceId: z.string().min(1), locator: z.string().min(1) }).strict();
export const SpanSchema = z.object({ text: z.string(), citation: CitationSchema.optional() }).strict();
export const BlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("paragraph"), spans: z.array(SpanSchema) }).strict(),
  z.object({
    type: z.literal("table"),
    columns: z.array(z.string()),
    rows: z.array(z.object({ cells: z.array(z.array(SpanSchema)) }).strict()),
  }).strict(),
]);
export const DocSectionSchema = z.object({
  key: z.string().regex(KEY_RE), heading: z.string().min(1), blocks: z.array(BlockSchema),
}).strict();
export const RunDocumentSchema = z.object({
  title: z.string(), eyebrow: z.string(), dateline: z.string(), sections: z.array(DocSectionSchema),
}).strict().superRefine((doc, ctx) => {
  const seen = new Set<string>();
  for (const s of doc.sections) {
    if (seen.has(s.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate section key: ${s.key}` });
    seen.add(s.key);
  }
});
