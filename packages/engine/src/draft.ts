import type OpenAI from "openai";
import type { Block, BlueprintContent, BlueprintSection, DocSection } from "@runoff/core";
import { parseSectionText } from "./dialect.js";
import type { SourcePack } from "./sourcePack.js";
import { MODEL, systemPrompt, sectionUserPrompt } from "./prompts.js";

const tools = [
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user a blocking-with-fallback question when the sources are genuinely ambiguous. Continue drafting using the fallback unless an answer arrives.",
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
  pack: SourcePack;
  completed: DocSection[];
  steers: string[];
  answers: { question: string; answer: string }[];
  retryFeedback?: string;
  cb: DraftCallbacks;
}): Promise<DraftResult> {
  const { client, cb } = opts;
  const messages: any[] = [
    { role: "system", content: systemPrompt(opts.content) },
    { role: "user", content: sectionUserPrompt(opts) },
  ];
  let raw = "";

  for (let iter = 0; iter < 6; iter++) {
    const stream = await (client as any).chat.completions.create({
      model: MODEL,
      stream: true,
      messages,
      tools,
      max_completion_tokens: 16000,
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

    if (refusalText) throw new Error("model refused to draft this section");

    if (finishReason === "tool_calls") {
      const results: any[] = [];
      for (const call of toolCalls) {
        if (!call?.name) continue;
        const parsed = JSON.parse(call.arguments || "{}");
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

    break;
  }

  return { raw, blocks: parseSectionText(raw) };
}
