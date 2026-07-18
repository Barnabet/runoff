import { describe, it, expect } from "vitest";
import { sectionUserPrompt } from "../src/prompts.js";
import type { SourcePack } from "../src/sourcePack.js";
import type { BlueprintSection } from "@runoff/core";

const emptyPack: SourcePack = { sources: [] };

const base = {
  pack: emptyPack,
  completed: [],
  steers: [] as string[],
  answers: [] as { question: string; answer: string }[],
};

function section(rules: BlueprintSection["rules"]): BlueprintSection {
  return {
    key: "exec",
    number: 2,
    heading: "Executive summary",
    mode: "auto",
    instruction: "Summarize the quarter.",
    sourceIds: [],
    rules,
  };
}

describe("sectionUserPrompt — rules block", () => {
  it("lists each rule's kind and text so the rules reach the model", () => {
    const prompt = sectionUserPrompt({
      ...base,
      section: section([
        { kind: "style", text: "Keep the tone measured." },
        { kind: "judgment", text: "Flag any layoffs mention for review." },
        { kind: "assert", text: "Spend must be positive.", expression: "sum(src.amount) > 0" },
      ]),
    });

    expect(prompt).toContain("Rules for this section:");
    expect(prompt).toContain("- [style] Keep the tone measured.");
    expect(prompt).toContain("- [judgment] Flag any layoffs mention for review.");
    // An assert with an expression surfaces the expression inline.
    expect(prompt).toContain("- [assert] Spend must be positive. (expression: sum(src.amount) > 0)");
    // The block explains how each kind is enforced.
    expect(prompt).toContain("assert rules are verified deterministically after drafting");
    expect(prompt).toContain("judgment rules should prompt raise_flag when triggered");
  });

  it("omits the expression suffix for an assert rule that has none", () => {
    const prompt = sectionUserPrompt({
      ...base,
      section: section([{ kind: "assert", text: "Mention the headline figure." }]),
    });
    expect(prompt).toContain("- [assert] Mention the headline figure.");
    expect(prompt).not.toContain("(expression:");
  });

  it("emits no rules block when the section has no rules", () => {
    const prompt = sectionUserPrompt({ ...base, section: section([]) });
    expect(prompt).not.toContain("Rules for this section:");
  });
});
