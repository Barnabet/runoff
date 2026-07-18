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

  it("parses scoped candidate memories from the model's JSON reply", async () => {
    const client = makeFakeClient([
      [{ text: JSON.stringify({ memories: [
        { body: "Always use GBP", scope: "project" },
        { body: "Shorter intro", scope: "blueprint" },
      ] }) }],
    ]);
    const out = await distillRun({
      client, ...base,
      interactions: { steers: ["show deltas as percentages"], answers: [], flagResolutions: [] },
      existing: [],
    });
    expect(out).toEqual([
      { body: "Always use GBP", scope: "project" },
      { body: "Shorter intro", scope: "blueprint" },
    ]);
  });

  it("drops entries with a missing or invalid scope", async () => {
    const client = makeFakeClient([
      [{ text: JSON.stringify({ memories: [
        { body: "No scope here" },
        { body: "Bad scope", scope: "global" },
        { body: "Keeper", scope: "blueprint" },
      ] }) }],
    ]);
    const out = await distillRun({
      client, ...base,
      interactions: { steers: ["x"], answers: [], flagResolutions: [] },
      existing: [],
    });
    expect(out).toEqual([{ body: "Keeper", scope: "blueprint" }]);
  });

  it("drops case-insensitive duplicates of existing memories (any scope) and caps at 3", async () => {
    const client = makeFakeClient([
      [{ text: JSON.stringify({ memories: [
        { body: "ALWAYS express spend deltas in percentages.", scope: "blueprint" },
        { body: "A", scope: "project" },
        { body: "B", scope: "blueprint" },
        { body: "C", scope: "project" },
        { body: "D", scope: "blueprint" },
      ] }) }],
    ]);
    const out = await distillRun({
      client, ...base,
      interactions: { steers: ["x"], answers: [], flagResolutions: [] },
      // Dedup is on lowercased body regardless of scope: the existing project row
      // still knocks out the blueprint-scoped duplicate.
      existing: [{ body: "Always express spend deltas in percentages.", scope: "project" }],
    });
    expect(out).toEqual([
      { body: "A", scope: "project" },
      { body: "B", scope: "blueprint" },
      { body: "C", scope: "project" },
    ]);
  });

  it("returns [] on unparseable model output instead of throwing", async () => {
    const client = makeFakeClient([[{ text: "not json" }]]);
    const out = await distillRun({ client, ...base, interactions: { steers: ["x"], answers: [], flagResolutions: [] }, existing: [] });
    expect(out).toEqual([]);
  });
});
