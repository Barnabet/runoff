"use client";

import { useEffect, useState } from "react";
import type { RunEvent } from "@runoff/core";
import { reduceRun, type RunProjection } from "@runoff/core/client";

export interface RunProjectionState {
  projection: RunProjection;
  /**
   * The SSE connection dropped before the run reached a terminal event, so the
   * projection is frozen at its last-known state. We intentionally do NOT
   * reconnect — the count-based backlog dedupe cannot survive a native
   * reconnect's replay — so the surface prompts a manual refresh instead.
   */
  connectionLost: boolean;
}

/**
 * Live projection of a run. Seeds from the events the server rendered with, then
 * opens an `EventSource` on the run's SSE endpoint and re-reduces as events
 * arrive. Re-reduces are batched into a single `requestAnimationFrame` per burst
 * (falling back to a synchronous set where rAF is unavailable — e.g. jsdom) so a
 * fast text stream repaints at most once per frame.
 *
 * The server replays the full backlog on connect, so the first
 * `initialEvents.length` messages duplicate the seed and are skipped; any extra
 * messages beyond that (events that landed between the initial fetch and the
 * connect) flow through exactly once. A seed that is already terminal opens no
 * stream at all.
 */
export function useRunProjection(
  runId: string,
  initialEvents: RunEvent[],
  sectionMeta: { key: string; number: number }[],
): RunProjectionState {
  const [projection, setProjection] = useState<RunProjection>(() =>
    reduceRun(initialEvents, sectionMeta),
  );
  const [connectionLost, setConnectionLost] = useState(false);

  useEffect(() => {
    setConnectionLost(false);
    // A run that finished before this render needs no live stream; connecting
    // would only replay the backlog and then drop (a false "connection lost").
    const seedTerminal = initialEvents.some(
      (e) => e.type === "run_completed" || e.type === "run_failed",
    );
    if (seedTerminal) return;

    // The authoritative, ordered event list this connection accumulates.
    const events = [...initialEvents];
    let toSkip = initialEvents.length;
    let frame: number | null = null;
    let terminated = false;
    const canRaf = typeof requestAnimationFrame !== "undefined";

    const reduceNow = () => {
      frame = null;
      setProjection(reduceRun(events, sectionMeta));
    };
    // Coalesce a burst of deltas into one re-reduce per animation frame.
    const scheduleReduce = () => {
      if (!canRaf) {
        reduceNow();
        return;
      }
      if (frame === null) frame = requestAnimationFrame(reduceNow);
    };

    const es = new EventSource(`/api/runs/${runId}/events`);
    es.onmessage = (m) => {
      if (toSkip > 0) {
        toSkip -= 1;
        return;
      }
      let event: RunEvent;
      try {
        event = JSON.parse(m.data) as RunEvent;
      } catch {
        return;
      }
      events.push(event);
      if (event.type === "run_completed" || event.type === "run_failed") {
        // Terminal: reduce immediately (don't wait for a frame) and stop.
        terminated = true;
        if (frame !== null && canRaf) cancelAnimationFrame(frame);
        frame = null;
        setProjection(reduceRun(events, sectionMeta));
        es.close();
        return;
      }
      scheduleReduce();
    };
    es.onerror = () => {
      es.close();
      // A drop after the terminal event is expected (the server closes the
      // stream); only a mid-run drop freezes the surface.
      if (!terminated) setConnectionLost(true);
    };

    return () => {
      if (frame !== null && canRaf) cancelAnimationFrame(frame);
      es.close();
    };
    // Re-subscribe only when the run changes; sectionMeta/initialEvents are stable
    // for a given run (server-rendered once).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  return { projection, connectionLost };
}
