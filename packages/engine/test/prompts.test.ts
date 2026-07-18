import { describe, it, expect } from "vitest";
import { sectionUserPrompt, systemPrompt } from "../src/prompts.js";
import type { SourcePack } from "../src/sourcePack.js";
import type { BlueprintContent, BlueprintSection } from "@runoff/core";

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

describe("citation-marker wording", () => {
  // A live run showed the model copying a "[[figure|…]]" template literally, rendering
  // the word "figure" to the reader — the templates must never use it as the placeholder.
  const content: BlueprintContent = {
    title: "Monthly Performance Report",
    clientName: "Meridian Retail",
    eyebrow: "Marketing Performance",
    dateline: "June 2026",
    sections: [],
    globalRules: [],
    delivery: { recipient: "ops@example.com", autoDeliverOnClear: false },
  };

  it("the dialect contract shows a numeral placeholder and a concrete example", () => {
    const prompt = systemPrompt(content);
    expect(prompt).toContain("[[numeral|sourceId|locator]]");
    expect(prompt).toContain("[[220,500|src_ab12|sum(src_ab12.amount)]]");
    expect(prompt).not.toContain("[[figure|");
  });

  it("advertises row-filtered locators and bans internal-mechanics questions", () => {
    // A live run asked the user for permission to use filtered locators — a
    // question about engine internals the reader should never see.
    const prompt = systemPrompt(content);
    expect(prompt).toContain("sum(src_ab12.amount where channel=search)");
    expect(prompt).toContain("never about the dialect, citation markers, or locator grammar");
  });

  it("the retry feedback tells the model to wrap the numeral itself", () => {
    const prompt = sectionUserPrompt({
      ...base,
      section: section([]),
      retryFeedback: "uncited figure: 4",
    });
    expect(prompt).toContain("A previous draft failed checks: uncited figure: 4");
    expect(prompt).toContain("the visible text must be the actual number");
    expect(prompt).not.toContain("[[figure|");
  });
});
