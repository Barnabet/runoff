"use client";

import { useState } from "react";
import type { GetRunResponse } from "@/lib/api";
import { ReaderShell } from "@/components/reader/ReaderShell";
import { useRunProjection } from "./useRunProjection";
import { LiveRunView } from "./LiveRunView";

/**
 * Client root for a run page. Builds the live projection from the server-seeded
 * events + SSE stream, then shows the Live Run surface or hands off to the
 * Reader. A run that is already complete on load opens straight in the Reader; a
 * run that completes while being watched shows its completion card, and the
 * "Open the report" button there triggers the handoff. (Task 20 replaces the
 * placeholder Reader.)
 */
export function RunView({ payload }: { payload: GetRunResponse }) {
  const projection = useRunProjection(payload.run.id, payload.events, payload.sectionMeta);
  const [showReader, setShowReader] = useState(payload.run.status === "complete");

  if (showReader) {
    return <ReaderShell payload={payload} projection={projection} />;
  }

  return (
    <LiveRunView
      payload={payload}
      projection={projection}
      onOpenReport={() => setShowReader(true)}
    />
  );
}
