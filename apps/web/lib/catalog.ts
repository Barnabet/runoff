import { buildWarehouseCatalog, type RunoffDb } from "@runoff/core";
import type { CatalogFamily } from "@runoff/engine";

/** Families → warehouse tables/columns/counts for one project. Server-only. */
export function catalog(db: RunoffDb, projectId: string): CatalogFamily[] {
  return buildWarehouseCatalog(db, projectId);
}
