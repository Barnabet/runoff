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
    familyIds: [],
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

describe("continuity block", () => {
  it("pins the stability-contract wording when previousSectionText is given", () => {
    const prompt = sectionUserPrompt({
      ...base,
      section: section([]),
      previousSectionText: "June spend totaled 208,200 within the cap.",
    });
    expect(prompt).toContain(
      "Last run's version of this section (keep its structure and wording where the\nunderlying data is unchanged; update figures and note material changes):",
    );
    expect(prompt).toContain("June spend totaled 208,200 within the cap.");
  });

  it("emits no continuity block for a first run", () => {
    const prompt = sectionUserPrompt({ ...base, section: section([]) });
    expect(prompt).not.toContain("Last run's version");
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

  const PROJECT_HEADING =
    "Standing guidance for this project (applies to every document in this project — follow unless blueprint guidance or a section instruction contradicts it):";
  const BLUEPRINT_HEADING =
    "Standing guidance for this blueprint (learned from the builder and past runs — follow unless a section instruction contradicts it):";

  describe("standing-guidance blocks", () => {
    it("renders the project block before the blueprint block, each memory under its own heading", () => {
      const prompt = systemPrompt(content, [
        { id: "m1", body: "GBP only", scope: "project" },
        { id: "m2", body: "Lead with table", scope: "blueprint" },
      ]);
      expect(prompt).toContain(PROJECT_HEADING);
      expect(prompt).toContain(BLUEPRINT_HEADING);
      // Project block precedes the blueprint block.
      expect(prompt.indexOf(PROJECT_HEADING)).toBeLessThan(prompt.indexOf(BLUEPRINT_HEADING));
      // Each body sits under its own heading.
      const projSeg = prompt.slice(prompt.indexOf(PROJECT_HEADING), prompt.indexOf(BLUEPRINT_HEADING));
      const bpSeg = prompt.slice(prompt.indexOf(BLUEPRINT_HEADING));
      expect(projSeg).toContain("- GBP only");
      expect(projSeg).not.toContain("- Lead with table");
      expect(bpSeg).toContain("- Lead with table");
    });

    it("omits the blueprint heading for project-only memories and vice versa", () => {
      const projectOnly = systemPrompt(content, [{ id: "m1", body: "GBP only", scope: "project" }]);
      expect(projectOnly).toContain(PROJECT_HEADING);
      expect(projectOnly).not.toContain(BLUEPRINT_HEADING);

      const blueprintOnly = systemPrompt(content, [{ id: "m2", body: "Lead with table", scope: "blueprint" }]);
      expect(blueprintOnly).toContain(BLUEPRINT_HEADING);
      expect(blueprintOnly).not.toContain(PROJECT_HEADING);
    });

    it("is absent without memories", () => {
      expect(systemPrompt(content)).not.toContain("Standing guidance");
      expect(systemPrompt(content, [])).not.toContain("Standing guidance");
    });
  });
});
