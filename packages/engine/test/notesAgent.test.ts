import { describe, it, expect } from "vitest";
import { marginReply, applyEdit } from "../src/notesAgent.js";
import type { ProposedEdit } from "../src/notesAgent.js";
import type { BlueprintContent, BlueprintSection } from "@runoff/core";

const section: BlueprintSection = {
  key: "exec",
  number: 2,
  heading: "Executive summary",
  mode: "auto",
  instruction: "Summarize at a fast pace, keeping a fast pace throughout.",
  fixedText: "The fixed intro sets the pace.",
  sourceIds: [],
  rules: [],
};
const content: BlueprintContent = {
  title: "T",
  clientName: "C",
  eyebrow: "E",
  dateline: "D",
  sections: [section],
  globalRules: [],
  delivery: { recipient: "", autoDeliverOnClear: false },
};

describe("applyEdit", () => {
  it("replaces only the first occurrence in the target field and returns a new section", () => {
    const edit: ProposedEdit = { field: "instruction", edits: [{ find: "fast pace", replace: "measured pacing" }] };
    const out = applyEdit(section, edit);
    // first occurrence replaced, second left intact
    expect(out.instruction).toBe("Summarize at a measured pacing, keeping a fast pace throughout.");
  });

  it("edits fixedText and applies multiple find/replace pairs in order", () => {
    const edit: ProposedEdit = {
      field: "fixedText",
      edits: [
        { find: "fixed intro", replace: "opening" },
        { find: "pace", replace: "cadence" },
      ],
    };
    const out = applyEdit(section, edit);
    expect(out.fixedText).toBe("The opening sets the cadence.");
  });

  it("does not mutate the input section", () => {
    const edit: ProposedEdit = { field: "instruction", edits: [{ find: "fast pace", replace: "measured pacing" }] };
    const out = applyEdit(section, edit);
    expect(section.instruction).toBe("Summarize at a fast pace, keeping a fast pace throughout.");
    expect(out).not.toBe(section);
  });

  it("throws a clear error naming the missing find text", () => {
    const edit: ProposedEdit = { field: "instruction", edits: [{ find: "nonexistent phrase", replace: "x" }] };
    expect(() => applyEdit(section, edit)).toThrow(/nonexistent phrase/);
  });

  it("throws when the target field is absent (undefined fixedText)", () => {
    const noFixed: BlueprintSection = { ...section, fixedText: undefined };
    const edit: ProposedEdit = { field: "fixedText", edits: [{ find: "pace", replace: "cadence" }] };
    expect(() => applyEdit(noFixed, edit)).toThrow(/pace/);
  });
});

describe("marginReply", () => {
  it("parses the structured JSON reply and proposedEdit from the client", async () => {
    const client = {
      messages: {
        create: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                reply: "Done",
                proposedEdit: { field: "instruction", edits: [{ find: "pace", replace: "pacing" }] },
              }),
            },
          ],
          stop_reason: "end_turn",
        }),
      },
    } as any;
    const r = await marginReply({
      client,
      content,
      sectionKey: "exec",
      thread: [{ author: "user", body: "make the pace better" }],
    });
    expect(r.reply).toBe("Done");
    expect(r.proposedEdit).toEqual({ field: "instruction", edits: [{ find: "pace", replace: "pacing" }] });
  });

  it("omits proposedEdit when the model returns null", async () => {
    const client = {
      messages: {
        create: async () => ({
          content: [{ type: "text", text: JSON.stringify({ reply: "Just a note.", proposedEdit: null }) }],
          stop_reason: "end_turn",
        }),
      },
    } as any;
    const r = await marginReply({ client, content, sectionKey: "exec", thread: [] });
    expect(r.reply).toBe("Just a note.");
    expect(r.proposedEdit).toBeUndefined();
  });

  it("throws when the sectionKey matches no section", async () => {
    const client = {
      messages: { create: async () => ({ content: [{ type: "text", text: "{}" }], stop_reason: "end_turn" }) },
    } as any;
    await expect(marginReply({ client, content, sectionKey: "missing", thread: [] })).rejects.toThrow(/Unknown section "missing"/);
  });

  it("returns a graceful fallback on refusal", async () => {
    const client = { messages: { create: async () => ({ content: [], stop_reason: "refusal" }) } } as any;
    const r = await marginReply({ client, content, sectionKey: "exec", thread: [] });
    expect(r.reply).toMatch(/couldn't process/);
    expect(r.proposedEdit).toBeUndefined();
  });

  it("returns a graceful fallback on JSON parse failure", async () => {
    const client = {
      messages: { create: async () => ({ content: [{ type: "text", text: "not json at all" }], stop_reason: "end_turn" }) },
    } as any;
    const r = await marginReply({ client, content, sectionKey: "exec", thread: [] });
    expect(r.reply).toMatch(/couldn't process/);
  });
});
