"use client";

import { useEffect, useState } from "react";
import type { RunEvent } from "@runoff/core";
// Import the reducer from its own module rather than the package barrel: the
// barrel re-exports the SQLite db layer (node:fs / better-sqlite3), which a
// browser bundle must not pull in. Type-only imports from the barrel are erased
// and stay safe.
import { reduceRun, type RunProjection } from "@runoff/core/src/reducer.js";

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
 * connect) flow through exactly once.
 */
export function useRunProjection(
  runId: string,
  initialEvents: RunEvent[],
  sectionMeta: { key: string; number: number }[],
): RunProjection {
  const [projection, setProjection] = useState<RunProjection>(() =>
    reduceRun(initialEvents, sectionMeta),
  );

  useEffect(() => {
    // The authoritative, ordered event list this connection accumulates.
    const events = [...initialEvents];
    let toSkip = initialEvents.length;
    let frame: number | null = null;
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
        if (frame !== null && canRaf) cancelAnimationFrame(frame);
        frame = null;
        setProjection(reduceRun(events, sectionMeta));
        es.close();
        return;
      }
      scheduleReduce();
    };
    es.onerror = () => es.close();

    return () => {
      if (frame !== null && canRaf) cancelAnimationFrame(frame);
      es.close();
    };
    // Re-subscribe only when the run changes; sectionMeta/initialEvents are stable
    // for a given run (server-rendered once).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  return projection;
}
