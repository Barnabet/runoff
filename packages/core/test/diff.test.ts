import { describe, it, expect } from "vitest";
import { diffRuns, parseFigure } from "../src/diff.js";
import type { RunDocument, Block } from "../src/types/document.js";

function doc(sections: { key: string; blocks: Block[] }[]): RunDocument {
  return {
    title: "T",
    eyebrow: "E",
    dateline: "D",
    sections: sections.map((s) => ({ ...s, heading: s.key })),
  };
}

const cite = (text: string, sourceId: string, locator: string) => ({
  text,
  citation: { sourceId, locator },
});

describe("parseFigure", () => {
  it("strips $, commas and % before parsing", () => {
    expect(parseFigure("$220,500")).toBe(220500);
    expect(parseFigure("3.5%")).toBe(3.5);
    expect(Number.isNaN(parseFigure("figure"))).toBe(true);
  });
});

describe("diffRuns", () => {
  it("emits a delta when a cited figure changes, keyed by sourceId|locator", () => {
    const prev = doc([{ key: "kpi", blocks: [
      { type: "paragraph", spans: [{ text: "Spend " }, cite("$208,200", "src_a", "sum(src_a.amount)")] },
    ]}]);
    const cur = doc([{ key: "kpi", blocks: [
      { type: "paragraph", spans: [{ text: "Spend " }, cite("$220,500", "src_a", "sum(src_a.amount)")] },
    ]}]);
    const diff = diffRuns(cur, prev);
    expect(diff.deltas).toEqual([
      { sectionKey: "kpi", sourceId: "src_a", locator: "sum(src_a.amount)", before: 208200, after: 220500 },
    ]);
    expect(diff.sections).toEqual({ kpi: "changed" });
  });

  it("drops equal values and non-numeric pairs; first parseable occurrence wins", () => {
    const prev = doc([{ key: "kpi", blocks: [
      { type: "paragraph", spans: [
        cite("100", "src_a", "sum"),
        cite("999", "src_a", "sum"), // second occurrence of same key — ignored
        cite("same", "src_a", "max"), // non-numeric — ignored
      ] },
    ]}]);
    const cur = doc([{ key: "kpi", blocks: [
      { type: "paragraph", spans: [cite("100", "src_a", "sum"), cite("7", "src_a", "max")] },
    ]}]);
    // sum: 100 -> 100 equal (first occurrence wins on both sides); max: prev non-numeric.
    expect(diffRuns(cur, prev).deltas).toEqual([]);
  });

  it("finds cited figures inside table cells", () => {
    const prev = doc([{ key: "ch", blocks: [
      { type: "table", columns: ["Channel", "Spend"], rows: [
        { cells: [[{ text: "Search" }], [cite("100,200", "src_a", "sum(src_a.amount where channel=search)")]] },
      ] },
    ]}]);
    const cur = doc([{ key: "ch", blocks: [
      { type: "table", columns: ["Channel", "Spend"], rows: [
        { cells: [[{ text: "Search" }], [cite("110,000", "src_a", "sum(src_a.amount where channel=search)")]] },
      ] },
    ]}]);
    const diff = diffRuns(cur, prev);
    expect(diff.deltas).toHaveLength(1);
    expect(diff.deltas[0].before).toBe(100200);
    expect(diff.deltas[0].after).toBe(110000);
  });

  it("classifies sections: new, removed, changed, unchanged", () => {
    const shared: Block[] = [{ type: "paragraph", spans: [{ text: "Same text." }] }];
    const prev = doc([
      { key: "a", blocks: shared },
      { key: "gone", blocks: [{ type: "paragraph", spans: [{ text: "Old." }] }] },
      { key: "b", blocks: [{ type: "paragraph", spans: [{ text: "Before." }] }] },
    ]);
    const cur = doc([
      { key: "a", blocks: shared },
      { key: "b", blocks: [{ type: "paragraph", spans: [{ text: "After." }] }] },
      { key: "fresh", blocks: [{ type: "paragraph", spans: [{ text: "New." }] }] },
    ]);
    expect(diffRuns(cur, prev).sections).toEqual({
      a: "unchanged",
      b: "changed",
      gone: "removed",
      fresh: "new",
    });
  });
});
