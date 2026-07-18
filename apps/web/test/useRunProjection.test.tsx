// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { RunEvent } from "@runoff/core";

import { useRunProjection } from "../components/run/useRunProjection";

// A controllable fake EventSource: the hook constructs one, and the test reaches
// for `FakeEventSource.last` to push messages at it.
class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.last = this;
  }
  emit(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  close() {
    this.closed = true;
  }
}

const meta = [
  { key: "s1", number: 1 },
  { key: "s2", number: 2 },
];

const runStarted: RunEvent = { type: "run_started", sectionKeys: ["s1", "s2"], blueprintRev: 1 };
const readA: RunEvent = { type: "source_read", sourceId: "src_a", label: "A", summary: "a" };
const readB: RunEvent = { type: "source_read", sourceId: "src_b", label: "B", summary: "b" };

beforeEach(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  FakeEventSource.last = null;
});
afterEach(cleanup);

describe("useRunProjection", () => {
  it("seeds from the initial events", () => {
    const { result } = renderHook(() => useRunProjection("run_1", [runStarted, readA], meta));
    expect(result.current.projection.status).toBe("running");
    expect(result.current.projection.log.map((l) => l.message)).toEqual(["Read A — a"]);
    expect(result.current.connectionLost).toBe(false);
  });

  it("skips the resent backlog and applies only the trailing new event once", async () => {
    const initial = [runStarted, readA]; // N = 2
    const { result } = renderHook(() => useRunProjection("run_1", initial, meta));

    const es = FakeEventSource.last!;
    expect(es.url).toBe("/api/runs/run_1/events");

    // Server replays the full backlog (the same 2 events) then a new one.
    act(() => {
      es.emit(runStarted);
      es.emit(readA);
      es.emit(readB);
    });

    // The two backlog messages are dropped; only readB is appended → exactly two
    // source_read log lines, in order, with no duplication.
    await waitFor(() =>
      expect(result.current.projection.log.map((l) => l.message)).toEqual([
        "Read A — a",
        "Read B — b",
      ]),
    );
  });

  it("closes the stream on a terminal event", async () => {
    const { result } = renderHook(() => useRunProjection("run_1", [runStarted], meta));
    const es = FakeEventSource.last!;

    act(() => {
      es.emit(runStarted); // skipped backlog (N = 1)
      es.emit({
        type: "run_completed",
        stats: {
          durationMs: 1000,
          words: 10,
          sourcesUsed: 1,
          checksPassed: 1,
          checksFailed: 0,
          flagCount: 0,
          citationCount: 0,
          retries: 0,
        },
        document: { title: "t", eyebrow: "e", dateline: "d", sections: [] },
      });
    });

    await waitFor(() => expect(result.current.projection.status).toBe("complete"));
    expect(es.closed).toBe(true);
    expect(result.current.connectionLost).toBe(false);
  });

  it("reports connection loss on a mid-run stream error", async () => {
    const { result } = renderHook(() => useRunProjection("run_1", [runStarted], meta));
    const es = FakeEventSource.last!;

    act(() => es.onerror?.());

    await waitFor(() => expect(result.current.connectionLost).toBe(true));
    expect(es.closed).toBe(true);
    // The projection freezes at its last-known (still running) state.
    expect(result.current.projection.status).toBe("running");
  });

  it("does not open a stream for an already-terminal seed", () => {
    const completed: RunEvent = {
      type: "run_completed",
      stats: {
        durationMs: 1,
        words: 0,
        sourcesUsed: 0,
        checksPassed: 0,
        checksFailed: 0,
        flagCount: 0,
        citationCount: 0,
        retries: 0,
      },
      document: { title: "t", eyebrow: "e", dateline: "d", sections: [] },
    };
    FakeEventSource.last = null;
    const { result } = renderHook(() => useRunProjection("run_done", [runStarted, completed], meta));
    expect(FakeEventSource.last).toBeNull();
    expect(result.current.projection.status).toBe("complete");
    expect(result.current.connectionLost).toBe(false);
  });
});
