import { describe, it, expect } from "vitest";
import { distillRun, type RunInteractions } from "../src/distill.js";
import { makeFakeClient } from "./fakeClient.js";

const base = { title: "Monthly Performance Report", sectionHeadings: ["Executive summary", "Budget"] };
const none: RunInteractions = { steers: [], answers: [], flagResolutions: [] };

describe("distillRun", () => {
  it("returns [] without an LLM call when the run had no interactions", async () => {
    let called = false;
    const client = { chat: { completions: { create: async () => { called = true; throw new Error("no"); } } } } as any;
    const out = await distillRun({ client, ...base, interactions: none, existing: [] });
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });

  it("parses candidate memories from the model's JSON reply", async () => {
    const client = makeFakeClient([
      [{ text: JSON.stringify({ memories: ["Always express spend deltas in percentages."] }) }],
    ]);
    const out = await distillRun({
      client, ...base,
      interactions: { steers: ["show deltas as percentages"], answers: [], flagResolutions: [] },
      existing: [],
    });
    expect(out).toEqual(["Always express spend deltas in percentages."]);
  });

  it("drops case-insensitive duplicates of existing memories and caps at 3", async () => {
    const client = makeFakeClient([
      [{ text: JSON.stringify({ memories: ["ALWAYS express spend deltas in percentages.", "A", "B", "C", "D"] }) }],
    ]);
    const out = await distillRun({
      client, ...base,
      interactions: { steers: ["x"], answers: [], flagResolutions: [] },
      existing: ["Always express spend deltas in percentages."],
    });
    expect(out).toEqual(["A", "B", "C"]);
  });

  it("returns [] on unparseable model output instead of throwing", async () => {
    const client = makeFakeClient([[{ text: "not json" }]]);
    const out = await distillRun({ client, ...base, interactions: { steers: ["x"], answers: [], flagResolutions: [] }, existing: [] });
    expect(out).toEqual([]);
  });
});
