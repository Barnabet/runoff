import type OpenAI from "openai";
import type { Block, BlueprintContent, BlueprintSection, DocSection } from "@runoff/core";
import { parseSectionText } from "./dialect.js";
import { MODEL, systemPrompt, sectionUserPrompt, type ScopedMemory } from "./prompts.js";

const tools = [
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user a blocking-with-fallback question when the source data or its business framing is genuinely ambiguous. Never ask about report mechanics (the dialect, citation markers, locator grammar) — the user never sees those; resolve them yourself and raise_flag if precision suffers. Continue drafting using the fallback unless an answer arrives.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          fallback: { type: "string" },
          deadlineSection: { type: "string" },
        },
        required: ["question", "options", "fallback", "deadlineSection"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "raise_flag",
      description:
        "Flag a passage that needs the user's judgment before the report can be released. Does not stop drafting.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
        required: ["question", "options"],
        additionalProperties: false,
      },
    },
  },
] as const;

export interface DraftCallbacks {
  onDelta(text: string): void;
  onFlag(f: { question: string; options: string[] }): void;
  onQuestion(q: { question: string; options: string[]; fallback: string; deadlineSection: string }): void;
}

/**
 * Thrown when the model refuses to draft a section. The orchestrator catches
 * this per-section (emitting `section_failed`) so one refusal does not fail the
 * whole run; any other error propagates and fails the run.
 */
export class RefusalError extends Error {
  constructor(message = "model refused to draft this section") {
    super(message);
    this.name = "RefusalError";
  }
}

export interface DraftResult {
  raw: string;
  blocks: Block[];
}

/** An accumulated tool call, assembled from streamed `delta.tool_calls` chunks. */
interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export async function draftSection(opts: {
  client: OpenAI;
  content: BlueprintContent;
  section: BlueprintSection;
  dataBlock: string;
  completed: DocSection[];
  steers: string[];
  answers: { question: string; answer: string }[];
  retryFeedback?: string;
  previousSectionText?: string;
  memories?: ScopedMemory[];
  cb: DraftCallbacks;
}): Promise<DraftResult> {
  const { client, cb } = opts;
  const messages: any[] = [
    { role: "system", content: systemPrompt(opts.content, opts.memories) },
    { role: "user", content: sectionUserPrompt(opts) },
  ];
  let raw = "";
  let maxTokens = 16000;
  let lengthRetried = false;

  for (let iter = 0; iter < 6; iter++) {
    const stream = await (client as any).chat.completions.create({
      model: MODEL,
      stream: true,
      messages,
      tools,
      max_completion_tokens: maxTokens,
    });

    let turnText = "";
    let refusalText = "";
    let finishReason: string | null = null;
    const toolCalls: AccumulatedToolCall[] = [];

    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};

      if (typeof delta.content === "string" && delta.content.length) {
        turnText += delta.content;
        cb.onDelta(delta.content);
      }
      if (typeof delta.refusal === "string" && delta.refusal.length) {
        refusalText += delta.refusal;
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const acc = (toolCalls[idx] ??= { id: "", name: "", arguments: "" });
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.arguments += tc.function.arguments;
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    raw = turnText;

    if (refusalText) throw new RefusalError();

    if (finishReason === "tool_calls") {
      const results: any[] = [];
      for (const call of toolCalls) {
        if (!call?.name) continue;
        // Guard the tool-argument parse: one malformed payload must not throw and
        // sink the whole run. Skip the callback and tell the model to continue.
        let parsed: any;
        try {
          parsed = JSON.parse(call.arguments || "{}");
        } catch {
          results.push({ role: "tool", tool_call_id: call.id, content: "Invalid tool arguments — ignored. Continue drafting." });
          continue;
        }
        let content: string;
        if (call.name === "ask_user") {
          cb.onQuestion(parsed);
          content =
            "The user will answer asynchronously. Proceed now using your stated fallback; an answer may be injected into later sections.";
        } else {
          cb.onFlag(parsed);
          content = "Flag recorded for the user's review. Continue drafting.";
        }
        results.push({ role: "tool", tool_call_id: call.id, content });
      }
      messages.push({
        role: "assistant",
        content: turnText || null,
        tool_calls: toolCalls
          .filter((c) => c?.name)
          .map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
      });
      for (const r of results) messages.push(r);
      continue;
    }

    // The model hit the token ceiling mid-draft. Retry the same turn once with a
    // larger budget; if it truncates again, accept the truncated text and let the
    // orchestrator proceed normally rather than failing the run.
    if (finishReason === "length" && !lengthRetried) {
      lengthRetried = true;
      maxTokens = 32000;
      continue;
    }

    break;
  }

  return { raw, blocks: parseSectionText(raw) };
}
