import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import { classifySource } from "../src/classify.js";

/** Chat-completions stub returning a fixed JSON body (or throwing). */
function client(content: string | Error): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => {
          if (content instanceof Error) throw content;
          return { choices: [{ message: { content } }] };
        },
      },
    },
  } as unknown as OpenAI;
}

const FAMILIES = [
  { key: "trade_data", label: "Trade data", kind: "periodic" as const, granularity: "quarter" as const },
  { key: "brand_guidelines", label: "Brand guidelines", kind: "constant" as const, granularity: null },
];

const base = { filename: "trade_q2.csv", contentSample: "date,volume\n2026-04-01,10", families: FAMILIES };

describe("classifySource", () => {
  it("accepts a valid existing-family proposal", async () => {
    const p = await classifySource({ client: client(JSON.stringify({ familyKey: "trade_data", period: "2026-Q2", confidence: "high" })), ...base });
    expect(p).toEqual({ familyKey: "trade_data", period: "2026-Q2", confidence: "high" });
  });

  it("accepts a valid new-family proposal", async () => {
    const p = await classifySource({
      client: client(JSON.stringify({ familyKey: "spend_data", newFamily: { key: "spend_data", label: "Spend data", kind: "periodic", granularity: "month" }, period: "2026-06", confidence: "medium" })),
      ...base,
    });
    expect(p?.newFamily?.granularity).toBe("month");
  });

  it("nulls on: period not matching the existing family's granularity", async () => {
    expect(await classifySource({ client: client(JSON.stringify({ familyKey: "trade_data", period: "2026-06", confidence: "high" })), ...base })).toBeNull();
  });

  it("nulls on: newFamily present for an existing key / absent for an unknown key", async () => {
    expect(await classifySource({ client: client(JSON.stringify({ familyKey: "trade_data", newFamily: { key: "trade_data", label: "x", kind: "periodic", granularity: "quarter" }, period: "2026-Q2", confidence: "high" })), ...base })).toBeNull();
    expect(await classifySource({ client: client(JSON.stringify({ familyKey: "mystery", period: "2026-Q2", confidence: "high" })), ...base })).toBeNull();
  });

  it("nulls on: constant family with a period, periodic without one", async () => {
    expect(await classifySource({ client: client(JSON.stringify({ familyKey: "brand_guidelines", period: "2026-Q2", confidence: "high" })), ...base })).toBeNull();
    expect(await classifySource({ client: client(JSON.stringify({ familyKey: "trade_data", period: null, confidence: "high" })), ...base })).toBeNull();
  });

  it("nulls on: constant newFamily carrying a granularity, or periodic newFamily missing one", async () => {
    expect(await classifySource({ client: client(JSON.stringify({ familyKey: "ref", newFamily: { key: "ref", label: "Ref", kind: "constant", granularity: "quarter" }, period: null, confidence: "low" })), ...base })).toBeNull();
    expect(await classifySource({ client: client(JSON.stringify({ familyKey: "np", newFamily: { key: "np", label: "NP", kind: "periodic", granularity: null }, period: "2026-Q1", confidence: "low" })), ...base })).toBeNull();
  });

  it("nulls on API error and on non-JSON output", async () => {
    expect(await classifySource({ client: client(new Error("proxy down")), ...base })).toBeNull();
    expect(await classifySource({ client: client("not json"), ...base })).toBeNull();
  });
});
