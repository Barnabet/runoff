import { describe, it, expect } from "vitest";
import { draftSection } from "../src/draft.js";
import { makeFakeClient } from "./fakeClient.js";
import type { BlueprintContent } from "@runoff/core";

const content: BlueprintContent = {
  title: "T", clientName: "C", eyebrow: "E", dateline: "D",
  sections: [{ key: "exec", number: 2, heading: "Executive summary", mode: "auto", instruction: "Summarize.", sourceIds: ["src_spend"], rules: [] }],
  globalRules: [], delivery: { recipient: "", autoDeliverOnClear: false },
};
const pack = { sources: [{ id: "src_spend", label: "spend.csv", kind: "table" as const, summary: "2 rows", tables: [{ name: "s", columns: ["amount"], rows: [{ amount: 1 }] }] }] };

describe("draftSection", () => {
  it("streams deltas and parses the final dialect text", async () => {
    const client = makeFakeClient([[{ text: "Spend was [[$1|src_spend|sum(src_spend.amount)]] overall." }]]);
    const deltas: string[] = [];
    const r = await draftSection({ client, content, section: content.sections[0], pack, completed: [], steers: [], answers: [], cb: { onDelta: (t) => deltas.push(t), onFlag: () => {}, onQuestion: () => {} } });
    expect(deltas.join("")).toContain("Spend was");
    expect(r.blocks[0].type).toBe("paragraph");
  });

  it("surfaces raise_flag and ask_user tool calls, then continues the turn", async () => {
    const client = makeFakeClient([
      [ { toolUse: { name: "ask_user", input: { question: "Cite them?", options: ["Cite", "Skip"], fallback: "skip", deadlineSection: "exec" } } } ],
      [ { text: "Final text." }, { toolUse: { name: "raise_flag", input: { question: "Tone ok?", options: ["Keep", "Soften"] } } } ],
      [ { text: "Final text." } ],
    ]);
    const flags: string[] = []; const questions: string[] = [];
    const r = await draftSection({ client, content, section: content.sections[0], pack, completed: [], steers: [], answers: [], cb: { onDelta: () => {}, onFlag: (f) => flags.push(f.question), onQuestion: (q) => questions.push(q.question) } });
    expect(questions).toEqual(["Cite them?"]);
    expect(flags).toEqual(["Tone ok?"]);
    expect(r.raw).toContain("Final text.");
  });
});
