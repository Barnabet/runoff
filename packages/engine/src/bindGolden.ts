import {
  SubmittedInventorySchema, validateInventoryAnchors,
  type BindingInventory, type RunDocument, type SubmittedInventory,
} from "@runoff/core";
import { serializeCatalog, type CatalogFamily } from "./catalogFormat.js";
import { MODEL } from "./prompts.js";

const MAX_BIND_ITERATIONS = 16;

/** Anchor-addressable rendering: the agent copies these coordinates into items. */
export function renderDocForBinding(document: RunDocument): string {
  const lines: string[] = [`title: ${document.title}`];
  for (const s of document.sections) {
    lines.push(`## section: ${s.key} — ${s.heading}`);
    s.blocks.forEach((b, bi) => {
      if (b.type === "paragraph") {
        b.spans.forEach((sp, si) => lines.push(`[b${bi}.s${si}] ${JSON.stringify(sp.text.slice(0, 160))}`));
      } else {
        lines.push(`[b${bi}] table (${b.columns.length} cols × ${b.rows.length} rows): ${b.columns.join(" | ")}`);
        for (const r of b.rows.slice(0, 12)) lines.push(`  ${r.cells.map((c) => c.map((sp) => sp.text).join("")).join(" | ")}`);
        if (b.rows.length > 12) lines.push(`  … ${b.rows.length - 12} more rows`);
      }
    });
  }
  return lines.join("\n");
}

const renderSiblings = (siblings: { period: string | null; inventory: BindingInventory }[]): string =>
  siblings.slice(0, 3).flatMap((s) => {
    const bound = s.inventory.items.filter((i) => i.binding?.status === "bound");
    return bound.length
      ? [`period ${s.period ?? "unknown"}:`, ...bound.map((i) => `  ${i.id}: "${i.raw}" ← ${i.binding!.familyId}: ${i.binding!.sql}`)]
      : [];
  }).join("\n");

const fn = (name: string, description: string, properties: Record<string, unknown>) => ({
  type: "function",
  function: { name, description, strict: false, parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false } },
});

const TOOLS = [
  fn("run_sql", "Run one read-only SQL SELECT against the project's warehouse. :period binds to THIS GOLDEN's period. Results capped at 200 rows.", { sql: { type: "string" } }),
  fn("submit_inventory", "Submit the final binding inventory. Calling this with a valid inventory ends the task.", {
    version: { type: "number" },
    items: { type: "array", items: { type: "object" } },
  }),
];

export async function bindGolden(opts: {
  client: unknown; catalog: CatalogFamily[]; runSql: (sql: string) => string;
  document: RunDocument; period: string | null;
  siblings: { period: string | null; inventory: BindingInventory }[];
  priorInventory?: SubmittedInventory | BindingInventory; feedback?: string;
}): Promise<SubmittedInventory | null> {
  const sys = [
    `You inventory a golden report's data-driven content and bind it to warehouse data.`,
    `Inventory EVERY narration-driving value (figures, counts, amounts, percentages, data-derived dates — not styling numbers) and EVERY table.`,
    `For each item propose {familyId, sql} that reproduces it, or binding: null with a reason.`,
    `Use :period in SQL for periodic tables so bindings transfer across periods. Probe with run_sql BEFORE submitting.`,
    `Item shape: {id (snake_case, stable), kind: "value"|"table", anchor: {sectionKey, blockIndex, spanIndex|null}, raw, parsed, binding, reason}.`,
    `Anchors come from the bracketed coordinates in the document below: [b0.s1] → blockIndex 0, spanIndex 1; [b1] table → blockIndex 1, spanIndex null.`,
    `\nData catalog:\n${serializeCatalog(opts.catalog)}`,
    `\nGolden period: ${opts.period ?? "unknown"}`,
    `\nDocument:\n${renderDocForBinding(opts.document)}`,
  ];
  const sib = renderSiblings(opts.siblings);
  if (sib) sys.push(`\nThese are verified binding patterns from other periods of the same report family. Try these first: the same logical value binds with the same SQL at a different :period. Reuse their item ids for matching items.\n${sib}`);
  if (opts.priorInventory) sys.push(`\nPrior inventory (amend, do not restart — keep existing item ids and bound SQL for items the feedback does not dispute):\n${JSON.stringify(opts.priorInventory)}`);
  if (opts.feedback) sys.push(`\nUser feedback: ${opts.feedback}`);

  const messages: object[] = [
    { role: "system", content: sys.join("\n") },
    { role: "user", content: "Build and submit the binding inventory." },
  ];
  let nudged = false;
  for (let iter = 0; ; iter++) {
    let res: { choices: { finish_reason?: string | null; message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[] };
    try {
      res = await (opts.client as { chat: { completions: { create: (a: unknown) => Promise<typeof res> } } })
        .chat.completions.create({ model: MODEL, messages, tools: TOOLS, max_completion_tokens: 6000 });
    } catch { return null; }
    const choice = res.choices[0];
    const calls = choice?.message?.tool_calls ?? [];
    if (choice?.finish_reason !== "tool_calls" || calls.length === 0) return null; // finished without submitting
    messages.push({ role: "assistant", content: choice.message.content ?? null,
      tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: c.function })) });
    const overBudget = iter >= MAX_BIND_ITERATIONS;
    for (const call of calls) {
      let result: string;
      if (call.function.name === "submit_inventory") {
        try {
          const args: unknown = JSON.parse(call.function.arguments);
          const inv = SubmittedInventorySchema.parse(args);
          validateInventoryAnchors(inv, opts.document);
          return inv; // valid submit ends the loop; remaining tool results are moot
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result = `Tool error: invalid inventory: ${msg.split("\n")[0].slice(0, 300)}`;
        }
      } else if (call.function.name === "run_sql" && !overBudget) {
        try { result = opts.runSql((JSON.parse(call.function.arguments) as { sql: string }).sql); }
        catch (e) { result = `Tool error: sql: ${String((e as Error).message ?? e)}`; }
      } else {
        result = "Tool budget exhausted. Call submit_inventory with your best inventory now.";
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
    if (nudged) return null; // post-nudge round processed submit_inventory; no valid submit arrived
    if (overBudget) nudged = true;
  }
}
