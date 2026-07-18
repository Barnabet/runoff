// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type { Block, RunEvent } from "@runoff/core";

// `vi.mock` factories are hoisted; the fns they close over come from `vi.hoisted`.
const { showToast, postRunInput, createRun, push } = vi.hoisted(() => ({
  showToast: vi.fn(),
  postRunInput: vi.fn(async () => ({ ok: true as const })),
  createRun: vi.fn(async () => ({ id: "run_new0000" })),
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
vi.mock("@/lib/api", () => ({ postRunInput, createRun }));

import { RunView } from "../components/run/RunView";
import type { GetRunResponse } from "../lib/api";

// A no-op EventSource so the projection is driven purely by seeded events; the
// streaming/dedupe path is covered by useRunProjection.test.tsx.
class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  close() {}
}

beforeEach(() => {
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
    content: { title: "Monthly Performance Report", eyebrow: "PREPARED FOR MERIDIAN", dateline: "July 2026" },
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

  it("shows the completion card and hands off to the Reader", () => {
    // run.status is still "running" on load, so the live surface renders and the
    // streamed run_completed brings up the completion card.
    const { getByText, getByTestId, queryByText } = render(<RunView payload={basePayload(finished)} />);
    expect(getByTestId("completion-card").textContent).toContain("Run complete in 14.2s");
    expect(getByText("COMPLETE · 0 FLAGS")).toBeTruthy();

    fireEvent.click(getByText("Open the report →"));
    // ReaderShell takes over.
    expect(queryByText("completion-card")).toBeNull();
    expect(getByText(/Reader arrives in the next task/)).toBeTruthy();
  });

  it("opens straight into the Reader for an already-complete run", () => {
    const { getByText, queryByTestId } = render(<RunView payload={basePayload(finished, "complete")} />);
    expect(queryByTestId("completion-card")).toBeNull();
    expect(getByText(/Reader arrives in the next task/)).toBeTruthy();
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
