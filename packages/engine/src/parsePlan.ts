import type { Granularity, ParsePlan, TablePlan, ExecReport, WhColumn } from "@runoff/core";
import { xlsxGrids, csvGrid, slugify } from "./tabular.js";
import { extname } from "node:path";

// Deterministic ParsePlan executor. TOTAL: never throws — anchoring/mapping
// failures become byte-exact `problems` lines and the table yields no rows.
// Ingest callers throw the first problem; preview callers render them.

export interface SheetGrid { sheet: string; grid: unknown[][] }
export interface ExecTable { logical: string; columns: WhColumn[]; rows: unknown[][] }

export const normCell = (v: unknown): string =>
  v === null || v === undefined ? "" : String(v).trim().toLowerCase().replace(/\s+/g, " ");
export const rawCell = (v: unknown): string =>
  v === null || v === undefined ? "" : String(v).trim();

export async function loadGrids(path: string, mime: string, name: string): Promise<SheetGrid[]> {
  const isCsv = mime.toLowerCase().includes("csv") || extname(name).toLowerCase() === ".csv";
  if (isCsv) return [{ sheet: slugify(name.replace(/\.[^.]+$/, "")), grid: await csvGrid(path) }];
  return (await xlsxGrids(path)).map((s) => ({ sheet: s.slug, grid: s.grid }));
}

interface Resolved { sheetIdx: number; row: number }

function rowMatchesAnchor(row: unknown[], t: TablePlan): boolean {
  const cells = new Set(row.map(normCell).filter((s) => s !== ""));
  const sig = [...new Set(t.anchor.headerSignature.map(normCell))];
  let hits = 0;
  for (const s of sig) if (cells.has(s)) hits++;
  return hits >= Math.min(t.anchor.minMatch, sig.length);
}

/** Resolve every table's anchor. Plan order; sheet hint reorders the scan; a row anchors at most one table. */
function resolveAnchors(grids: SheetGrid[], plan: ParsePlan): Map<string, Resolved | null> {
  const out = new Map<string, Resolved | null>();
  const used = new Set<string>(); // `${sheetIdx}:${row}`
  for (const t of plan.tables) {
    const order = [...grids.keys()].sort((a, b) => {
      const hint = (i: number): number => (t.anchor.sheet !== undefined && grids[i].sheet === t.anchor.sheet ? 0 : 1);
      return hint(a) - hint(b) || a - b;
    });
    let found: Resolved | null = null;
    outer: for (const si of order) {
      const grid = grids[si].grid;
      for (let r = 0; r < grid.length; r++) {
        if (used.has(`${si}:${r}`)) continue;
        if (rowMatchesAnchor(grid[r] ?? [], t)) { found = { sheetIdx: si, row: r }; break outer; }
      }
    }
    if (found) used.add(`${found.sheetIdx}:${found.row}`);
    out.set(t.name, found);
  }
  return out;
}

interface Extracted {
  matchedCols: number[];
  mergedNorm: Map<number, string>;   // col → normalized merged header
  mergedRaw: Map<number, string>;    // col → raw merged header (original casing)
  colFor: Map<string, number>;       // canonical name → col index
  unknown: string[];                 // raw merged headers matched by nothing
  valueCols: number[];               // unpivot value columns (Task 3 consumes)
  dataRows: unknown[][];             // raw grid rows (full rows) inside the region
  problems: string[];
}

function extractRegion(grids: SheetGrid[], plan: ParsePlan, t: TablePlan, at: Resolved): Extracted {
  const grid = grids[at.sheetIdx].grid;
  const headerRows = grid.slice(at.row, at.row + t.headerRows);
  const maxCol = Math.max(...headerRows.map((r) => (r ?? []).length), 0);
  const mergedNorm = new Map<number, string>();
  const mergedRaw = new Map<number, string>();
  const matchedCols: number[] = [];
  for (let c = 0; c < maxCol; c++) {
    const norm = headerRows.map((r) => normCell((r ?? [])[c])).filter((s) => s !== "").join(" ");
    const raw = headerRows.map((r) => rawCell((r ?? [])[c])).filter((s) => s !== "").join(" ");
    if (norm === "") continue;
    mergedNorm.set(c, norm);
    mergedRaw.set(c, raw);
    matchedCols.push(c);
  }

  const problems: string[] = [];
  const colFor = new Map<string, number>();
  const claimed = new Set<number>();
  for (const cp of t.columns) {
    const want = normCell(cp.from);
    const col = matchedCols.find((c) => mergedNorm.get(c) === want && !claimed.has(c));
    if (col === undefined) { problems.push(`missing column: ${t.name}.${cp.from}`); continue; }
    claimed.add(col);
    colFor.set(cp.name, col);
  }
  const valueRe = t.unpivot ? new RegExp(t.unpivot.valuePattern, "i") : null;
  const valueCols: number[] = [];
  const unknown: string[] = [];
  for (const c of matchedCols) {
    if (claimed.has(c)) continue;
    if (valueRe && valueRe.test(mergedNorm.get(c) as string)) { valueCols.push(c); continue; }
    unknown.push(mergedRaw.get(c) as string);
  }

  // Data rows: below the header until 2 consecutive rows blank across matched
  // columns, a row that anchors ANOTHER plan table, or sheet end.
  const others = plan.tables.filter((o) => o.name !== t.name);
  const dataRows: unknown[][] = [];
  let blanks = 0;
  for (let r = at.row + t.headerRows; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const blank = matchedCols.every((c) => normCell(row[c]) === "");
    if (blank) { blanks++; if (blanks >= 2) break; continue; }
    blanks = 0;
    if (others.some((o) => rowMatchesAnchor(row, o))) break;
    dataRows.push(row);
  }
  return { matchedCols, mergedNorm, mergedRaw, colFor, unknown, valueCols, dataRows, problems };
}

export function executeParsePlan(
  grids: SheetGrid[],
  plan: ParsePlan,
  slotPeriod: string | null,
  granularity: Granularity | null,
): { tables: ExecTable[]; report: ExecReport } {
  const anchors = resolveAnchors(grids, plan);
  const tables: ExecTable[] = [];
  const report: ExecReport = { tables: [] };
  for (const t of plan.tables) {
    const at = anchors.get(t.name) ?? null;
    const rep: ExecReport["tables"][number] = {
      name: t.name,
      anchor: at ? { sheet: grids[at.sheetIdx].sheet, row: at.row } : null,
      problems: [],
      rowsKept: 0,
      rowsExcluded: [],
      coercionFailures: [],
      periodMismatches: null,
      unknownColumns: [],
    };
    const outCols: WhColumn[] = outputColumns(t);
    if (!at) {
      rep.problems.push(`unanchored table: ${t.name}`);
      tables.push({ logical: t.name, columns: outCols, rows: [] });
      report.tables.push(rep);
      continue;
    }
    const ex = extractRegion(grids, plan, t, at);
    rep.unknownColumns = ex.unknown;
    if (ex.problems.length) {
      rep.problems.push(...ex.problems);
      tables.push({ logical: t.name, columns: outCols, rows: [] });
      report.tables.push(rep);
      continue;
    }
    const { rows } = processRows(t, ex, rep, slotPeriod, granularity);
    rep.rowsKept = rows.length;
    tables.push({ logical: t.name, columns: outCols, rows });
    report.tables.push(rep);
  }
  return { tables, report };
}

/** Output schema for one table plan (unpivot-aware). */
function outputColumns(t: TablePlan): WhColumn[] {
  if (!t.unpivot) return t.columns.map((c) => ({ name: c.name, type: c.type }));
  const keep = t.columns.filter((c) => t.unpivot!.keep.includes(c.name));
  return [
    ...keep.map((c) => ({ name: c.name, type: c.type })),
    { name: t.unpivot.keyColumn, type: "TEXT" as const },
    { name: t.unpivot.valueColumn, type: t.unpivot.valueType },
  ];
}

/** Row filtering + output building. Coercion/unpivot/period arrive in Task 3. */
function processRows(
  t: TablePlan,
  ex: Extracted,
  rep: ExecReport["tables"][number],
  slotPeriod: string | null,
  granularity: Granularity | null,
): { rows: unknown[][] } {
  void slotPeriod; void granularity;
  const headerNormByCol = ex.mergedNorm;
  const excludeCounters = new Map<string, { count: number; samples: string[] }>();
  const rowSample = (row: unknown[]): string =>
    ex.matchedCols.map((c) => rawCell(row[c])).join(" | ").slice(0, 80);
  const rows: unknown[][] = [];
  for (const row of ex.dataRows) {
    // repeated page header: matched cells equal the (first) header row
    if (ex.matchedCols.every((c) => normCell(row[c]) === headerNormByCol.get(c))) continue;
    let dropped = false;
    for (const rule of t.exclude) {
      const re = new RegExp(rule.pattern, "i");
      const hit = rule.column === null
        ? ex.matchedCols.some((c) => re.test(rawCell(row[c])))
        : re.test(rawCell(row[ex.colFor.get(rule.column) as number]));
      if (hit) {
        const c = excludeCounters.get(rule.pattern) ?? { count: 0, samples: [] };
        c.count++;
        if (c.samples.length < 3) c.samples.push(rowSample(row));
        excludeCounters.set(rule.pattern, c);
        dropped = true;
        break;
      }
    }
    if (dropped) continue;
    rows.push(t.columns.map((cp) => {
      const v = row[ex.colFor.get(cp.name) as number];
      return v === null || v === undefined || (typeof v === "string" && v.trim() === "") ? null : v;
    }));
  }
  rep.rowsExcluded = [...excludeCounters.entries()].map(([pattern, c]) => ({ pattern, ...c }));
  return { rows };
}

export function fitParsePlan(
  grids: SheetGrid[],
  plan: ParsePlan,
): { verdict: "fit" | "partial" | "no_fit"; detail: string[] } {
  const anchors = resolveAnchors(grids, plan);
  const detail: string[] = [];
  let anchored = 0;
  let clean = 0;
  for (const t of plan.tables) {
    const at = anchors.get(t.name) ?? null;
    if (!at) { detail.push(`unanchored table: ${t.name}`); continue; }
    anchored++;
    const ex = extractRegion(grids, plan, t, at);
    detail.push(...ex.problems);
    for (const u of ex.unknown) detail.push(`unknown column: ${u}`);
    if (!ex.problems.length) clean++;
  }
  const verdict = anchored === 0 ? "no_fit" : clean === plan.tables.length ? "fit" : "partial";
  return { verdict, detail };
}
