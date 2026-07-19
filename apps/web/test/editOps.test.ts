import { describe, it, expect } from "vitest";
import type { BlueprintContent, BlueprintSection, EditOp } from "@runoff/core";
import { applyEditOp, invertEditOp } from "../lib/editOps";

function section(key: string, number: number): BlueprintSection {
  return { key, number, heading: key.toUpperCase(), mode: "auto", instruction: `about ${key}`, familyIds: [], queries: [], rules: [] };
}

const content: BlueprintContent = {
  title: "Report", clientName: "Client", eyebrow: "EB", dateline: "June 2026",
  sections: [section("a", 1), section("b", 2), section("c", 3)],
  globalRules: ["be brief"],
  delivery: { recipient: "x@y.z", autoDeliverOnClear: false },
};

describe("applyEditOp / invertEditOp", () => {
  it("edit_section patches only named fields and round-trips through its inverse", () => {
    const op: EditOp = { type: "edit_section", key: "b", before: { instruction: "about b" }, after: { instruction: "tighter b" } };
    const next = applyEditOp(content, op);
    expect(next.sections[1].instruction).toBe("tighter b");
    expect(next.sections[1].heading).toBe("B");
    expect(applyEditOp(next, invertEditOp(op))).toEqual(content);
  });

  it("add_section inserts after the anchor, renumbers, and inverts to a removal", () => {
    const fresh = { ...section("d", 0) };
    const op: EditOp = { type: "add_section", afterKey: "a", section: fresh };
    const next = applyEditOp(content, op);
    expect(next.sections.map((s) => s.key)).toEqual(["a", "d", "b", "c"]);
    expect(next.sections.map((s) => s.number)).toEqual([1, 2, 3, 4]);
    expect(applyEditOp(next, invertEditOp(op))).toEqual(content);
  });

  it("add_section with afterKey null appends at the end", () => {
    const next = applyEditOp(content, { type: "add_section", afterKey: null, section: section("z", 0) });
    expect(next.sections.map((s) => s.key)).toEqual(["a", "b", "c", "z"]);
  });

  it("remove_section deletes, renumbers, and inverts to a positioned re-add", () => {
    const op: EditOp = { type: "remove_section", afterKey: "a", removed: section("b", 2) };
    const next = applyEditOp(content, op);
    expect(next.sections.map((s) => s.key)).toEqual(["a", "c"]);
    expect(next.sections.map((s) => s.number)).toEqual([1, 2]);
    expect(applyEditOp(next, invertEditOp(op))).toEqual(content);
  });

  it("remove_section of the head (afterKey null) inverts to a head re-add", () => {
    const op: EditOp = { type: "remove_section", afterKey: null, removed: section("a", 1) };
    const next = applyEditOp(content, op);
    expect(next.sections.map((s) => s.key)).toEqual(["b", "c"]);
    expect(next.sections.map((s) => s.number)).toEqual([1, 2]);
    expect(applyEditOp(next, invertEditOp(op))).toEqual(content);
  });

  it("add_section with at:head inserts first, renumbers, and inverts to pristine", () => {
    const op: EditOp = { type: "add_section", afterKey: null, at: "head", section: section("x", 0) };
    const next = applyEditOp(content, op);
    expect(next.sections.map((s) => s.key)).toEqual(["x", "a", "b", "c"]);
    expect(next.sections.map((s) => s.number)).toEqual([1, 2, 3, 4]);
    expect(applyEditOp(next, invertEditOp(op))).toEqual(content);
  });

  it("update_masthead and update_global_rules round-trip", () => {
    const m: EditOp = { type: "update_masthead", before: { title: "Report" }, after: { title: "New Report" } };
    expect(applyEditOp(content, m).title).toBe("New Report");
    expect(applyEditOp(applyEditOp(content, m), invertEditOp(m))).toEqual(content);

    const g: EditOp = { type: "update_global_rules", before: ["be brief"], after: ["be brief", "no jargon"] };
    expect(applyEditOp(content, g).globalRules).toEqual(["be brief", "no jargon"]);
    expect(applyEditOp(applyEditOp(content, g), invertEditOp(g))).toEqual(content);
  });
});
