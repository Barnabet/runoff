import { describe, expect, it, vi } from "vitest";
import { capExemplarText, isUnsupportedExemplarMime, unifyGoldenReport } from "../src/unifyGolden.js";

const DOC = {
  title: "AR Review", eyebrow: "Quarterly", dateline: "Q1 2026",
  sections: [{ key: "summary", heading: "Summary", blocks: [{ type: "paragraph", spans: [{ text: "Total $4.2M" }] }] }],
};
const clientReturning = (...bodies: (string | Error)[]) => {
  const create = vi.fn();
  for (const b of bodies)
    b instanceof Error ? create.mockRejectedValueOnce(b)
      : create.mockResolvedValueOnce({ choices: [{ message: { content: b } }] });
  return { client: { chat: { completions: { create } } } as never, create };
};

describe("capExemplarText", () => {
  it("passes short text through and head+tail samples long text", () => {
    expect(capExemplarText("short")).toBe("short");
    const long = "a".repeat(30000);
    const capped = capExemplarText(long);
    expect(capped.length).toBeLessThanOrEqual(24000 + 20);
    expect(capped).toContain("\n…\n");
  });
});

describe("isUnsupportedExemplarMime", () => {
  it("rejects tabular mimes, accepts documents", () => {
    expect(isUnsupportedExemplarMime("text/csv")).toBe(true);
    expect(isUnsupportedExemplarMime("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(true);
    expect(isUnsupportedExemplarMime("application/pdf")).toBe(false);
    expect(isUnsupportedExemplarMime("text/markdown")).toBe(false);
  });
});

describe("unifyGoldenReport", () => {
  it("returns validated document and period", async () => {
    const { client } = clientReturning(JSON.stringify({ document: DOC, period: "2026-Q1" }));
    const r = await unifyGoldenReport({ client, filename: "ar.md", text: "Total $4.2M" });
    expect(r?.document.sections[0].key).toBe("summary");
    expect(r?.period).toBe("2026-Q1");
  });
  it("nulls a non-canonical period but keeps the document", async () => {
    const { client } = clientReturning(JSON.stringify({ document: DOC, period: "Q1 of 26" }));
    const r = await unifyGoldenReport({ client, filename: "ar.md", text: "x" });
    expect(r?.period).toBeNull();
  });
  it("retries once on invalid structure, then null", async () => {
    const { client, create } = clientReturning("not json", "still not json");
    expect(await unifyGoldenReport({ client, filename: "ar.md", text: "x" })).toBeNull();
    expect(create).toHaveBeenCalledTimes(2);
  });
  it("degenerate document (zero sections) triggers exactly one extra attempt", async () => {
    const empty = { ...DOC, sections: [] };
    const { client, create } = clientReturning(JSON.stringify({ document: empty, period: null }), JSON.stringify({ document: DOC, period: null }));
    const r = await unifyGoldenReport({ client, filename: "ar.md", text: "x" });
    expect(r?.document.sections.length).toBe(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(String(create.mock.calls[1][0].messages.at(-1)?.content)).toContain("zero sections");
  });
  it("client throw yields null, never throws", async () => {
    const { client } = clientReturning(new Error("boom"), new Error("boom"));
    await expect(unifyGoldenReport({ client, filename: "a.md", text: "x" })).resolves.toBeNull();
  });
});
