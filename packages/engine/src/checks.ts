import { parseFigure, type Block, type Span, type Rule, type SqlResult } from "@runoff/core";
import type { CatalogFamily } from "./catalogFormat.js";
import type { RunData } from "./runData.js";

export interface CheckOutcome {
  pass: boolean;
  detail: string;
}

type Agg = "sum" | "avg" | "min" | "max" | "count";

// Left side of the locator grammar: how citation locators reference a source
// column, optionally row-filtered: sum(src.amount where channel=search).
const AGG_REF = /^(sum|avg|min|max|count)\((\w+)\.(\w+)(?:\s+where\s+(\w+)\s*=\s*([^)]+?))?\)$/;

// A digit-bearing numeric figure: optional $, digits/commas, optional decimal, optional %.
// The lookbehind keeps digits embedded in identifiers ("GA4", "Q2") from reading as figures.
const FIGURE = /(?<!\w)\$?\d[\d,]*(?:\.\d+)?%?/;

const AGG_SQL: Record<Agg, string> = { sum: "SUM", avg: "AVG", min: "MIN", max: "MAX", count: "COUNT" };

function q(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

/** Old pack semantics: case-insensitive string compare, plus numeric equality when the value is a number. */
function filterClause(col: string, rawValue: string): string {
  const v = rawValue.trim();
  const esc = v.replace(/'/g, "''");
  const textEq = `lower(CAST(${q(col)} AS TEXT)) = lower('${esc}')`;
  const n = Number(v);
  return v !== "" && Number.isFinite(n) ? `(${q(col)} = ${n} OR ${textEq})` : textEq;
}

/**
 * Compile an aggregate locator to warehouse SQL. Non-count aggregates COALESCE
 * to 0 so an empty match set computes 0 (the old pack semantics), not NULL.
 * Throws when the expression is not locator grammar or the table is unknown.
 */
export function compileLocator(
  expression: string,
  catalog: CatalogFamily[],
): { sql: string; family: CatalogFamily } {
  const ref = AGG_REF.exec(expression.trim());
  if (!ref) throw new Error(`unparseable expression: ${expression}`);
  const [, agg, table, column, filterCol, filterVal] = ref;
  const family = catalog.find((f) => f.tables.some((t) => t.name === table));
  if (!family) throw new Error(`unknown table ${table}`);
  const select = agg === "count" ? `COUNT(${q(column)})` : `COALESCE(${AGG_SQL[agg as Agg]}(${q(column)}), 0)`;
  const where: string[] = [];
  if (family.kind === "periodic") where.push("_period = :period");
  if (filterCol) where.push(filterClause(filterCol, filterVal));
  return { sql: `SELECT ${select} FROM ${q(table)}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`, family };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
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

/** Single numeric cell of a result, or undefined. */
function scalarOf(res: SqlResult): number | undefined {
  const v = res.rows.length === 1 && res.rows[0].length === 1 ? res.rows[0][0] : undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function evaluateAssert(rule: Rule, data: RunData): CheckOutcome {
  if (!rule.sql || !rule.op || rule.value === undefined) {
    return { pass: false, detail: "assert rule is missing sql/op/value" };
  }
  let res: SqlResult;
  try {
    res = data.exec(rule.sql);
  } catch (e) {
    return { pass: false, detail: e instanceof Error ? e.message : String(e) };
  }
  const actual = scalarOf(res);
  if (actual === undefined) return { pass: false, detail: "check query must return one numeric value" };
  const pass = compare(actual, rule.op, rule.value, rule.withinPct);
  const sqlLine = rule.sql.replace(/\s*\n\s*/g, " ").trim();
  const expected = `${rule.op} ${fmt(rule.value)}${rule.withinPct !== undefined ? ` within ${rule.withinPct}%` : ""}`;
  return { pass, detail: `${sqlLine} = ${fmt(actual)} (expected ${expected}) — ${pass ? "pass" : "fail"}` };
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
  data: RunData,
  boundSourceIds: string[],
): { pass: boolean; failures: string[] } {
  const failures: string[] = [];

  for (const span of allSpans(blocks)) {
    const fig = figureIn(span.text);
    if (!fig) {
      // The dialect cites figures; a cited span with no digits renders placeholder
      // text to the reader verbatim (e.g. the literal word "figure"). A quote-style
      // citation legitimately cites a verbatim quote, so it is exempt.
      if (span.citation && !/\d/.test(span.text) && !/^".*"$/s.test(span.text.trim())) {
        failures.push(`cited span has no figure: "${span.text}"`);
      }
      continue;
    }

    if (!span.citation) {
      failures.push(`uncited figure: ${fig}`);
      continue;
    }
    if (!boundSourceIds.includes(span.citation.sourceId)) {
      failures.push(`figure cites unbound source ${span.citation.sourceId}: ${fig}`);
      continue;
    }

    // When the locator itself is an aggregate reference, recompute and cross-check.
    const locator = span.citation.locator.trim();
    const ref = locator.match(AGG_REF);
    if (ref) {
      let compiled: { sql: string; family: CatalogFamily };
      try {
        compiled = compileLocator(locator, data.catalog);
      } catch {
        // Aggregate-shaped but pointing at nothing we can compile — the whole
        // point of an aggregate locator is verifiability, so this is a failure.
        failures.push(`unverifiable locator: ${locator}`);
        continue;
      }
      if (compiled.family.id !== span.citation.sourceId) {
        failures.push(
          `locator source mismatch: cites ${span.citation.sourceId} but locator references ${ref[2]}`,
        );
        continue;
      }
      let computed: number;
      try {
        const v = scalarOf(data.exec(compiled.sql));
        if (v === undefined) throw new Error("non-numeric");
        computed = v;
      } catch {
        failures.push(`unverifiable locator: ${locator}`);
        continue;
      }
      const actual = parseFigure(fig);
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
