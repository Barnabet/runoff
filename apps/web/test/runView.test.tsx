// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import type { Block, RunEvent } from "@runoff/core";

// `vi.mock` factories are hoisted; the fns they close over come from `vi.hoisted`.
const { showToast, postRunInput, createRun, getRun, push } = vi.hoisted(() => ({
  showToast: vi.fn(),
  postRunInput: vi.fn(async () => ({ ok: true as const })),
  createRun: vi.fn(async () => ({ id: "run_new0000" })),
  getRun: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/Toast", () => ({ showToast, Toast: () => null }));
vi.mock("@/lib/api", () => ({ postRunInput, createRun, getRun, resolveFlag: vi.fn(), getBlueprint: vi.fn(), saveRevision: vi.fn() }));

import { RunView } from "../components/run/RunView";
import type { GetRunResponse } from "../lib/api";

// A no-op EventSource so the projection is driven purely by seeded events; the
// streaming/dedupe path is covered by useRunProjection.test.tsx. `last` lets a
// test reach the live instance to simulate a stream error.
class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.last = this;
  }
  close() {}
}

beforeEach(() => {
  FakeEventSource.last = null;
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const paragraph: Block = {
  type: "paragraph",
  spans: [{ text: "Revenue closed at $2.41M, a strong month." }],
};

const sectionMeta = [
  { key: "s1", number: 1, heading: "Overview" },
  { key: "s2", number: 2, heading: "Executive summary" },
  { key: "s3", number: 3, heading: "Channels" },
];

function basePayload(events: RunEvent[], status = "running"): GetRunResponse {
  return {
    run: {
      id: "run_abcd1234ef56",
      blueprintId: "bp_1",
      blueprintRev: 15,
      triggerKind: "manual",
      status,
      startedAt: "2026-07-18 09:00:00",
      finishedAt: null,
      stats: null,
      document: null,
      createdAt: "2026-07-18 09:00:00",
    },
    events,
    flags: [],
    sectionMeta,
    sourceLabels: { src_a: "GA4", src_b: "spend.csv" },
    blueprint: { id: "bp_1", name: "Monthly Performance Report", clientName: "Meridian" },
    content: {
      title: "Monthly Performance Report",
      eyebrow: "PREPARED FOR MERIDIAN",
      dateline: "July 2026",
      delivery: { recipient: "reports@meridianretail.com", autoDeliverOnClear: false },
    },
    previous: null,
  };
}

// s1 done, s2 writing (mid-typed), s3 queued; one open question on s2; a log line.
const midRun: RunEvent[] = [
  { type: "run_started", sectionKeys: ["s1", "s2", "s3"], blueprintRev: 15 },
  { type: "source_read", sourceId: "src_a", label: "GA4", summary: "revenue + sessions" },
  { type: "section_started", sectionKey: "s1" },
  { type: "section_completed", sectionKey: "s1", blocks: [paragraph], words: 178, ms: 1200, retries: 1 },
  { type: "section_started", sectionKey: "s2" },
  { type: "text_delta", sectionKey: "s2", text: "The month landed ahead of plan" },
  {
    type: "question_raised",
    questionId: "q1",
    sectionKey: "s2",
    question: "Two sources disagree on spend — cite both?",
    options: ["Cite them", "Leave it out"],
    fallback: "I'll leave it unattributed and note it for review.",
    deadlineSection: "s3",
  },
];

describe("Live Run — rails and center", () => {
  it("renders per-section rail states: done meta, writing spine, queued glyph", () => {
    const { getByTestId } = render(<RunView payload={basePayload(midRun)} />);

    const done = getByTestId("rail-row-s1");
    expect(done.textContent).toContain("✓");
    expect(done.textContent).toContain("178w");
    expect(done.textContent).toContain("retry 1");

    const writing = getByTestId("rail-row-s2");
    expect(writing.textContent).toContain("writing…");
    expect(writing.className).toContain("bg-wash");
    expect(writing.className).toContain("border-pencil");

    const queued = getByTestId("rail-row-s3");
    expect(queued.textContent).toContain("○");
  });

  it("streams the writing section's typed text into the center page", () => {
    const { getByText } = render(<RunView payload={basePayload(midRun)} />);
    expect(getByText(/The month landed ahead of plan/)).toBeTruthy();
    // The done section's final block text also renders.
    expect(getByText(/Revenue closed at \$2\.41M/)).toBeTruthy();
  });

  it("renders streamed dialect as blocks — chips and whole table rows, raw syntax held back", () => {
    // A live run showed raw [[…]] markers and pipe rows on the page until the
    // section completed; the stream must parse progressively instead.
    const streaming: RunEvent[] = [
      ...midRun,
      {
        type: "text_delta",
        sectionKey: "s2",
        text:
          ", spending [[220,500|src_a|sum(src_a.amount)]] overall.\n\n" +
          "| Channel | Spend |\n| --- | --- |\n" +
          "| Search | [[100,200|src_a|sum(src_a.amount where channel=search)]] |\n" +
          "| Social | [[67,4",
      },
    ];
    const { container } = render(<RunView payload={basePayload(streaming)} />);
    const text = container.textContent ?? "";

    // Complete markers render as text + chip; complete table rows render as rows.
    expect(text).toContain("220,500");
    expect(text).toContain("Search");
    expect(text).toContain("100,200");
    // No raw dialect syntax on the page; the in-progress row is held back whole.
    expect(text).not.toContain("[[");
    expect(text).not.toContain("src_a|");
    expect(text).not.toContain("67,4");
  });

  it("shows the live phase badge and the source ledger", () => {
    const { getByText } = render(<RunView payload={basePayload(midRun)} />);
    // Phase after the last section_started is DRAFTING §02.
    expect(getByText("DRAFTING §02")).toBeTruthy();
    expect(getByText("SOURCES — 2")).toBeTruthy();
    expect(getByText("BLUEPRINT — REV 15")).toBeTruthy();
  });
});

describe("Live Run — the agent's desk", () => {
  it("renders the log feed with a warn/info glyph", () => {
    const { getByTestId } = render(<RunView payload={basePayload(midRun)} />);
    expect(getByTestId("log-feed").textContent).toContain("Read GA4 — revenue + sessions");
  });

  it("answers an open question by posting the chosen option", () => {
    const { getByText } = render(<RunView payload={basePayload(midRun)} />);
    fireEvent.click(getByText("Cite them"));
    expect(postRunInput).toHaveBeenCalledWith("run_abcd1234ef56", {
      kind: "answer",
      questionId: "q1",
      text: "Cite them",
    });
  });

  it("acknowledges a sent answer on the question card immediately", () => {
    // The agent only consumes answers at its next drafting step — without an
    // immediate acknowledgment users re-click (4 duplicate rows in a live run).
    const { getByText, getByTestId } = render(<RunView payload={basePayload(midRun)} />);
    const card = () => getByTestId("question-card-q1");
    expect(card().textContent).toContain("No answer by");

    fireEvent.click(getByText("Cite them"));
    expect(card().textContent).toContain("Answer sent");
    expect(card().textContent).not.toContain("No answer by");
  });

  it("optimistically appends a steer line and posts the steer", () => {
    const { getByLabelText, getByText } = render(<RunView payload={basePayload(midRun)} />);
    const input = getByLabelText("steer the run") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "skip web research" } });
    fireEvent.click(getByText("Send"));

    expect(getByText("skip web research")).toBeTruthy();
    expect(postRunInput).toHaveBeenCalledWith("run_abcd1234ef56", {
      kind: "steer",
      text: "skip web research",
    });
  });

  it("toasts on an empty steer", () => {
    const { getByText } = render(<RunView payload={basePayload(midRun)} />);
    fireEvent.click(getByText("Send"));
    expect(showToast).toHaveBeenCalledWith("Type a steer first.");
  });
});

describe("Live Run — pause and completion", () => {
  it("posts pause when the run is running", () => {
    const { getByText } = render(<RunView payload={basePayload(midRun)} />);
    fireEvent.click(getByText("Pause run"));
    expect(postRunInput).toHaveBeenCalledWith("run_abcd1234ef56", { kind: "pause" });
  });

  const finished: RunEvent[] = [
    { type: "run_started", sectionKeys: ["s1"], blueprintRev: 15 },
    { type: "section_started", sectionKey: "s1" },
    { type: "section_completed", sectionKey: "s1", blocks: [paragraph], words: 178, ms: 1200, retries: 0 },
    { type: "render_started" },
    {
      type: "run_completed",
      stats: {
        durationMs: 14200,
        words: 2140,
        sourcesUsed: 5,
        checksPassed: 10,
        checksFailed: 0,
        flagCount: 2,
        citationCount: 31,
        retries: 1,
      },
      document: {
        title: "Monthly Performance Report",
        eyebrow: "PREPARED FOR MERIDIAN",
        dateline: "July 2026",
        sections: [{ key: "s1", heading: "Overview", blocks: [paragraph] }],
      },
    },
  ];

  it("shows the completion card and hands off to the Reader", async () => {
    // run.status is still "running" on load, so the live surface renders and the
    // streamed run_completed brings up the completion card.
    getRun.mockResolvedValue(basePayload(finished, "complete"));
    const { getByText, getByTestId, queryByTestId } = render(<RunView payload={basePayload(finished)} />);
    expect(getByTestId("completion-card").textContent).toContain("Run complete in 14.2s");
    expect(getByText("COMPLETE · 0 FLAGS")).toBeTruthy();

    fireEvent.click(getByText("Open the report →"));
    // The handoff refetches the run, then the ReaderView takes over.
    await waitFor(() => expect(getByTestId("run-report")).toBeTruthy());
    expect(queryByTestId("completion-card")).toBeNull();
    expect(getRun).toHaveBeenCalledWith("run_abcd1234ef56");
  });

  it("refetches fresh flags on handoff so a late flag is not lost (no false Cleared banner)", async () => {
    // The load-time payload carried no flags (run still writing), but the run
    // finished with an open flag. The handoff refetch must surface it: an amber
    // "open" banner and a flag card — never the ink "Cleared" banner.
    const fresh = basePayload(finished, "complete");
    fresh.flags = [
      {
        id: "run_abcd1234ef56_flag_1",
        runId: "run_abcd1234ef56",
        code: "F1",
        sectionKey: "s1",
        question: "Soften this claim?",
        options: ["Keep", "Soften"],
        status: "open",
        resolution: null,
        createdAt: "2026-07-18 09:00:00",
      },
    ];
    getRun.mockResolvedValue(fresh);

    const { getByText, getByTestId } = render(<RunView payload={basePayload(finished)} />);
    fireEvent.click(getByText("Open the report →"));

    await waitFor(() => expect(getByTestId("run-report")).toBeTruthy());
    // The refetched open flag renders as a card and keeps the banner amber.
    expect(getByTestId("flag-card-run_abcd1234ef56_flag_1")).toBeTruthy();
    expect(getByTestId("status-banner").getAttribute("data-state")).toBe("open");
  });

  it("opens straight into the Reader for an already-complete run", () => {
    const { getByTestId, queryByTestId } = render(<RunView payload={basePayload(finished, "complete")} />);
    expect(queryByTestId("completion-card")).toBeNull();
    expect(getByTestId("run-report")).toBeTruthy();
  });

  it("remounts per run id so a new run does not inherit the previous projection", () => {
    // Keying RunView by run id (as the server page does) forces a clean remount
    // when "Run it again" navigates to a new run.
    const first = basePayload(finished);
    const { getByTestId, queryByTestId, rerender } = render(
      <RunView key={first.run.id} payload={first} />,
    );
    expect(getByTestId("completion-card")).toBeTruthy();

    const next = basePayload([
      { type: "run_started", sectionKeys: ["s1", "s2", "s3"], blueprintRev: 15 },
    ]);
    next.run.id = "run_zzzz9999";
    rerender(<RunView key={next.run.id} payload={next} />);

    // Fresh queued run — the stale completion card is gone.
    expect(queryByTestId("completion-card")).toBeNull();
    expect(getByTestId("rail-row-s1").textContent).toContain("○");
  });
});

describe("Live Run — connection loss", () => {
  it("shows a banner when the SSE stream drops mid-run", () => {
    const { getByTestId, queryByTestId } = render(<RunView payload={basePayload(midRun)} />);
    expect(queryByTestId("connection-lost")).toBeNull();

    act(() => FakeEventSource.last!.onerror?.());

    expect(getByTestId("connection-lost").textContent).toContain("CONNECTION LOST");
  });
});

describe("Live Run — failed", () => {
  const failed: RunEvent[] = [
    { type: "run_started", sectionKeys: ["s1"], blueprintRev: 15 },
    { type: "run_failed", error: "§02 draft — model timeout after 3 retries" },
  ];

  it("shows a failure banner with a run-again link", () => {
    const { getByTestId } = render(<RunView payload={basePayload(failed)} />);
    const banner = getByTestId("failed-banner");
    expect(banner.textContent).toContain("model timeout after 3 retries");
    fireEvent.click(within(banner).getByText("Run it again"));
    expect(createRun).toHaveBeenCalledWith("bp_1");
  });
});
