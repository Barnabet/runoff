import { describe, expect, it } from "vitest";
import { boundnessCounts, parseBindings } from "../src/bindings.js";

const inv = {
  version: 1,
  items: [
    { id: "a", kind: "value", anchor: { sectionKey: "s", blockIndex: 0, spanIndex: 0 }, raw: "1", parsed: 1,
      binding: { familyId: "f", sql: "SELECT 1", verifiedValue: 1, status: "bound" }, reason: null },
    { id: "b", kind: "value", anchor: { sectionKey: "s", blockIndex: 0, spanIndex: 1 }, raw: "2", parsed: 2,
      binding: { familyId: "f", sql: "SELECT 2", verifiedValue: 3, status: "mismatch" }, reason: "value mismatch" },
    { id: "c", kind: "value", anchor: { sectionKey: "s", blockIndex: 0, spanIndex: 2 }, raw: "3", parsed: 3,
      binding: null, reason: "no family" },
  ],
};

describe("parseBindings", () => {
  it("parses a valid stored inventory", () => {
    expect(parseBindings(JSON.stringify(inv))?.items).toHaveLength(3);
  });
  it("degrades null, corrupt JSON, and schema drift to null", () => {
    expect(parseBindings(null)).toBeNull();
    expect(parseBindings("{not json")).toBeNull();
    expect(parseBindings(JSON.stringify({ version: 1, items: [{ garbage: true }] }))).toBeNull();
  });
});

describe("boundnessCounts", () => {
  it("null inventory → null", () => expect(boundnessCounts(null)).toBeNull());
  it("counts bound/mismatch/total", () => {
    expect(boundnessCounts(inv as never)).toEqual({ bound: 1, mismatch: 1, total: 3 });
  });
  it("empty inventory → zero counts, not null", () => {
    expect(boundnessCounts({ version: 1, items: [] } as never)).toEqual({ bound: 0, mismatch: 0, total: 0 });
  });
});
