"use client";

import { useState } from "react";
import type { GetRunResponse } from "@/lib/api";
import { getRun } from "@/lib/api";
import { showToast } from "@/components/Toast";
import { ReaderView } from "@/components/reader/ReaderView";
import { useRunProjection } from "./useRunProjection";
import { LiveRunView } from "./LiveRunView";

/**
 * Client root for a run page. Builds the live projection from the server-seeded
 * events + SSE stream, then shows the Live Run surface or hands off to the
 * Reader. A run that is already complete on load opens straight in the Reader; a
 * run that completes while being watched shows its completion card, and the
 * "Open the report" button there triggers the handoff.
 *
 * The load-time payload was fetched while the run was still in flight, so its
 * `flags` (and stats/document) can be stale by the time the run finishes. On a
 * live→Reader handoff we therefore refetch the run so the Reader seeds from the
 * final flags — otherwise it could show a false "Cleared. Ready for delivery"
 * banner while open flags actually exist. A complete-on-load run already carries
 * fresh server rows, so it needs no refetch.
 */
export function RunView({ payload }: { payload: GetRunResponse }) {
  const { projection, connectionLost } = useRunProjection(
    payload.run.id,
    payload.events,
    payload.sectionMeta,
  );
  const completeOnLoad = payload.run.status === "complete";
  const [showReader, setShowReader] = useState(completeOnLoad);
  const [readerPayload, setReaderPayload] = useState<GetRunResponse>(payload);
  const [handingOff, setHandingOff] = useState(false);

  function openReport() {
    setHandingOff(true);
    getRun(payload.run.id)
      .then((fresh) => {
        setReaderPayload(fresh);
        setShowReader(true);
      })
      .catch(() => {
        // Fall back to the load-time payload so the handoff still happens; the
        // flags may be stale, but the report still opens.
        showToast("Could not refresh the report — showing the last known state.");
        setReaderPayload(payload);
        setShowReader(true);
      })
      .finally(() => setHandingOff(false));
  }

  if (showReader) {
    return <ReaderView payload={readerPayload} projection={projection} />;
  }

  return (
    <LiveRunView
      payload={payload}
      projection={projection}
      connectionLost={connectionLost}
      handingOff={handingOff}
      onOpenReport={openReport}
    />
  );
}
