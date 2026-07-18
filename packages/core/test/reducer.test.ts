import { describe, it, expect } from "vitest";
import { reduceRun } from "../src/reducer.js";
import type { RunEvent } from "../src/types/events.js";

const meta = [{ key: "kpi", number: 1 }, { key: "exec", number: 2 }];

describe("reduceRun", () => {
  it("projects a full run lifecycle", () => {
    const events: RunEvent[] = [
      { type: "run_started", sectionKeys: ["kpi", "exec"], blueprintRev: 15 },
      { type: "source_read", sourceId: "src_a", label: "spend_june.csv", summary: "42 rows" },
      { type: "section_started", sectionKey: "kpi" },
      { type: "text_delta", sectionKey: "kpi", text: "Total spend " },
      { type: "text_delta", sectionKey: "kpi", text: "was flat." },
      { type: "section_completed", sectionKey: "kpi", blocks: [{ type: "paragraph", spans: [{ text: "Total spend was flat." }] }], words: 4, ms: 1200, retries: 0 },
      { type: "section_started", sectionKey: "exec" },
    ];
    const p = reduceRun(events, meta);
    expect(p.status).toBe("running");
    expect(p.phase).toBe("DRAFTING §02");
    expect(p.sections.kpi.state).toBe("done");
    expect(p.sections.kpi.typedText).toBe("Total spend was flat.");
    expect(p.sections.exec.state).toBe("writing");
  });

  it("tracks pause, questions and completion", () => {
    const events: RunEvent[] = [
      { type: "run_started", sectionKeys: ["kpi"], blueprintRev: 1 },
      { type: "question_raised", questionId: "q1", sectionKey: "kpi", question: "Cite them?", options: ["Cite them", "Leave it out"], fallback: "leave unattributed", deadlineSection: "kpi" },
      { type: "paused" },
    ];
    const p = reduceRun(events, meta);
    expect(p.phase).toBe("PAUSED");
    expect(p.questions.q1.status).toBe("open");
    const done = reduceRun([...events, { type: "resumed" },
      { type: "question_fallback_applied", questionId: "q1" },
      { type: "run_completed", stats: { durationMs: 14200, words: 2140, sourcesUsed: 5, checksPassed: 10, checksFailed: 0, flagCount: 2, citationCount: 31, retries: 1 }, document: { title: "t", eyebrow: "e", dateline: "d", sections: [] } }], meta);
    expect(done.status).toBe("complete");
    expect(done.questions.q1.status).toBe("fallback");
    expect(done.stats?.words).toBe(2140);
  });
});
