import { describe, expect, it } from "vitest";
import {
  BindingInventorySchema, RunDocumentSchema, SubmittedInventorySchema,
  validateInventoryAnchors, type RunDocument,
} from "../src/index.js";

const DOC: RunDocument = {
  title: "AR Review", eyebrow: "Quarterly", dateline: "Q1 2026",
  sections: [
    { key: "summary", heading: "Summary", blocks: [
      { type: "paragraph", spans: [{ text: "Total reached " }, { text: "$4.2M" }] },
      { type: "table", columns: ["status", "total"], rows: [{ cells: [[{ text: "open" }], [{ text: "1,000" }]] }] },
    ] },
  ],
};

const item = (over: object) => ({
  id: "total", kind: "value" as const,
  anchor: { sectionKey: "summary", blockIndex: 0, spanIndex: 1 },
  raw: "$4.2M", parsed: 4200000, binding: null, reason: "no candidate", ...over,
});

describe("RunDocumentSchema", () => {
  it("accepts the document shape and rejects bad section keys", () => {
    expect(RunDocumentSchema.parse(DOC)).toBeTruthy();
    const bad = { ...DOC, sections: [{ ...DOC.sections[0], key: "Bad Key" }] };
    expect(RunDocumentSchema.safeParse(bad).success).toBe(false);
  });
  it("rejects duplicate section keys", () => {
    const dup = { ...DOC, sections: [DOC.sections[0], DOC.sections[0]] };
    expect(RunDocumentSchema.safeParse(dup).success).toBe(false);
  });
});

describe("inventory schemas", () => {
  it("stored form requires status; submitted form forbids it", () => {
    const stored = { version: 1, items: [item({ binding: { familyId: "fam_1", sql: "SELECT 1", verifiedValue: 4200000, status: "bound" }, reason: null })] };
    expect(BindingInventorySchema.parse(stored)).toBeTruthy();
    const submitted = { version: 1, items: [item({ binding: { familyId: "fam_1", sql: "SELECT 1" }, reason: null })] };
    expect(SubmittedInventorySchema.parse(submitted)).toBeTruthy();
    expect(SubmittedInventorySchema.safeParse(stored).success).toBe(false); // extra keys rejected (strict)
  });
  it("requires reason when unbound", () => {
    expect(BindingInventorySchema.safeParse({ version: 1, items: [item({ reason: null })] }).success).toBe(false);
  });
});

describe("validateInventoryAnchors", () => {
  const inv = (items: object[]) => ({ items }) as never;
  it("accepts valid value and table anchors", () => {
    expect(() => validateInventoryAnchors(inv([
      item({}),
      item({ id: "tbl", kind: "table", anchor: { sectionKey: "summary", blockIndex: 1, spanIndex: null } }),
    ]), DOC)).not.toThrow();
  });
  it("throws byte-exact anchor errors", () => {
    expect(() => validateInventoryAnchors(inv([item({ anchor: { sectionKey: "nope", blockIndex: 0, spanIndex: 0 } })]), DOC))
      .toThrow("unknown section: nope");
    expect(() => validateInventoryAnchors(inv([item({ anchor: { sectionKey: "summary", blockIndex: 9, spanIndex: 0 } })]), DOC))
      .toThrow("block index out of range: summary[9]");
    expect(() => validateInventoryAnchors(inv([item({ anchor: { sectionKey: "summary", blockIndex: 0, spanIndex: 7 } })]), DOC))
      .toThrow("span index out of range: summary[0][7]");
    expect(() => validateInventoryAnchors(inv([item({ id: "t", kind: "table", anchor: { sectionKey: "summary", blockIndex: 0, spanIndex: null } })]), DOC))
      .toThrow("anchor kind mismatch: t");
    expect(() => validateInventoryAnchors(inv([item({ id: "v", kind: "value", anchor: { sectionKey: "summary", blockIndex: 1, spanIndex: null } })]), DOC))
      .toThrow("anchor kind mismatch: v");
    expect(() => validateInventoryAnchors(inv([item({}), item({})]), DOC)).toThrow("duplicate item id: total");
  });
});
