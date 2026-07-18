import { SourcesView } from "@/components/sources/SourcesView";
import { getDb } from "@/lib/db";
import { listSourcesWithUsage } from "@/lib/queries";

// The Sources ledger reads live from SQLite on every request; a fresh upload or
// a run binding a source must show without a rebuild.
export const dynamic = "force-dynamic";

export default function SourcesPage() {
  const sources = listSourcesWithUsage(getDb());
  return <SourcesView sources={sources} />;
}
