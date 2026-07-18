import { ProjectsView } from "@/components/projects/ProjectsView";
import { getDb } from "@/lib/db";
import { listProjects } from "@/lib/queries";

// The home screen reads live from SQLite on every request; a new project or a
// run finishing must be reflected without a rebuild.
export const dynamic = "force-dynamic";

export default function Home() {
  const projects = listProjects(getDb());
  return <ProjectsView projects={projects} />;
}
