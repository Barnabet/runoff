import { notFound } from "next/navigation";
import { RunView } from "@/components/run/RunView";
import { getDb } from "@/lib/db";
import { getRunPayload } from "@/lib/queries";

// The run page reads the live event log on every request; the client then keeps
// it current over SSE. A run that finished between requests must render its final
// state without a rebuild.
export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const payload = getRunPayload(getDb(), id);
  if (!payload) notFound();
  // Key by run id: navigating "Run it again" pushes a new /runs/<id> without
  // unmounting RunView, so without a changing key its useState initializers keep
  // the previous run's projection until a fresh event arrives. The key forces a
  // clean remount per run.
  return <RunView key={payload.run.id} payload={payload} />;
}
