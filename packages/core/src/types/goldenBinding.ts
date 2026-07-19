import { z } from "zod";
import type { RunDocument } from "./document.js";

/**
 * Golden binding inventory (v1.5 spec §2). Two forms share the item shape:
 * the agent submits `SubmittedInventory` (binding = familyId+sql only);
 * verification stamps verifiedValue+status to produce the stored
 * `BindingInventory`. Boundness (bound/total) is always derived, never stored.
 */
const ID_RE = /^[a-z][a-z0-9_]*$/;

export const BindingAnchorSchema = z.object({
  sectionKey: z.string().min(1),
  blockIndex: z.number().int().min(0),
  spanIndex: z.number().int().min(0).nullable(),
}).strict();
export type BindingAnchor = z.infer<typeof BindingAnchorSchema>;

const itemBase = {
  id: z.string().regex(ID_RE),
  kind: z.enum(["value", "table"]),
  anchor: BindingAnchorSchema,
  raw: z.string().min(1).max(200),
  parsed: z.union([z.number(), z.string()]).nullable(),
  reason: z.string().nullable(),
};

export const BindingResultSchema = z.object({
  familyId: z.string().min(1),
  sql: z.string().min(1),
  verifiedValue: z.union([z.number(), z.string()]).nullable(),
  status: z.enum(["bound", "mismatch", "error"]),
}).strict();

const requireReasonWhenUnbound = <T extends { binding: unknown; reason: string | null }>(it: T, ctx: z.RefinementCtx) => {
  const status = (it.binding as { status?: string } | null)?.status;
  if ((it.binding === null || (status !== undefined && status !== "bound")) && it.reason === null)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "reason required when not bound" });
};

export const BindingItemSchema = z.object({ ...itemBase, binding: BindingResultSchema.nullable() })
  .strict().superRefine(requireReasonWhenUnbound);
export type BindingItem = z.infer<typeof BindingItemSchema>;

export const SubmittedBindingSchema = z.object({ familyId: z.string().min(1), sql: z.string().min(1) }).strict();
export const SubmittedItemSchema = z.object({ ...itemBase, binding: SubmittedBindingSchema.nullable() })
  .strict().superRefine(requireReasonWhenUnbound);
export type SubmittedItem = z.infer<typeof SubmittedItemSchema>;

export const BindingInventorySchema = z.object({ version: z.literal(1), items: z.array(BindingItemSchema).max(60) }).strict();
export type BindingInventory = z.infer<typeof BindingInventorySchema>;
export const SubmittedInventorySchema = z.object({ version: z.literal(1), items: z.array(SubmittedItemSchema).max(60) }).strict();
export type SubmittedInventory = z.infer<typeof SubmittedInventorySchema>;

/** Throws on the first bad anchor or duplicate id — byte-exact messages, spec §11. */
export function validateInventoryAnchors(
  inventory: { items: { id: string; kind: "value" | "table"; anchor: BindingAnchor }[] },
  document: RunDocument,
): void {
  const seen = new Set<string>();
  for (const it of inventory.items) {
    if (seen.has(it.id)) throw new Error(`duplicate item id: ${it.id}`);
    seen.add(it.id);
    const { sectionKey, blockIndex, spanIndex } = it.anchor;
    const section = document.sections.find((s) => s.key === sectionKey);
    if (!section) throw new Error(`unknown section: ${sectionKey}`);
    if (blockIndex >= section.blocks.length) throw new Error(`block index out of range: ${sectionKey}[${blockIndex}]`);
    const block = section.blocks[blockIndex];
    if (it.kind === "value") {
      if (block.type !== "paragraph" || spanIndex === null) throw new Error(`anchor kind mismatch: ${it.id}`);
      if (spanIndex >= block.spans.length) throw new Error(`span index out of range: ${sectionKey}[${blockIndex}][${spanIndex}]`);
    } else {
      if (block.type !== "table" || spanIndex !== null) throw new Error(`anchor kind mismatch: ${it.id}`);
    }
  }
}
