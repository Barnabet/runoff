import { LibraryView } from "@/components/library/LibraryView";
import { getDb } from "@/lib/db";
import { listBlueprintsWithRuns } from "@/lib/queries";

// The Library reads live from SQLite on every request; a run finishing must be
// reflected without a rebuild.
export const dynamic = "force-dynamic";

export default function Home() {
  const blueprints = listBlueprintsWithRuns(getDb());
  return <LibraryView blueprints={blueprints} />;
}
