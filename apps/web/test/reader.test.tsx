// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { RunDocument, RunEvent, RunProjection, RunStats } from "@runoff/core";

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
// Spread the real module so the goldens/star helpers hit the (stubbed) fetch;
// only the three flag/delivery helpers are mocked.
vi.mock("@/lib/api", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/api")>()),
  resolveFlag,
  getBlueprint,
  saveRevision,
}));

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
      blocks: [{ type: "paragraph", spans: [
        { text: "Revenue closed at " },
        { text: "220,500", citation: { sourceId: "src_a", locator: "sum(src_a.amount)" } },
        { text: " this month." },
      ] }],
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
  memoryIds: [],
};

// A complete-on-load run's document + stats arrive as JSON columns, so `baseEvents`
// can be empty; overrides let a test seed `run_started` (for `memoryIds`) or `memories`.
const baseEvents: RunEvent[] = [];

function payload(flags: FlagRow[], over: Partial<GetRunResponse> = {}): GetRunResponse {
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
    previous: null,
    memories: [],
    ...over,
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
  vi.unstubAllGlobals();
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
    // One open flag on s1 → its first paragraph's spans wrapped in amber marks
    // (one per span), with the "F1" superscript marker on the last span only.
    expect(container.querySelectorAll("mark").length).toBe(3);
    const sups = Array.from(container.querySelectorAll("sup")).map((el) => el.textContent);
    expect(sups).toEqual(["F1"]);

    fireEvent.click(within(getByTestId("flag-card-flag_1")).getByText("Keep"));

    expect(container.querySelector("mark")).toBeNull();
    expect(container.querySelector("sup")).toBeNull();
  });
});

describe("Reader — print wiring", () => {
  it("marks the chrome no-print and the document root print-doc-root", () => {
    const { container, getByTestId } = render(
      <ReaderView payload={payload([flag({})])} projection={projection} />,
    );
    // The reader `main` is the print root: under `@media print` its grid collapses
    // to a plain full-width block (display:block, max-width:none, padding:0) so the
    // document sheet is not squeezed into the now-empty 322px rail track.
    const main = container.querySelector("main") as HTMLElement;
    expect(main.className).toContain("print-doc-root");
    // The right rail and status banner are chrome that drops out in print.
    expect(getByTestId("status-banner").className).toContain("no-print");
    const rail = getByTestId("run-report").closest("aside") as HTMLElement;
    expect(rail.className).toContain("no-print");
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

describe("Reader — since last run", () => {
  const previous: GetRunResponse["previous"] = {
    runId: "run_prev",
    completedAt: "2026-06-01 09:10:00",
    document: {
      title: "Monthly Performance Report",
      eyebrow: "PREPARED FOR MERIDIAN",
      dateline: "June 2026",
      sections: [
        {
          key: "s1",
          heading: "Executive summary",
          blocks: [{ type: "paragraph", spans: [
            { text: "Revenue closed at " },
            { text: "208,200", citation: { sourceId: "src_a", locator: "sum(src_a.amount)" } },
            { text: " this month." },
          ] }],
        },
        { key: "s2", heading: "Channels", blocks: [{ type: "paragraph", spans: [{ text: "Paid search led acquisition." }] }] },
      ],
    },
  };

  it("renders an inline delta badge next to a changed cited figure", () => {
    const { container } = render(<ReaderView payload={payload([], { previous })} projection={projection} />);
    const text = container.textContent ?? "";
    expect(text).toContain("▲ 12,300");
  });

  it("renders the DeltaCard with rows, summary, and no-print", () => {
    const { getByTestId } = render(<ReaderView payload={payload([], { previous })} projection={projection} />);
    const card = getByTestId("delta-card");
    expect(card.className).toContain("no-print");
    expect(card.textContent).toContain("Since last run");
    expect(card.textContent).toContain("Jun 1, 2026");
    expect(card.textContent).toContain("208,200 → 220,500");
    expect(card.textContent).toContain("1 changed · 1 unchanged");
  });

  it("badges only the changed figure — an unchanged cited figure stays bare", () => {
    // s1's revenue moved (badge), s2's sessions held steady (no badge) in the same render.
    const current: RunDocument = {
      title: "Monthly Performance Report",
      eyebrow: "PREPARED FOR MERIDIAN",
      dateline: "July 2026",
      sections: [
        {
          key: "s1",
          heading: "Executive summary",
          blocks: [{ type: "paragraph", spans: [
            { text: "Revenue closed at " },
            { text: "220,500", citation: { sourceId: "src_a", locator: "sum(src_a.amount)" } },
            { text: " this month." },
          ] }],
        },
        {
          key: "s2",
          heading: "Channels",
          blocks: [{ type: "paragraph", spans: [
            { text: "Sessions held steady at " },
            { text: "48,000", citation: { sourceId: "src_a", locator: "sum(src_a.sessions)" } },
            { text: " across channels." },
          ] }],
        },
      ],
    };
    const prev: GetRunResponse["previous"] = {
      runId: "run_prev",
      completedAt: "2026-06-01 09:10:00",
      document: {
        title: "Monthly Performance Report",
        eyebrow: "PREPARED FOR MERIDIAN",
        dateline: "June 2026",
        sections: [
          {
            key: "s1",
            heading: "Executive summary",
            blocks: [{ type: "paragraph", spans: [
              { text: "Revenue closed at " },
              { text: "208,200", citation: { sourceId: "src_a", locator: "sum(src_a.amount)" } },
              { text: " this month." },
            ] }],
          },
          {
            key: "s2",
            heading: "Channels",
            blocks: [{ type: "paragraph", spans: [
              { text: "Sessions held steady at " },
              { text: "48,000", citation: { sourceId: "src_a", locator: "sum(src_a.sessions)" } },
              { text: " across channels." },
            ] }],
          },
        ],
      },
    };
    const p = payload([], { previous: prev });
    p.run.document = JSON.stringify(current);
    const { container, getByText } = render(<ReaderView payload={p} projection={projection} />);

    // Exactly one delta badge in the whole document — the changed figure's ▲ — and
    // the badge element is screen-only chrome (no-print).
    const badges = Array.from(container.querySelectorAll("span")).filter((el) =>
      /^\s*[▲▼]/.test(el.textContent ?? ""),
    );
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toContain("▲ 12,300");
    expect(badges[0].className).toContain("no-print");

    // The unchanged section renders its cited figure but carries no badge glyph.
    const channels = getByText("Channels").closest("section") as HTMLElement;
    expect(channels.textContent).toContain("48,000");
    expect(channels.textContent).not.toMatch(/[▲▼]/);
  });

  it("renders neither badge nor card without a predecessor", () => {
    const { container, queryByTestId } = render(<ReaderView payload={payload([])} projection={projection} />);
    expect(queryByTestId("delta-card")).toBeNull();
    expect(container.textContent).not.toContain("▲");
  });
});

describe("Reader — memory line + stars", () => {
  it("run report lists the memories the run used, expandable, no-print", () => {
    render(
      <ReaderView
        payload={payload([], {
          memories: [{ id: "mem_1", body: "Express deltas as percentages." }, { id: "mem_2", body: "Unused." }],
          events: [
            { type: "run_started", blueprintRev: 1, sectionKeys: ["s1", "s2"], memoryIds: ["mem_1"] },
            ...baseEvents,
          ],
        })}
      />,
    );
    const line = screen.getByTestId("memory-line");
    expect(line.textContent).toContain("1 standing note");
    expect(line.className).toContain("no-print");
    fireEvent.click(line.querySelector("button")!);
    expect(screen.getByText("Express deltas as percentages.")).toBeTruthy();
    expect(screen.queryByText("Unused.")).toBeNull();
  });

  it("star buttons post goldens for the run and for a section", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") { calls.push({ url: String(url), body: JSON.parse(String(init.body)) }); return Response.json({ id: "gold_1" }); }
      return Response.json({ goldens: [] });
    }));
    render(<ReaderView payload={payload([])} />);
    fireEvent.click(screen.getByRole("button", { name: /star this run/i }));
    await waitFor(() => expect(calls[0]?.body).toMatchObject({ kind: "run" }));
    fireEvent.click(screen.getAllByRole("button", { name: /star section/i })[0]);
    await waitFor(() => expect(calls[1]?.body).toMatchObject({ kind: "section", sectionKey: "s1" }));
  });
});
