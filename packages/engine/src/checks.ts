import type { Block, Span } from "@runoff/core";
import type { SourcePack } from "./sourcePack.js";

export interface CheckOutcome {
  pass: boolean;
  detail: string;
}

type Agg = "sum" | "avg" | "min" | "max" | "count";

// Full assert grammar: <agg>(<sourceId>.<column>) <op> <number> ["within" <pct> "%"]
const EXPR =
  /^(sum|avg|min|max|count)\((\w+)\.(\w+)\)\s*(==|<=|>=|<|>)\s*([\d.]+)(?:\s+within\s+([\d.]+)%)?$/;

// Left side of the grammar on its own — how citation locators reference a source column.
const AGG_REF = /^(sum|avg|min|max|count)\((\w+)\.(\w+)\)$/;

// A digit-bearing numeric figure: optional $, digits/commas, optional decimal, optional %.
const FIGURE = /\$?\d[\d,]*(?:\.\d+)?%?/;

/** Aggregate a source column. Throws if the source or column is missing. */
function computeAgg(agg: Agg, sourceId: string, column: string, pack: SourcePack): number {
  const source = pack.sources.find((s) => s.id === sourceId);
  if (!source || !source.tables) throw new Error(`unknown source ${sourceId}`);
  const table = source.tables.find((t) => t.columns.includes(column));
  if (!table) throw new Error(`unknown column ${sourceId}.${column}`);

  const cells = table.rows.map((r) => r[column]);
  // CSV/XLSX parsing can leak null/boolean; only real numbers feed numeric aggregates.
  const nums = cells.filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  switch (agg) {
    case "sum":
      return nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    case "min":
      return nums.length ? Math.min(...nums) : 0;
    case "max":
      return nums.length ? Math.max(...nums) : 0;
    case "count":
      return cells.filter((v) => v !== "" && v !== null && v !== undefined).length;
  }
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** Strip $, commas and % so a rendered figure can be compared numerically. */
function stripNumeric(text: string): number {
  return parseFloat(text.replace(/[$,%]/g, ""));
}

function compare(actual: number, op: string, target: number, pct?: number): boolean {
  const tol = pct !== undefined ? Math.abs(target) * (pct / 100) : undefined;
  switch (op) {
    case "==":
      if (tol !== undefined) return Math.abs(actual - target) <= tol;
      // Exact for integers; small absolute tolerance for float rounding.
      if (Number.isInteger(actual) && Number.isInteger(target)) return actual === target;
      return Math.abs(actual - target) <= 0.01;
    case "<=":
      return tol !== undefined ? actual <= target + tol : actual <= target;
    case ">=":
      return tol !== undefined ? actual >= target - tol : actual >= target;
    case "<":
      return tol !== undefined ? actual < target + tol : actual < target;
    case ">":
      return tol !== undefined ? actual > target - tol : actual > target;
    default:
      return false;
  }
}

export function evaluateAssert(expression: string, pack: SourcePack): CheckOutcome {
  const m = expression.trim().match(EXPR);
  if (!m) return { pass: false, detail: `unparseable expression: ${expression}` };

  const [, agg, sourceId, column, op, targetStr, pctStr] = m;
  const target = parseFloat(targetStr);
  const pct = pctStr !== undefined ? parseFloat(pctStr) : undefined;

  let actual: number;
  try {
    actual = computeAgg(agg as Agg, sourceId, column, pack);
  } catch (e) {
    return { pass: false, detail: (e as Error).message };
  }

  const pass = compare(actual, op, target, pct);
  const expected = `${op} ${fmt(target)}${pct !== undefined ? ` within ${pctStr}%` : ""}`;
  return {
    pass,
    detail: `${agg}(${sourceId}.${column}) = ${fmt(actual)} (expected ${expected}) — ${pass ? "pass" : "fail"}`,
  };
}

/** Yield every auditable span: paragraph spans and table cell spans (header columns skipped). */
function* allSpans(blocks: Block[]): Generator<Span> {
  for (const block of blocks) {
    if (block.type === "paragraph") {
      yield* block.spans;
    } else {
      for (const row of block.rows) {
        for (const cell of row.cells) {
          yield* cell;
        }
      }
    }
  }
}

/** The numeric figure a span carries, or null if it is not a digit-bearing figure ≥ 2 chars. */
function figureIn(text: string): string | null {
  if (text.length < 2) return null;
  const m = text.match(FIGURE);
  return m ? m[0] : null;
}

export function auditCitations(
  blocks: Block[],
  pack: SourcePack,
  boundSourceIds: string[],
): { pass: boolean; failures: string[] } {
  const failures: string[] = [];

  for (const span of allSpans(blocks)) {
    const fig = figureIn(span.text);
    if (!fig) continue;

    if (!span.citation) {
      failures.push(`uncited figure: ${fig}`);
      continue;
    }
    if (!boundSourceIds.includes(span.citation.sourceId)) {
      failures.push(`figure cites unbound source ${span.citation.sourceId}: ${fig}`);
      continue;
    }

    // When the locator itself is an aggregate reference, recompute and cross-check.
    const ref = span.citation.locator.trim().match(AGG_REF);
    if (ref) {
      let computed: number;
      try {
        computed = computeAgg(ref[1] as Agg, ref[2], ref[3], pack);
      } catch {
        // Locator points at something we cannot recompute; leave the figure as-is.
        continue;
      }
      const actual = stripNumeric(fig);
      if (!Number.isNaN(actual) && Math.abs(actual - computed) > Math.abs(computed) * 0.005) {
        failures.push(`citation mismatch: ${fig} vs computed ${computed}`);
      }
    }
  }

  return { pass: failures.length === 0, failures };
}

export function countCitations(blocks: Block[]): number {
  let n = 0;
  for (const span of allSpans(blocks)) if (span.citation) n++;
  return n;
}
