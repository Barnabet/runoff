import { z } from "zod";

const NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Compile a plan-authored row-rule / unpivot pattern. Matching is always
 * case-insensitive (the "i" flag), so a leading PCRE inline-flag group like
 * `(?i)` — which LLM proposers commonly emit but ECMAScript regex rejects as a
 * syntax error — is redundant and stripped before compilation. Throws (like
 * `new RegExp`) on a genuinely malformed pattern so validateParsePlan still
 * reports it.
 */
export function planPattern(pattern: string): RegExp {
  return new RegExp(pattern.replace(/^\(\?[a-z]+\)/i, ""), "i");
}

export const RowRuleSchema = z.object({
  /** Canonical column name, or null = match against any matched cell in the row. */
  column: z.string().nullable(),
  /** Case-insensitive regex tested against the cell's raw (trimmed) text. */
  pattern: z.string(),
});
export type RowRule = z.infer<typeof RowRuleSchema>;

export const ColumnPlanSchema = z.object({
  /** Normalized merged raw header text this column matches. */
  from: z.string().min(1),
  name: z.string().regex(NAME_RE),
  type: z.enum(["TEXT", "INTEGER", "REAL"]),
  parse: z.enum(["number", "currency", "percent", "date"]).optional(),
});
export type ColumnPlan = z.infer<typeof ColumnPlanSchema>;

export const TablePlanSchema = z.object({
  name: z.string().regex(NAME_RE),
  anchor: z.object({
    /** Slugified sheet-name HINT; breaks ties, never required to match. */
    sheet: z.string().optional(),
    /** Normalized raw texts of the header row's cells. */
    headerSignature: z.array(z.string().min(1)).min(1),
    minMatch: z.number().int().min(1),
  }),
  headerRows: z.number().int().min(1).max(3),
  exclude: z.array(RowRuleSchema),
  columns: z.array(ColumnPlanSchema).min(1),
  unpivot: z
    .object({
      keep: z.array(z.string()),
      /** Case-insensitive regex; matched (unmapped) merged headers melt into rows. */
      valuePattern: z.string(),
      keyColumn: z.string().regex(NAME_RE),
      valueColumn: z.string().regex(NAME_RE),
      valueType: z.enum(["INTEGER", "REAL", "TEXT"]),
      valueParse: z.enum(["number", "currency", "percent"]).optional(),
    })
    .optional(),
  /** Canonical column (parse: "date") validated against the slot period. */
  periodColumn: z.string().optional(),
  onPeriodMismatch: z.enum(["keep", "exclude"]).default("keep"),
});
export type TablePlan = z.infer<typeof TablePlanSchema>;

export const ParsePlanSchema = z.object({
  version: z.literal(1),
  tables: z.array(TablePlanSchema).min(1),
});
export type ParsePlan = z.infer<typeof ParsePlanSchema>;

export const ExecReportSchema = z.object({
  tables: z.array(
    z.object({
      name: z.string(),
      anchor: z.object({ sheet: z.string(), row: z.number() }).nullable(),
      /** Byte-exact problem lines; a table with problems produces no rows. */
      problems: z.array(z.string()),
      rowsKept: z.number(),
      rowsExcluded: z.array(z.object({ pattern: z.string(), count: z.number(), samples: z.array(z.string()) })),
      coercionFailures: z.array(z.object({ column: z.string(), count: z.number(), samples: z.array(z.string()) })),
      periodMismatches: z.object({ count: z.number(), samples: z.array(z.string()) }).nullable(),
      unknownColumns: z.array(z.string()),
    }),
  ),
});
export type ExecReport = z.infer<typeof ExecReportSchema>;

export const PlanPreviewSchema = z.object({
  tables: z.array(
    z.object({
      name: z.string(),
      columns: z.array(z.string()),
      rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
    }),
  ),
});
export type PlanPreview = z.infer<typeof PlanPreviewSchema>;

/**
 * Structural validity beyond zod. Throws Error whose message is the first
 * violated rule; messages are stable and user-visible in tool errors.
 */
export function validateParsePlan(plan: ParsePlan): void {
  const tableNames = new Set<string>();
  for (const t of plan.tables) {
    if (tableNames.has(t.name)) throw new Error(`duplicate table name: ${t.name}`);
    tableNames.add(t.name);
    const canon = new Set<string>();
    const froms = new Set<string>();
    for (const c of t.columns) {
      if (c.name === "_period") throw new Error(`reserved column name: ${t.name}._period`);
      if (canon.has(c.name)) throw new Error(`duplicate column name: ${t.name}.${c.name}`);
      canon.add(c.name);
      const f = c.from.trim().toLowerCase().replace(/\s+/g, " ");
      if (froms.has(f)) throw new Error(`duplicate column from: ${t.name}.${c.from}`);
      froms.add(f);
    }
    const ref = (col: string | null, where: string): void => {
      if (col !== null && !canon.has(col)) throw new Error(`unknown column reference: ${t.name}.${col}`);
      void where;
    };
    for (const r of t.exclude) {
      ref(r.column, "exclude");
      try { planPattern(r.pattern); } catch { throw new Error(`invalid pattern: ${t.name}.${r.pattern}`); }
    }
    if (t.unpivot) {
      for (const k of t.unpivot.keep) ref(k, "keep");
      try { planPattern(t.unpivot.valuePattern); } catch { throw new Error(`invalid pattern: ${t.name}.${t.unpivot.valuePattern}`); }
      if (canon.has(t.unpivot.keyColumn) || canon.has(t.unpivot.valueColumn) || t.unpivot.keyColumn === t.unpivot.valueColumn)
        throw new Error(`unpivot column collides: ${t.name}`);
    }
    if (t.periodColumn !== undefined) {
      ref(t.periodColumn, "periodColumn");
      const c = t.columns.find((x) => x.name === t.periodColumn);
      if (!c || c.parse !== "date") throw new Error(`periodColumn must have parse "date": ${t.name}.${t.periodColumn}`);
    }
  }
}

/** Warehouse table name for one logical table (mirrors tableNamesFor's single-table rule). */
export function planTableName(familyKey: string, plan: ParsePlan, logicalName: string): string {
  return plan.tables.length === 1 ? `fam_${familyKey}` : `fam_${familyKey}__${logicalName}`;
}
