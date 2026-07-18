import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { BlueprintContent, RunEvent } from "@runoff/core";
import { reduceRun } from "@runoff/core";
import { executeRun, type EngineIO } from "../src/run.js";
import type { EngineFile } from "../src/sourcePack.js";
import { makeFakeClient } from "./fakeClient.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Assert each `expected` type appears in `actual` strictly after the previous match (order + presence, not just membership). */
function expectOrderedSubsequence(actual: string[], expected: string[]): void {
  let cursor = 0;
  for (const want of expected) {
    const found = actual.indexOf(want, cursor);
    expect(found, `expected "${want}" at/after index ${cursor} in ${JSON.stringify(actual)}`).toBeGreaterThanOrEqual(0);
    cursor = found + 1;
  }
}

const content: BlueprintContent = {
  title: "Q2 Report",
  clientName: "Acme",
  eyebrow: "Quarterly",
  dateline: "July 2026",
  sections: [
    // 1: fixed — no model call
    { key: "intro", number: 1, heading: "Introduction", mode: "fixed", instruction: "", fixedText: "Welcome to the report.", sourceIds: [], rules: [] },
    // 2: auto — first draft has an uncited figure (citation check fails), retry cites it (passes)
    { key: "body", number: 2, heading: "Body", mode: "auto", instruction: "Write the body.", sourceIds: ["src_data"], rules: [] },
    // 3: auto — draft raises a question whose deadline is this very section (fallback applies)
    { key: "outlook", number: 3, heading: "Outlook", mode: "auto", instruction: "Write the outlook.", sourceIds: [], rules: [] },
  ],
  globalRules: [],
  delivery: { recipient: "", autoDeliverOnClear: false },
};

const files: EngineFile[] = [
  { id: "src_data", name: "spend.csv", mime: "text/csv", path: join(here, "fixtures/spend.csv") },
];

describe("executeRun", () => {
  it("drives a fixed / retry / question-fallback blueprint and agrees with the reducer", async () => {
    const client = makeFakeClient([
      // body — first draft: uncited figure -> citation check fails
      [{ text: "Spend was $500 this quarter." }],
      // body — retry: cited figure (quote locator, no cross-check) -> passes
      [{ text: "Spend was [[$500|src_data|table row 1]] this quarter." }],
      // outlook — draft turn 1: model asks, deadline is this section
      [{ toolUse: { name: "ask_user", input: { question: "Include a forecast?", options: ["Keep", "Drop"], fallback: "omit the forecast", deadlineSection: "outlook" } } }],
      // outlook — draft turn 2: plain continuation, no figures
      [{ text: "The outlook is stable." }],
    ]);

    const events: RunEvent[] = [];
    const io: EngineIO = {
      emit: (e) => events.push(e),
      pollInputs: () => [],
      sleep: async () => {},
    };

    const { document, stats } = await executeRun({ client, content, files, io, blueprintRev: 3 });

    const types = events.map((e) => e.type);
    // Ordered subsequence a correct implementation actually satisfies: the retry's
    // check_passed is pinned AFTER retry_started, and each check follows its section_started.
    expectOrderedSubsequence(types, [
      "run_started", "source_read",
      "section_started", "section_completed",                       // fixed section
      "section_started", "check_failed", "retry_started", "check_passed", "section_completed", // body: fail -> retry -> pass
      "question_raised", "question_fallback_applied",               // outlook: ask -> fallback
      "render_started", "run_completed",
    ]);

    // Sanity: the run brackets its events.
    expect(types[0]).toBe("run_started");
    expect(types.at(-1)).toBe("run_completed");

    // retries tally surfaced in the completion stats and returned stats.
    const done = events.find((e) => e.type === "run_completed");
    expect(done?.type === "run_completed" && done.stats.retries).toBe(1);
    expect(stats.retries).toBe(1);

    // Returned document assembled from content + drafted sections.
    expect(document.title).toBe("Q2 Report");
    expect(document.sections.map((s) => s.key)).toEqual(["intro", "body", "outlook"]);

    // Engine <-> reducer contract: replaying the emitted log yields a complete run.
    const proj = reduceRun(events, content.sections.map((s) => ({ key: s.key, number: s.number })));
    expect(proj.status).toBe("complete");
  });

  it("contains a section refusal: emits section_failed, skips it, and still completes", async () => {
    // body refuses on its first (and only) model call; outlook drafts normally.
    // intro is fixed (no model call), so the two scripted turns are body, outlook.
    const client = makeFakeClient([
      [{ stopReason: "refusal" }],           // body — refuses
      [{ text: "The outlook is stable." }],  // outlook — normal
    ]);

    const events: RunEvent[] = [];
    const io: EngineIO = {
      emit: (e) => events.push(e),
      pollInputs: () => [],
      sleep: async () => {},
    };

    const { document } = await executeRun({ client, content, files, io, blueprintRev: 3 });

    // The refusal was contained: a section_failed for body, and the run reached run_completed.
    const failed = events.find((e) => e.type === "section_failed");
    expect(failed?.type === "section_failed" && failed.sectionKey).toBe("body");
    expect(events.some((e) => e.type === "run_completed")).toBe(true);
    expect(events.some((e) => e.type === "run_failed")).toBe(false);

    // The document assembles without the refused section.
    expect(document.sections.map((s) => s.key)).toEqual(["intro", "outlook"]);

    // Reducer agrees: body failed, run complete.
    const proj = reduceRun(events, content.sections.map((s) => ({ key: s.key, number: s.number })));
    expect(proj.status).toBe("complete");
    expect(proj.sections.body.state).toBe("failed");
    expect(proj.sections.outlook.state).toBe("done");
  });
});
