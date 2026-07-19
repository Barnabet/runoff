// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import type { GoldenRow } from "@runoff/core";

// Mirror the SourceManager UI suite: mock the api module so we can assert the
// exact fns the card wires (bind/unify/patch), and drive the card directly.
vi.mock("@/lib/api", () => ({
  bindGoldenApi: vi.fn(() => Promise.resolve({ golden: {} })),
  unifyGoldenApi: vi.fn(() => Promise.resolve({ golden: {} })),
  patchGoldenPeriod: vi.fn(() => Promise.resolve({ golden: {} })),
  // Also referenced by the MemoryGoldenDrawer module (unused by GoldenCard here).
  getGoldens: vi.fn(),
  getMemories: vi.fn(),
  deleteGolden: vi.fn(() => Promise.resolve()),
  deleteMemory: vi.fn(),
  patchMemory: vi.fn(),
  uploadGolden: vi.fn(),
}));

import { GoldenCard } from "../components/builder/MemoryGoldenDrawer";
import { bindGoldenApi, unifyGoldenApi, patchGoldenPeriod } from "@/lib/api";

const ANCHOR = { sectionKey: "summary", blockIndex: 0, spanIndex: 0 };

/** 4 items: 2 bound, 1 mismatch, 1 unbound (null binding). */
const INV = JSON.stringify({
  version: 1,
  items: [
    { id: "cnt", kind: "value", anchor: ANCHOR, raw: "10", parsed: 10, reason: null,
      binding: { familyId: "fam_ar", sql: "SELECT COUNT(*) FROM fam_ar WHERE _period = :period", verifiedValue: 10, status: "bound" } },
    { id: "sum_amt", kind: "value", anchor: ANCHOR, raw: "$1.2M", parsed: 1200000, reason: null,
      binding: { familyId: "fam_ar", sql: "SELECT SUM(amount) FROM fam_ar", verifiedValue: 1200000, status: "bound" } },
    { id: "big", kind: "value", anchor: ANCHOR, raw: "$4.2M", parsed: 4200000, reason: "value mismatch",
      binding: { familyId: "fam_ar", sql: "SELECT SUM(x) FROM fam_ar", verifiedValue: 3981102, status: "mismatch" } },
    { id: "orphan", kind: "value", anchor: ANCHOR, raw: "12", parsed: 12, reason: "no matching family", binding: null },
  ],
});

function golden(over: Partial<GoldenRow> & { id: string }): GoldenRow {
  return {
    blueprintId: "bp_1", kind: "exemplar", runId: null, sectionKey: null,
    name: "AR exemplar", mime: null, storedFilename: null, note: null,
    period: null, document: null, unifyError: null, bindings: null, createdAt: "",
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("GoldenCard", () => {
  it("bound exemplar: unified badge, boundness count line, and an expandable inventory", () => {
    render(<GoldenCard g={golden({ id: "g1", document: "{}", bindings: INV })} blueprintId="bp_1" reload={vi.fn()} />);

    expect(screen.getByText("unified")).toBeTruthy();
    expect(screen.getByText("2/4 bound · 1 mismatch · 1 unbound")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "inventory" }));

    // Bound row: family + SQL in a mono row.
    const boundRow = screen.getByText(/fam_ar · SELECT COUNT/);
    expect(boundRow.closest("div")?.className).toContain("font-mono");

    // Mismatch row: both values, amber.
    const mismatch = screen.getByText(/says \$4\.2M · data 3,981,102/);
    expect(mismatch.className).toContain("amber");

    // Unbound row: its reason.
    expect(screen.getByText("no matching family")).toBeTruthy();
  });

  it("failed unify: amber badge + message + retry wired to unifyGoldenApi", () => {
    render(<GoldenCard g={golden({ id: "g2", document: null, unifyError: "unify failed: boom" })} blueprintId="bp_1" reload={vi.fn()} />);

    const badge = screen.getByText("unify failed");
    expect(badge.className).toContain("amber");
    expect(screen.getByText("unify failed: boom")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "retry unify" }));
    expect(unifyGoldenApi).toHaveBeenCalledWith("bp_1", "g2");
  });

  it("rebind with feedback (exemplar) vs verify bindings (run/section, no feedback input)", () => {
    // Exemplar: feedback + rebind.
    const { unmount } = render(<GoldenCard g={golden({ id: "g3", document: "{}", bindings: INV })} blueprintId="bp_1" reload={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "inventory" }));
    fireEvent.change(screen.getByPlaceholderText("what should bind differently?"), { target: { value: "wrong family" } });
    fireEvent.click(screen.getByRole("button", { name: "rebind" }));
    expect(bindGoldenApi).toHaveBeenCalledWith("bp_1", "g3", "wrong family");
    unmount();

    // Run/section: no feedback input; verify bindings calls bindGoldenApi with no feedback.
    render(<GoldenCard g={golden({ id: "g4", kind: "run", runId: "run_1", name: null, document: null, bindings: INV })} blueprintId="bp_1" reload={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "inventory" }));
    expect(screen.queryByPlaceholderText("what should bind differently?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "verify bindings" }));
    expect(bindGoldenApi).toHaveBeenLastCalledWith("bp_1", "g4");
  });

  it("period chip: click to edit, commit calls patchGoldenPeriod; an API error renders inline", async () => {
    const reload = vi.fn();
    render(<GoldenCard g={golden({ id: "g5", period: "2026-Q1" })} blueprintId="bp_1" reload={reload} />);

    fireEvent.click(screen.getByTestId("period-chip-g5"));
    const input = screen.getByTestId("period-input-g5") as HTMLInputElement;
    expect(input.value).toBe("2026-Q1");
    fireEvent.change(input, { target: { value: "2026-Q2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(patchGoldenPeriod).toHaveBeenCalledWith("g5", "2026-Q2"));

    cleanup();
    vi.mocked(patchGoldenPeriod).mockRejectedValueOnce(new Error("bad period: garbage"));
    render(<GoldenCard g={golden({ id: "g6", period: "2026-Q1" })} blueprintId="bp_1" reload={vi.fn()} />);
    fireEvent.click(screen.getByTestId("period-chip-g6"));
    const input2 = screen.getByTestId("period-input-g6");
    fireEvent.change(input2, { target: { value: "garbage" } });
    fireEvent.keyDown(input2, { key: "Enter" });
    expect(await screen.findByText(/bad period: garbage/)).toBeTruthy();
  });

  it("malformed bindings degrade to inert: card + delete still render, 'bindings unreadable' shown", () => {
    render(<GoldenCard g={golden({ id: "g7", document: "{}", bindings: "{not json" })} blueprintId="bp_1" reload={vi.fn()} />);
    // The card renders instead of throwing during React render.
    expect(screen.getByTestId("golden-g7")).toBeTruthy();
    // The delete escape hatch is present.
    expect(screen.getByRole("button", { name: "delete" })).toBeTruthy();
    // The boundness line degrades to a readable notice; no inventory panel.
    expect(screen.getByText("bindings unreadable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "inventory" })).toBeNull();
  });
});
