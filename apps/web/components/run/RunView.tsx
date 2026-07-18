"use client";

import { useState } from "react";
import type { GetRunResponse } from "@/lib/api";
import { ReaderView } from "@/components/reader/ReaderView";
import { useRunProjection } from "./useRunProjection";
import { LiveRunView } from "./LiveRunView";

/**
 * Client root for a run page. Builds the live projection from the server-seeded
 * events + SSE stream, then shows the Live Run surface or hands off to the
 * Reader. A run that is already complete on load opens straight in the Reader; a
 * run that completes while being watched shows its completion card, and the
 * "Open the report" button there triggers the handoff.
 */
export function RunView({ payload }: { payload: GetRunResponse }) {
  const { projection, connectionLost } = useRunProjection(
    payload.run.id,
    payload.events,
    payload.sectionMeta,
  );
  const [showReader, setShowReader] = useState(payload.run.status === "complete");

  if (showReader) {
    return <ReaderView payload={payload} projection={projection} />;
  }

  return (
    <LiveRunView
      payload={payload}
      projection={projection}
      connectionLost={connectionLost}
      onOpenReport={() => setShowReader(true)}
    />
  );
}
