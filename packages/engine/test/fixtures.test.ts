/// <reference path="../src/pdf-parse.d.ts" />
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Papa from "papaparse";
// Same internal entry point the engine's source-pack builder uses.
import pdfParse from "pdf-parse/lib/pdf-parse.js";

// The seed's real fixtures live at the repo root under scripts/fixtures.
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "../../../scripts/fixtures");

describe("seed fixtures", () => {
  it("extracts text from brand_guidelines.pdf via pdf-parse", async () => {
    const buf = await readFile(join(FIXTURES, "brand_guidelines.pdf"));
    const data = await pdfParse(buf);
    expect(data.text.length).toBeGreaterThan(0);
    // The brand-voice line the seed relies on must survive extraction.
    expect(data.text.toLowerCase()).toContain("no hedging");
  });

  it("parses spend_june.csv with the columns the KPI/budget asserts reference", async () => {
    const content = await readFile(join(FIXTURES, "spend_june.csv"), "utf8");
    const parsed = Papa.parse<Record<string, string | number>>(content, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
    });
    expect(parsed.meta.fields).toEqual(["date", "channel", "amount"]);
    expect(parsed.data.length).toBe(12);
    const amounts = parsed.data.map((r) => r.amount);
    expect(amounts.every((a) => typeof a === "number")).toBe(true);
    const total = amounts.reduce<number>((n, a) => n + (a as number), 0);
    expect(total).toBeLessThanOrEqual(250000);
    const max = Math.max(...(amounts as number[]));
    expect(max).toBeLessThanOrEqual(50000);
  });

  it("parses ga4_export.csv with the channel column the KPI count assert references", async () => {
    const content = await readFile(join(FIXTURES, "ga4_export.csv"), "utf8");
    const parsed = Papa.parse<Record<string, string | number>>(content, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
    });
    expect(parsed.meta.fields).toEqual(["channel", "sessions", "conversions"]);
    expect(parsed.data.length).toBe(10);
    const channels = parsed.data.map((r) => r.channel).filter((c) => c !== "" && c != null);
    expect(channels.length).toBe(10);
  });
});
