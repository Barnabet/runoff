import type { BlueprintSection } from "./blueprint.js";

export interface MastheadPatch {
  title?: string;
  clientName?: string;
  eyebrow?: string;
  dateline?: string;
}

/**
 * An invertible edit the copilot applied to the Builder draft. `before`/`after`
 * carry full values for exactly the fields the op touched, so the client can
 * apply, render a field diff, and revert without another server round-trip.
 * `remove_section`/`add_section` carry `afterKey` (the key of the section that
 * precedes the position, null = end) so each is the other's inverse. On
 * `add_section`, `at: "head"` overrides the position to insert first, regardless
 * of `afterKey`; it is used only by inversion of head removals (afterKey null).
 */
export type EditOp =
  | { type: "edit_section"; key: string; before: Partial<BlueprintSection>; after: Partial<BlueprintSection> }
  | { type: "add_section"; afterKey: string | null; at?: "head"; section: BlueprintSection }
  | { type: "remove_section"; afterKey: string | null; removed: BlueprintSection }
  | { type: "update_masthead"; before: MastheadPatch; after: MastheadPatch }
  | { type: "update_global_rules"; before: string[]; after: string[] };

/** What an assistant turn did, persisted as JSON on copilot_messages.actions. */
export type CopilotAction =
  | { kind: "tool"; tool: string; label: string }
  | { kind: "edit"; op: EditOp }
  | { kind: "memory"; memoryId: string; body: string };

export interface MemoryRow {
  id: string;
  scope: "blueprint" | "project";
  projectId: string;
  blueprintId: string | null;
  body: string;
  source: "copilot" | "distilled";
  originId: string | null;
  status: "active" | "disabled";
  createdAt: string;
}

export interface GoldenRow {
  id: string;
  blueprintId: string;
  kind: "run" | "section" | "exemplar";
  runId: string | null;
  sectionKey: string | null;
  name: string | null;
  mime: string | null;
  storedFilename: string | null;
  note: string | null;
  createdAt: string;
}
