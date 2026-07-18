import type Anthropic from "@anthropic-ai/sdk";
import type { BlueprintContent, BlueprintSection } from "@runoff/core";
import { MODEL } from "./prompts.js";

export interface ProposedEdit {
  field: "instruction" | "fixedText";
  edits: { find: string; replace: string }[];
}
export interface NoteTurn {
  author: "user" | "agent";
  body: string;
}
export interface MarginReply {
  reply: string;
  proposedEdit?: ProposedEdit;
}

const FALLBACK: MarginReply = { reply: "I couldn't process that note — try rephrasing." };

const SYSTEM_PROMPT =
  "You are the margin-notes agent for a report blueprint. Reply concisely in the voice of a " +
  "careful editor. When the user asks for a change to how a section is written — or its instruction " +
  "conflicts with its rules — propose a concrete edit (find/replace on the section's instruction or " +
  "fixedText) rather than describing one.";

/**
 * Structured-output schema for the reply. Every object sets
 * `additionalProperties: false` with a full `required` array (structured
 * outputs require both); `proposedEdit` is nullable via `type: ["object","null"]`.
 */
const REPLY_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    proposedEdit: {
      type: ["object", "null"],
      properties: {
        field: { type: "string", enum: ["instruction", "fixedText"] },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              find: { type: "string" },
              replace: { type: "string" },
            },
            required: ["find", "replace"],
            additionalProperties: false,
          },
        },
      },
      required: ["field", "edits"],
      additionalProperties: false,
    },
  },
  required: ["reply", "proposedEdit"],
  additionalProperties: false,
} as const;

/**
 * Ask the margin-notes agent to respond to a note thread on one section,
 * optionally proposing a concrete find/replace edit. Uses structured outputs;
 * on refusal or a JSON parse failure returns a graceful fallback (never throws).
 */
export async function marginReply(opts: {
  client: Anthropic;
  content: BlueprintContent;
  sectionKey: string;
  thread: NoteTurn[];
}): Promise<MarginReply> {
  const { client, content, sectionKey, thread } = opts;
  const section = content.sections.find((s) => s.key === sectionKey);

  const transcript = thread.map((t) => `${t.author === "user" ? "User" : "Agent"}: ${t.body}`).join("\n");
  const userTurn =
    `Section (JSON):\n${JSON.stringify(section, null, 2)}\n\n` +
    `Note thread (oldest first):\n${transcript || "(empty)"}`;

  const msg = await (client as any).messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: REPLY_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userTurn }],
  });

  if (msg.stop_reason === "refusal") return { ...FALLBACK };

  const textBlock = msg.content.find((b: any) => b.type === "text");
  try {
    const parsed = JSON.parse(textBlock?.text ?? "");
    const reply: MarginReply = { reply: parsed.reply };
    if (parsed.proposedEdit) reply.proposedEdit = parsed.proposedEdit;
    return reply;
  } catch {
    return { ...FALLBACK };
  }
}

/**
 * Apply a proposed edit to a section. Pure: returns a new section, never mutates
 * the input. For each find/replace pair, asserts the current field value contains
 * `find` (throws a clear error naming the missing text otherwise), then replaces
 * the FIRST occurrence only.
 */
export function applyEdit(section: BlueprintSection, edit: ProposedEdit): BlueprintSection {
  let value = section[edit.field];
  for (const { find, replace } of edit.edits) {
    if (!value?.includes(find)) {
      throw new Error(
        `applyEdit: cannot apply edit to section "${section.key}" — ${edit.field} does not contain ${JSON.stringify(find)}`,
      );
    }
    // function replacer replaces the first occurrence and skips $-pattern interpretation
    value = value.replace(find, () => replace);
  }
  return { ...section, [edit.field]: value };
}
