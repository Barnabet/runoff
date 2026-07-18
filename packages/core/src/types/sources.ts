import { z } from "zod";

export type FamilyKind = "periodic" | "constant";
export type Granularity = "quarter" | "month" | "year";

/** Canonical period formats. Lexicographic order is chronological within one granularity. */
export const PERIOD_REGEX: Record<Granularity, RegExp> = {
  quarter: /^\d{4}-Q[1-4]$/,
  month: /^\d{4}-(0[1-9]|1[0-2])$/,
  year: /^\d{4}$/,
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Display form of a canonical period; unknown shapes pass through untouched. */
export function formatPeriod(period: string): string {
  if (PERIOD_REGEX.quarter.test(period)) return `${period.slice(5)} ${period.slice(0, 4)}`;
  if (PERIOD_REGEX.month.test(period)) return `${MONTHS[Number(period.slice(5)) - 1]} ${period.slice(0, 4)}`;
  return period;
}

/** What the classifier proposes for one uploaded file (validated further in engine/classify). */
export const ClassifyProposalSchema = z.object({
  familyKey: z.string(),
  newFamily: z
    .object({
      key: z.string(),
      label: z.string(),
      kind: z.enum(["periodic", "constant"]),
      granularity: z.enum(["quarter", "month", "year"]).nullable(),
    })
    .optional(),
  period: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
});
export type ClassifyProposal = z.infer<typeof ClassifyProposalSchema>;

export interface SourceFamilyRow {
  id: string;
  projectId: string;
  key: string;
  label: string;
  kind: FamilyKind;
  granularity: Granularity | null;
  createdAt: string;
}

export interface ProjectSourceRow {
  id: string;
  projectId: string;
  familyId: string | null;
  period: string | null;
  name: string;
  kind: string;
  storedFilename: string;
  mime: string;
  size: number;
  status: "unfiled" | "filed" | "replaced";
  proposal: ClassifyProposal | null;
  uploadedAt: string;
  filedAt: string | null;
}
