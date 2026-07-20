import { BindingInventorySchema, type BindingInventory } from "./types/goldenBinding.js";

/** Parse stored bindings JSON, degrading corrupt/schema-drifted input to null (v1.5 contract). */
export function parseBindings(raw: string | null): BindingInventory | null {
  if (!raw) return null;
  try {
    return BindingInventorySchema.parse(JSON.parse(raw)) as BindingInventory;
  } catch {
    return null;
  }
}

/** The single boundness counting rule (engine boundnessLine and the UI both format from this). */
export function boundnessCounts(inv: BindingInventory | null): { bound: number; mismatch: number; total: number } | null {
  if (!inv) return null;
  const bound = inv.items.filter((i) => i.binding?.status === "bound").length;
  const mismatch = inv.items.filter((i) => i.binding?.status === "mismatch").length;
  return { bound, mismatch, total: inv.items.length };
}
