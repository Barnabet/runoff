import { createReadStream } from "node:fs";
import { extname } from "node:path";
import Papa from "papaparse";
import ExcelJS from "exceljs";
import type { WhColumn } from "@runoff/core";
import { cellValue } from "./sourcePack.js";

// File → detected tables. Pure detection (detectIslands) is separated from IO
// so the heuristics are unit-testable on plain grids. scanTabular (schema, for
// classify/drift/UI) and readTabular (full rows, for ingest) MUST agree on
// slugs/columns/order for the same file — Task 3 relies on that.

export interface DetectedTable { slug: string; columns: WhColumn[]; rowCount: number; sample: unknown[][] }
export interface TabularScan { tables: DetectedTable[]; skipped: string[] }

const BATCH = 10_000;
const SAMPLE = 10;
const PREVIEW = 80;

export function isTabular(mime: string, name: string): boolean {
  const m = mime.toLowerCase();
  if (m.includes("csv") || m.includes("spreadsheetml") || m.includes("ms-excel")) return true;
  return [".csv", ".xlsx", ".xls"].includes(extname(name).toLowerCase());
}

function isCsv(mime: string, name: string): boolean {
  return mime.toLowerCase().includes("csv") || extname(name).toLowerCase() === ".csv";
}

export function slugify(name: string): string {
  // Strip trailing underscores (punctuation tails) but preserve a leading one:
  // a leading underscore is meaningful — it lets a source column collide with
  // the reserved `_period` warehouse column so headerNames can bump it.
  const s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/g, "").replace(/_+/g, "_");
  const safe = s || "table";
  return /^\d/.test(safe) ? `t_${safe}` : safe;
}

const isEmpty = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/** Per-column type accumulator: all-int → INTEGER, all-num → REAL, else TEXT. */
class ColumnTyper {
  private sawValue: boolean[] = [];
  private allInt: boolean[] = [];
  private allNum: boolean[] = [];
  update(row: unknown[]): void {
    for (let i = 0; i < row.length; i++) {
      const v = row[i];
      if (isEmpty(v)) continue;
      this.sawValue[i] = true;
      const num = typeof v === "number" && Number.isFinite(v);
      this.allNum[i] = (this.allNum[i] ?? true) && num;
      this.allInt[i] = (this.allInt[i] ?? true) && num && Number.isInteger(v as number);
    }
  }
  typeAt(i: number): WhColumn["type"] {
    if (!this.sawValue[i]) return "TEXT";
    if (this.allInt[i]) return "INTEGER";
    if (this.allNum[i]) return "REAL";
    return "TEXT";
  }
}

function headerNames(raw: unknown[]): string[] {
  const names: string[] = [];
  const used = new Set<string>();
  raw.forEach((h, i) => {
    let name = isEmpty(h) ? `column_${i + 1}` : slugify(String(h));
    if (name === "_period") name = "_period_2";
    let candidate = name;
    for (let n = 2; used.has(candidate); n++) candidate = `${name}_${n}`;
    used.add(candidate);
    names.push(candidate);
  });
  return names;
}

/**
 * Deterministic island detection: blank-row bands × blank-column runs.
 * `usedSlugs` accumulates every slug already emitted so callers can enforce
 * uniqueness across a whole file (all sheets + islands), not just within one
 * sheet — pass a shared set to dedupe across sheets via the `_2`/`_3` convention.
 */
export function detectIslands(
  grid: unknown[][],
  sheetSlug: string,
  usedSlugs: Set<string> = new Set(),
): { tables: { slug: string; header: string[]; rows: unknown[][] }[]; skipped: string[] } {
  const tables: { slug: string; header: string[]; rows: unknown[][] }[] = [];
  const skipped: string[] = [];

  const rowHas = (r: number): boolean => (grid[r] ?? []).some((c) => !isEmpty(c));
  const bands: [number, number][] = [];
  for (let r = 0; r < grid.length; r++) {
    if (!rowHas(r)) continue;
    if (bands.length && bands[bands.length - 1][1] === r - 1) bands[bands.length - 1][1] = r;
    else bands.push([r, r]);
  }

  for (const [r0, r1] of bands) {
    let maxCol = 0;
    for (let r = r0; r <= r1; r++) maxCol = Math.max(maxCol, (grid[r] ?? []).length);
    const colHas = (c: number): boolean => {
      for (let r = r0; r <= r1; r++) if (!isEmpty((grid[r] ?? [])[c])) return true;
      return false;
    };
    const runs: [number, number][] = [];
    for (let c = 0; c < maxCol; c++) {
      if (!colHas(c)) continue;
      if (runs.length && runs[runs.length - 1][1] === c - 1) runs[runs.length - 1][1] = c;
      else runs.push([c, c]);
    }
    for (const [c0, c1] of runs) {
      const width = c1 - c0 + 1;
      const height = r1 - r0 + 1;
      const cells = (r: number): unknown[] => {
        const row = grid[r] ?? [];
        return Array.from({ length: width }, (_, i) => row[c0 + i] ?? null);
      };
      if (width < 2 || height < 2) {
        const text: string[] = [];
        for (let r = r0; r <= r1; r++) for (const v of cells(r)) if (!isEmpty(v)) text.push(String(v));
        skipped.push(text.join(" ").slice(0, PREVIEW));
        continue;
      }
      const header = headerNames(cells(r0));
      const rows: unknown[][] = [];
      for (let r = r0 + 1; r <= r1; r++) {
        const row = cells(r);
        if (row.some((v) => !isEmpty(v))) rows.push(row);
      }
      const base = tables.length === 0 ? sheetSlug : `${sheetSlug}_${tables.length + 1}`;
      let slug = base;
      for (let n = 2; usedSlugs.has(slug); n++) slug = `${base}_${n}`;
      usedSlugs.add(slug);
      tables.push({ slug, header, rows });
    }
  }
  return { tables, skipped };
}

function tableFromRows(slug: string, header: string[], rows: unknown[][]): DetectedTable {
  const typer = new ColumnTyper();
  for (const r of rows) typer.update(r);
  return {
    slug,
    columns: header.map((name, i) => ({ name, type: typer.typeAt(i) })),
    rowCount: rows.length,
    sample: rows.slice(0, SAMPLE),
  };
}

// --- CSV -------------------------------------------------------------------

/** One streaming pass over a CSV; hands each data row to `onRow`. */
function streamCsv(path: string, onHeader: (h: string[]) => void, onRow: (row: unknown[]) => void): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let header: string[] | null = null;
    Papa.parse(createReadStream(path), {
      dynamicTyping: true,
      skipEmptyLines: true,
      step: (result) => {
        const row = result.data as unknown[];
        if (!header) { header = headerNames(row); onHeader(header); return; }
        onRow(row);
      },
      complete: () => resolvePromise(),
      error: (err) => reject(err),
    });
  });
}

// --- XLSX ------------------------------------------------------------------

/** Whole-file CSV grid with NO dynamic typing — plan-path callers own typing. */
export function csvGrid(path: string): Promise<unknown[][]> {
  return new Promise((resolvePromise, reject) => {
    const grid: unknown[][] = [];
    Papa.parse(createReadStream(path), {
      dynamicTyping: false,
      skipEmptyLines: true,
      step: (result) => { grid.push(result.data as unknown[]); },
      complete: () => resolvePromise(grid),
      error: (err) => reject(err),
    });
  });
}

/** Load every sheet's value grid via the streaming reader (bounded by content size). */
export async function xlsxGrids(path: string): Promise<{ slug: string; grid: unknown[][] }[]> {
  const out: { slug: string; grid: unknown[][] }[] = [];
  const usedSlugs = new Set<string>();
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(path, { entries: "emit", worksheets: "emit" });
  let index = 0;
  for await (const sheet of reader) {
    index++;
    const rawName = (sheet as unknown as { name?: string }).name ?? `sheet_${index}`;
    let slug = slugify(rawName);
    for (let n = 2; usedSlugs.has(slug); n++) slug = `${slugify(rawName)}_${n}`;
    usedSlugs.add(slug);
    const grid: unknown[][] = [];
    for await (const row of sheet as unknown as AsyncIterable<ExcelJS.Row>) {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      grid[row.number - 1] = values.map((v) => (v === undefined ? null : cellValue(v)));
    }
    out.push({ slug, grid });
  }
  return out;
}

/** Detect all islands across all sheets; per-file slug uniqueness. */
function detectXlsx(grids: { slug: string; grid: unknown[][] }[]): { tables: { slug: string; header: string[]; rows: unknown[][] }[]; skipped: string[] } {
  const tables: { slug: string; header: string[]; rows: unknown[][] }[] = [];
  const skipped: string[] = [];
  // One shared set across every sheet so island slugs are unique per file: a
  // sheet-level slug can still collide with an earlier sheet's suffixed island
  // (e.g. "Data" → data,data_2 vs. "Data (2)" → data_2), so dedupe the union.
  const usedSlugs = new Set<string>();
  for (const { slug, grid } of grids) {
    const d = detectIslands(grid, slug, usedSlugs);
    tables.push(...d.tables);
    skipped.push(...d.skipped);
  }
  return { tables, skipped };
}

// --- public API ------------------------------------------------------------

export async function scanTabular(path: string, mime: string, name: string): Promise<TabularScan> {
  if (isCsv(mime, name)) {
    let header: string[] = [];
    const typer = new ColumnTyper();
    const sample: unknown[][] = [];
    let count = 0;
    await streamCsv(path, (h) => { header = h; }, (row) => {
      typer.update(row);
      if (sample.length < SAMPLE) sample.push(row);
      count++;
    });
    if (!header.length || count === 0) return { tables: [], skipped: [] };
    return {
      tables: [{
        slug: slugify(name.replace(/\.[^.]+$/, "")),
        columns: header.map((n, i) => ({ name: n, type: typer.typeAt(i) })),
        rowCount: count,
        sample,
      }],
      skipped: [],
    };
  }
  const { tables, skipped } = detectXlsx(await xlsxGrids(path));
  return { tables: tables.map((t) => tableFromRows(t.slug, t.header, t.rows)), skipped };
}

/** Compact text sample of a scan for the classifier prompt (≤2,000 chars). */
export function scanSample(scan: TabularScan): string {
  const parts = scan.tables.map((t) => {
    const cols = t.columns.map((c) => `${c.name} (${c.type})`).join(", ");
    const rows = t.sample.map((r) => r.map((v) => (v === null || v === undefined ? "" : String(v))).join(" | "));
    return `### ${t.slug} — ${t.rowCount} rows\ncolumns: ${cols}\n${rows.join("\n")}`;
  });
  if (scan.skipped.length) parts.push(`(skipped ${scan.skipped.length} text fragment(s))`);
  return parts.join("\n\n").slice(0, 2000);
}

export async function readTabular(
  path: string,
  mime: string,
  name: string,
  onTable: (table: DetectedTable) => (batch: unknown[][]) => void,
): Promise<void> {
  if (isCsv(mime, name)) {
    // Scan pass first (types/count come from the whole file), then stream batches.
    const scan = await scanTabular(path, mime, name);
    if (!scan.tables.length) return;
    const emit = onTable(scan.tables[0]);
    let batch: unknown[][] = [];
    await streamCsv(path, () => {}, (row) => {
      batch.push(row.map((v) => (typeof v === "string" && v.trim() === "" ? null : v)));
      if (batch.length >= BATCH) { emit(batch); batch = []; }
    });
    if (batch.length) emit(batch);
    return;
  }
  const { tables } = detectXlsx(await xlsxGrids(path));
  for (const t of tables) {
    const emit = onTable(tableFromRows(t.slug, t.header, t.rows));
    for (let i = 0; i < t.rows.length; i += BATCH) emit(t.rows.slice(i, i + BATCH));
  }
}
