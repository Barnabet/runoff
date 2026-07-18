import type { BlueprintContent, BlueprintSection, EditOp } from "@runoff/core";

function renumber(sections: BlueprintSection[]): BlueprintSection[] {
  return sections.map((s, i) => ({ ...s, number: i + 1 }));
}

function insertAfter(sections: BlueprintSection[], afterKey: string | null, section: BlueprintSection): BlueprintSection[] {
  const idx = afterKey === null ? sections.length : sections.findIndex((s) => s.key === afterKey) + 1;
  const at = afterKey !== null && idx === 0 ? sections.length : idx; // unknown anchor → append
  return renumber([...sections.slice(0, at), section, ...sections.slice(at)]);
}

/** Apply one copilot edit op to a draft. Pure; unknown keys are no-ops for edit, append for add. */
export function applyEditOp(content: BlueprintContent, op: EditOp): BlueprintContent {
  switch (op.type) {
    case "edit_section":
      return { ...content, sections: content.sections.map((s) => (s.key === op.key ? { ...s, ...op.after } : s)) };
    case "add_section":
      return { ...content, sections: insertAfter(content.sections, op.afterKey, op.section) };
    case "remove_section":
      return { ...content, sections: renumber(content.sections.filter((s) => s.key !== op.removed.key)) };
    case "update_masthead":
      return { ...content, ...op.after };
    case "update_global_rules":
      return { ...content, globalRules: op.after };
  }
}

/** The op that undoes `op`. apply(apply(c, op), invert(op)) === c. */
export function invertEditOp(op: EditOp): EditOp {
  switch (op.type) {
    case "edit_section":
      return { ...op, before: op.after, after: op.before };
    case "add_section":
      return { type: "remove_section", afterKey: op.afterKey, removed: op.section };
    case "remove_section":
      return { type: "add_section", afterKey: op.afterKey, section: op.removed };
    case "update_masthead":
      return { ...op, before: op.after, after: op.before };
    case "update_global_rules":
      return { ...op, before: op.after, after: op.before };
  }
}
