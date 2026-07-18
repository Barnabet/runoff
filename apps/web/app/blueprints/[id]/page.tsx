import { notFound } from "next/navigation";
import type { BlueprintContent } from "@runoff/core";
import { Builder } from "@/components/builder/Builder";
import { getDb } from "@/lib/db";
import type { SourceRow } from "@/lib/api";

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

  const boundSources = db.sqlite
    .prepare(
      `SELECT s.id FROM blueprint_sources bs JOIN sources s ON s.id = bs.source_id
       WHERE bs.blueprint_id = ?`,
    )
    .all(id) as { id: string }[];
  // Task 7 replaces this global source list with project-scoped family binding;
  // until then the builder keeps its existing "all sources" feed. Inlined here
  // because the shared listSourcesWithUsage helper was retired with the old
  // global /api/sources routes.
  const allSources = db.sqlite
    .prepare(
      `SELECT s.id, s.name, s.kind, s.stored_filename AS storedFilename, s.mime, s.size,
              s.uploaded_at AS uploadedAt,
              (SELECT COUNT(*) FROM blueprint_sources bs WHERE bs.source_id = s.id) AS usedBy
       FROM sources s
       ORDER BY s.uploaded_at DESC, s.id DESC`,
    )
    .all() as SourceRow[];

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
      allSources={allSources}
      initialBoundIds={boundSources.map((s) => s.id)}
      initialSectionKey={initialSectionKey}
    />
  );
}
