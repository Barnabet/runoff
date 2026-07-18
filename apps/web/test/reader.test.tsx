// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import type { RunDocument, RunProjection, RunStats } from "@runoff/core";

const { showToast, resolveFlag, getBlueprint, saveRevision } = vi.hoisted(() => ({
  showToast: vi.fn(),
  resolveFlag: vi.fn(async () => ({ remainingOpen: 0 })),
  getBlueprint: vi.fn(),
  saveRevision: vi.fn(async () => ({ rev: 2 })),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/Toast", () => ({ showToast, Toast: () => null }));
vi.mock("@/lib/api", () => ({ resolveFlag, getBlueprint, saveRevision }));

import { ReaderView } from "../components/reader/ReaderView";
import type { FlagRow, GetRunResponse } from "../lib/api";

const stats: RunStats = {
  durationMs: 29400,
  words: 2140,
  sourcesUsed: 5,
  checksPassed: 10,
  checksFailed: 0,
  flagCount: 2,
  citationCount: 31,
  retries: 1,
};

const document: RunDocument = {
  title: "Monthly Performance Report",
  eyebrow: "PREPARED FOR MERIDIAN",
  dateline: "July 2026",
  sections: [
    {
      key: "s1",
      heading: "Executive summary",
      blocks: [{ type: "paragraph", spans: [{ text: "Revenue softened this month." }] }],
    },
    {
      key: "s2",
      heading: "Channels",
      blocks: [{ type: "paragraph", spans: [{ text: "Paid search led acquisition." }] }],
    },
  ],
};

function flag(over: Partial<FlagRow>): FlagRow {
  return {
    id: "flag_1",
    runId: "run_abcd1234",
    code: "F1",
    sectionKey: "s1",
    question: "Soften this claim?",
    options: ["Keep", "Soften"],
    status: "open",
    resolution: null,
    createdAt: "2026-07-18 09:00:00",
    ...over,
  };
}

const projection: RunProjection = {
  status: "complete",
  phase: "COMPLETE",
  sections: {},
  log: [],
  questions: {},
  flags: [],
};

function payload(flags: FlagRow[]): GetRunResponse {
  return {
    run: {
      id: "run_abcd1234ef56",
      blueprintId: "bp_1",
      blueprintRev: 15,
      triggerKind: "manual",
      status: "complete",
      startedAt: "2026-07-18 09:00:00",
      finishedAt: "2026-07-01 09:14:00",
      // Complete-on-load: the final document + stats arrive as JSON columns.
      stats: JSON.stringify(stats),
      document: JSON.stringify(document),
      createdAt: "2026-07-01 09:00:00",
    },
    events: [],
    flags,
    sectionMeta: [
      { key: "s1", number: 1, heading: "Executive summary" },
      { key: "s2", number: 2, heading: "Channels" },
    ],
    sourceLabels: { src_a: "GA4" },
    blueprint: { id: "bp_1", name: "Monthly Performance Report", clientName: "Meridian" },
    content: {
      title: "Monthly Performance Report",
      eyebrow: "PREPARED FOR MERIDIAN",
      dateline: "July 2026",
      delivery: { recipient: "reports@meridianretail.com", autoDeliverOnClear: false },
    },
  };
}

beforeEach(() => {
  getBlueprint.mockResolvedValue({
    blueprint: { id: "bp_1" },
    content: {
      title: "Monthly Performance Report",
      clientName: "Meridian",
      eyebrow: "PREPARED FOR MERIDIAN",
      dateline: "July 2026",
      sections: [],
      globalRules: [],
      delivery: { recipient: "reports@meridianretail.com", autoDeliverOnClear: false },
    },
    sources: [],
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Reader — run report ledger", () => {
  it("renders the mono ledger from the run stats", () => {
    const { getByTestId } = render(<ReaderView payload={payload([flag({})])} projection={projection} />);
    const report = getByTestId("run-report");
    expect(report.textContent).toContain("29.4s · 1 retry");
    expect(report.textContent).toContain("2,140 words");
    expect(report.textContent).toContain("5 used");
    expect(report.textContent).toContain("10 pass · 2 flags");
    expect(report.textContent).toContain("31 figures");
    // No "resolved" tail while a flag is still open.
    expect(report.textContent).not.toContain("resolved ✓");
  });

  it("appends the resolved tail once every flag is cleared", () => {
    const flags = [flag({ id: "flag_1", code: "F1" }), flag({ id: "flag_2", code: "F2", sectionKey: "s2" })];
    const { getByTestId, getByText } = render(<ReaderView payload={payload(flags)} projection={projection} />);
    fireEvent.click(within(getByTestId("flag-card-flag_1")).getByText("Keep"));
    fireEvent.click(within(getByTestId("flag-card-flag_2")).getByText("Keep"));
    expect(getByTestId("run-report").textContent).toContain("2 resolved ✓");
  });
});

describe("Reader — status banner", () => {
  it("shows the amber flags banner while a flag is open", () => {
    const { getByTestId } = render(<ReaderView payload={payload([flag({})])} projection={projection} />);
    const banner = getByTestId("status-banner");
    expect(banner.getAttribute("data-state")).toBe("open");
    expect(banner.textContent).toContain("1 Flag");
    expect(banner.textContent).toContain("awaits your judgment");
  });

  it("flips to the ink cleared banner when the last flag resolves", () => {
    const { getByTestId } = render(<ReaderView payload={payload([flag({})])} projection={projection} />);
    expect(getByTestId("status-banner").getAttribute("data-state")).toBe("open");

    fireEvent.click(within(getByTestId("flag-card-flag_1")).getByText("Keep"));

    const banner = getByTestId("status-banner");
    expect(banner.getAttribute("data-state")).toBe("cleared");
    // Auto-deliver is off, so copy points to export — never "delivered".
    expect(banner.textContent).toContain("Auto-delivery is off");
    expect(banner.textContent).not.toContain("Delivered");
    expect(resolveFlag).toHaveBeenCalledWith("flag_1", { option: "Keep" });
  });
});

describe("Reader — flag cards", () => {
  it("collapses a resolved flag to a wash result line", () => {
    const { getByTestId } = render(<ReaderView payload={payload([flag({})])} projection={projection} />);
    fireEvent.click(within(getByTestId("flag-card-flag_1")).getByText("Soften"));
    const card = getByTestId("flag-card-flag_1");
    expect(card.getAttribute("data-state")).toBe("resolved");
    expect(card.className).toContain("bg-wash");
    expect(card.textContent).toContain("F1 — Soften ✓");
  });

  it("reverts the optimistic resolve when the request fails", async () => {
    resolveFlag.mockRejectedValueOnce(new Error("offline"));
    const { getByTestId } = render(<ReaderView payload={payload([flag({})])} projection={projection} />);
    fireEvent.click(within(getByTestId("flag-card-flag_1")).getByText("Keep"));
    await waitFor(() =>
      expect(getByTestId("flag-card-flag_1").getAttribute("data-state")).toBe("open"),
    );
    expect(showToast).toHaveBeenCalled();
  });
});

describe("Reader — flag highlights", () => {
  it("marks the flagged section's first paragraph and drops the mark on resolve", () => {
    const { container, getByTestId } = render(
      <ReaderView payload={payload([flag({})])} projection={projection} />,
    );
    // One open flag on s1 → one amber mark with an "F1" superscript marker.
    expect(container.querySelectorAll("mark").length).toBe(1);
    const sups = Array.from(container.querySelectorAll("sup")).map((el) => el.textContent);
    expect(sups).toEqual(["F1"]);

    fireEvent.click(within(getByTestId("flag-card-flag_1")).getByText("Keep"));

    expect(container.querySelector("mark")).toBeNull();
    expect(container.querySelector("sup")).toBeNull();
  });
});

describe("Reader — delivery toggle", () => {
  it("persists a toggle via getBlueprint + saveRevision on the current content", async () => {
    const { getByTestId } = render(<ReaderView payload={payload([flag({})])} projection={projection} />);
    const toggle = within(getByTestId("delivery-card")).getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true"); // optimistic

    await waitFor(() => expect(saveRevision).toHaveBeenCalled());
    expect(getBlueprint).toHaveBeenCalledWith("bp_1");
    expect(saveRevision).toHaveBeenCalledWith(
      "bp_1",
      expect.objectContaining({ delivery: expect.objectContaining({ autoDeliverOnClear: true }) }),
    );
  });

  it("reverts and toasts when persistence fails", async () => {
    getBlueprint.mockRejectedValueOnce(new Error("offline"));
    const { getByTestId } = render(<ReaderView payload={payload([flag({})])} projection={projection} />);
    const toggle = within(getByTestId("delivery-card")).getByRole("switch");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true"); // optimistic

    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(showToast).toHaveBeenCalled();
  });
});
