import { notFound } from "next/navigation";
import type { BlueprintContent } from "@runoff/core";
import { Builder } from "@/components/builder/Builder";
import { getDb } from "@/lib/db";
import { listProjectSources } from "@/lib/sourceManager";

// The builder reads the live current revision and bound sources on every
// request; a save or an applied copilot edit must show on reload without a
// rebuild.
export const dynamic = "force-dynamic";

interface BlueprintRow {
  id: string;
  name: string;
  clientName: string;
  status: string;
  currentRev: number;
  projectId: string;
}

export default async function BlueprintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getDb();

  const blueprint = db.sqlite
    .prepare(
      `SELECT id, name, client_name AS clientName, status, current_rev AS currentRev,
              project_id AS projectId
       FROM blueprints WHERE id = ?`,
    )
    .get(id) as BlueprintRow | undefined;
  if (!blueprint) notFound();

  const projectRow = db.sqlite
    .prepare("SELECT id, name FROM projects WHERE id = ?")
    .get(blueprint.projectId) as { id: string; name: string } | undefined;
  const project = projectRow ?? { id: blueprint.projectId, name: "" };

  const revRow = db.sqlite
    .prepare("SELECT content FROM blueprint_revisions WHERE blueprint_id = ? AND rev = ?")
    .get(id, blueprint.currentRev) as { content: string } | undefined;
  if (!revRow) notFound();
  const content = JSON.parse(revRow.content) as BlueprintContent;

  // Project-scoped family binding: every family in the owning project is
  // bindable, and blueprint_families records which are bound to this blueprint.
  const { families } = listProjectSources(db, blueprint.projectId);
  const boundFamilyIds = (
    db.sqlite
      .prepare("SELECT family_id AS familyId FROM blueprint_families WHERE blueprint_id = ?")
      .all(id) as { familyId: string }[]
  ).map((r) => r.familyId);

  const initialSectionKey = content.sections[0]?.key ?? "";

  return (
    <Builder
      blueprintId={blueprint.id}
      name={blueprint.name}
      clientName={blueprint.clientName}
      projectId={project.id}
      projectName={project.name}
      initialStatus={blueprint.status}
      initialRev={blueprint.currentRev}
      initialContent={content}
      families={families}
      initialBoundIds={boundFamilyIds}
      initialSectionKey={initialSectionKey}
    />
  );
}
