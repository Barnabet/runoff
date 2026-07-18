import { z } from "zod";

export const RuleSchema = z.object({
  kind: z.enum(["assert", "style", "judgment"]),
  text: z.string(),
  expression: z.string().optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

export const BlueprintSectionSchema = z.object({
  key: z.string(),
  number: z.number().int(),
  heading: z.string(),
  mode: z.enum(["fixed", "auto", "review"]),
  instruction: z.string(),
  fixedText: z.string().optional(),
  sourceIds: z.array(z.string()),
  rules: z.array(RuleSchema),
});
export type BlueprintSection = z.infer<typeof BlueprintSectionSchema>;

export const BlueprintContentSchema = z.object({
  title: z.string(),
  clientName: z.string(),
  eyebrow: z.string(),
  dateline: z.string(),
  sections: z.array(BlueprintSectionSchema),
  globalRules: z.array(z.string()),
  delivery: z.object({ recipient: z.string(), autoDeliverOnClear: z.boolean() }),
});
export type BlueprintContent = z.infer<typeof BlueprintContentSchema>;
