import { notFound } from "next/navigation";
import { ProjectPage } from "@/components/projects/ProjectPage";
import { getDb } from "@/lib/db";
import { getProjectPayload } from "@/lib/queries";

// The project page reads live from SQLite on every request; a new blueprint or a
// run finishing must be reflected without a rebuild.
export const dynamic = "force-dynamic";

export default async function Project({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const payload = getProjectPayload(getDb(), id);
  if (!payload) notFound();
  return (
    <ProjectPage
      project={payload.project}
      blueprints={payload.blueprints}
      families={payload.families}
      unfiled={payload.unfiled}
      memories={payload.memories}
    />
  );
}
