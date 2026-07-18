import { describe, it, expect } from "vitest";
import type { BlueprintContent } from "@runoff/core";
import { copilotTurn, type CopilotContext, type CopilotEvent } from "../src/copilot.js";
import { makeFakeClient } from "./fakeClient.js";

const content: BlueprintContent = {
  title: "Monthly Performance Report",
  clientName: "Meridian Retail",
  eyebrow: "Marketing Performance",
  dateline: "June 2026",
  sections: [
    { key: "exec", number: 1, heading: "Executive summary", mode: "auto", instruction: "Summarize.", sourceIds: [], rules: [] },
    { key: "budget", number: 2, heading: "Budget", mode: "auto", instruction: "Cover spend.", sourceIds: ["src_data"], rules: [] },
  ],
  globalRules: [],
  delivery: { recipient: "ops@example.com", autoDeliverOnClear: false },
};

function ctx(overrides: Partial<CopilotContext> = {}): CopilotContext {
  return {
    files: [],
    listRuns: () => [],
    getRunSection: () => null,
    listGoldens: () => [],
    getGolden: () => null,
    saveMemory: () => "mem_1",
    ...overrides,
  };
}

function collect() {
  const events: CopilotEvent[] = [];
  return { events, io: { emit: (e: CopilotEvent) => events.push(e) } };
}

describe("copilotTurn", () => {
  it("applies a valid edit_section patch: emits the op, updates the draft, returns actions", async () => {
    const client = makeFakeClient([
      [
        { toolUse: { name: "edit_section", input: { key: "exec", patch: { instruction: "Summarize the quarter in three sentences." } } } },
      ],
      [{ text: "Tightened the exec summary instruction." }],
    ]);
    const { events, io } = collect();
    const res = await copilotTurn({
      client, draft: content, selectedKey: "exec", message: "tighten the exec instruction",
      thread: [], memories: [], ctx: ctx(), io,
    });

    const edit = events.find((e) => e.type === "edit");
    expect(edit && edit.type === "edit" && edit.op.type === "edit_section" && edit.op.key === "exec").toBe(true);
    if (edit?.type === "edit" && edit.op.type === "edit_section") {
      expect(edit.op.before.instruction).toBe("Summarize.");
      expect(edit.op.after.instruction).toBe("Summarize the quarter in three sentences.");
    }
    expect(res.draft.sections[0].instruction).toBe("Summarize the quarter in three sentences.");
    expect(res.reply).toBe("Tightened the exec summary instruction.");
    expect(res.actions.some((a) => a.kind === "edit")).toBe(true);
    // Every executed tool announces itself first.
    expect(events.some((e) => e.type === "tool_activity")).toBe(true);
  });

  it("rejects an invalid patch as a tool error: no op, draft unchanged, loop continues", async () => {
    const client = makeFakeClient([
      [{ toolUse: { name: "edit_section", input: { key: "exec", patch: { mode: "bogus" } } } }],
      [{ text: "That mode is not valid." }],
    ]);
    const { events, io } = collect();
    const res = await copilotTurn({
      client, draft: content, selectedKey: null, message: "break it",
      thread: [], memories: [], ctx: ctx(), io,
    });
    expect(events.some((e) => e.type === "edit")).toBe(false);
    expect(res.draft.sections[0].instruction).toBe("Summarize.");
    expect(res.reply).toBe("That mode is not valid.");
  });

  it("add_section inserts after the anchor and renumbers; remove_section carries afterKey", async () => {
    const client = makeFakeClient([
      [
        {
          toolUse: {
            name: "add_section",
            input: {
              afterKey: "exec",
              section: { key: "kpis", heading: "KPI summary", mode: "auto", instruction: "Key metrics.", sourceIds: [], rules: [] },
            },
          },
        },
      ],
      [{ toolUse: { name: "remove_section", input: { key: "budget" } } }],
      [{ text: "Done." }],
    ]);
    const { events, io } = collect();
    const res = await copilotTurn({
      client, draft: content, selectedKey: null, message: "restructure",
      thread: [], memories: [], ctx: ctx(), io,
    });
    expect(res.draft.sections.map((s) => s.key)).toEqual(["exec", "kpis"]);
    expect(res.draft.sections.map((s) => s.number)).toEqual([1, 2]);
    const removeOp = events.find((e) => e.type === "edit" && e.op.type === "remove_section");
    if (removeOp?.type === "edit" && removeOp.op.type === "remove_section") {
      expect(removeOp.op.afterKey).toBe("kpis"); // budget's predecessor at removal time
      expect(removeOp.op.removed.key).toBe("budget");
    } else {
      expect.unreachable("remove_section op not emitted");
    }
  });

  it("save_memory calls ctx and emits memory_saved", async () => {
    let saved = "";
    const client = makeFakeClient([
      [{ toolUse: { name: "save_memory", input: { body: "Always express deltas as percentages." } } }],
      [{ text: "Noted." }],
    ]);
    const { events, io } = collect();
    await copilotTurn({
      client, draft: content, selectedKey: null, message: "remember that",
      thread: [], memories: [],
      ctx: ctx({ saveMemory: (b) => { saved = b; return "mem_42"; } }), io,
    });
    expect(saved).toBe("Always express deltas as percentages.");
    expect(events.find((e) => e.type === "memory_saved")).toEqual({
      type: "memory_saved", memoryId: "mem_42", body: "Always express deltas as percentages.",
    });
  });

  it("streams text deltas and caps the tool loop at 12 iterations with a wrap-up", async () => {
    // 13 scripted tool turns; fake client repeats its last script entry, so
    // iteration 13 would also tool-call — the cap must inject the wrap-up nudge
    // and accept the next text turn instead.
    const toolTurn = [{ toolUse: { name: "query_sources", input: {} } }] as any;
    const script = Array.from({ length: 13 }, () => toolTurn);
    script.push([{ text: "Here is what I found." }]);
    const client = makeFakeClient(script);
    const { events, io } = collect();
    const res = await copilotTurn({
      client, draft: content, selectedKey: null, message: "dig around",
      thread: [], memories: [], ctx: ctx(), io,
    });
    expect(res.reply).toBe("Here is what I found.");
    expect(events.filter((e) => e.type === "text_delta").length).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === "tool_activity").length).toBeLessThanOrEqual(12);
  });
});
