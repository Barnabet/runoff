import type { BlueprintSection, SectionQuery, SqlResult } from "@runoff/core";
import { formatSqlResult } from "@runoff/core";
import type { CatalogFamily } from "./catalogFormat.js";
import { packForPrompt, type SourcePack } from "./sourcePack.js";

/**
 * The run's window onto the project warehouse, built by the worker (or eval
 * harness) and injected into executeRun — the engine never opens the warehouse
 * itself. `exec` is read-only and binds `:period` when the SQL references it.
 */
export interface RunData {
  catalog: CatalogFamily[]; // bound families only; document families carry queryable: false
  exec(sql: string): SqlResult; // throws on SQL error (incl. "no data ingested yet")
}

const DEFAULT_LIMIT = 40;

/** `SELECT * … LIMIT 40` per table, used when no baked query covers the family. */
function defaultQueries(fam: CatalogFamily): SectionQuery[] {
  return fam.tables.map((t) => ({
    name: `default_${t.name}`,
    sql: fam.kind === "periodic"
      ? `SELECT * FROM "${t.name}" WHERE _period = :period LIMIT ${DEFAULT_LIMIT}`
      : `SELECT * FROM "${t.name}" LIMIT ${DEFAULT_LIMIT}`,
  }));
}

/** A query "covers" a family when any of the family's table names appears as a word in its SQL. */
function coversFamily(sql: string, fam: CatalogFamily): boolean {
  return fam.tables.some((t) => new RegExp(`\\b${t.name}\\b`).test(sql));
}

/**
 * The per-section data block: for each bound queryable family, schema lines plus
 * each covering baked query (or synthesized defaults) with its result serialized
 * by core's formatSqlResult; document families render through the pack unchanged.
 */
export function sectionDataBlock(section: BlueprintSection, data: RunData, pack: SourcePack): string {
  const byId = new Map(data.catalog.map((f) => [f.id, f]));
  const parts: string[] = [];
  for (const famId of section.familyIds) {
    const fam = byId.get(famId);
    if (!fam || !fam.queryable) {
      const packed = packForPrompt(pack, [famId]);
      if (packed) parts.push(packed);
      continue;
    }
    const lines: string[] = [`### ${fam.label} (${fam.id})`];
    for (const t of fam.tables) {
      const cols = t.columns.map((c) => `${c.name} ${c.type}`).join(", ");
      const total = Object.values(t.rowCounts).reduce((a, b) => a + b, 0);
      lines.push(`${t.name}(${cols}) — ${total.toLocaleString("en-US")} rows`);
    }
    const baked = section.queries.filter((qy) => coversFamily(qy.sql, fam));
    for (const qy of baked.length ? baked : defaultQueries(fam)) {
      lines.push(`-- ${qy.name}: ${qy.sql.replace(/\s*\n\s*/g, " ").trim()}`);
      try {
        lines.push(formatSqlResult(data.exec(qy.sql)));
      } catch (e) {
        lines.push(`query failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}
