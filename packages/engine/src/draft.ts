import type Anthropic from "@anthropic-ai/sdk";
import type { Block, BlueprintContent, BlueprintSection, DocSection } from "@runoff/core";
import { parseSectionText } from "./dialect.js";
import type { SourcePack } from "./sourcePack.js";
import { MODEL, systemPrompt, sectionUserPrompt } from "./prompts.js";

const askUserTool = { name: "ask_user", description: "Ask the user a blocking-with-fallback question when the sources are genuinely ambiguous. Continue drafting using the fallback unless an answer arrives.", input_schema: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } }, fallback: { type: "string" }, deadlineSection: { type: "string" } }, required: ["question", "options", "fallback", "deadlineSection"], additionalProperties: false }, strict: true } as const;
const raiseFlagTool = { name: "raise_flag", description: "Flag a passage that needs the user's judgment before the report can be released. Does not stop drafting.", input_schema: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" } } }, required: ["question", "options"], additionalProperties: false }, strict: true } as const;

export interface DraftCallbacks {
  onDelta(text: string): void;
  onFlag(f: { question: string; options: string[] }): void;
  onQuestion(q: { question: string; options: string[]; fallback: string; deadlineSection: string }): void;
}

export interface DraftResult {
  raw: string;
  blocks: Block[];
}

export async function draftSection(opts: {
  client: Anthropic;
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
  const messages: any[] = [{ role: "user", content: sectionUserPrompt(opts) }];
  let raw = "";

  for (let iter = 0; iter < 6; iter++) {
    const stream = (client as any).messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: [{ type: "text", text: systemPrompt(opts.content), cache_control: { type: "ephemeral" } }],
      tools: [askUserTool, raiseFlagTool],
      messages,
    });
    stream.on("text", (t: string) => cb.onDelta(t));
    const msg = await stream.finalMessage();
    raw = msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");

    if (msg.stop_reason !== "tool_use") {
      if (msg.stop_reason === "refusal") throw new Error("model refused to draft this section");
      break;
    }

    const results: any[] = [];
    for (const block of msg.content) {
      if (block.type !== "tool_use") continue;
      if (block.name === "ask_user") {
        cb.onQuestion(block.input);
        results.push({ type: "tool_result", tool_use_id: block.id, content: "The user will answer asynchronously. Proceed now using your stated fallback; an answer may be injected into later sections." });
      }
      if (block.name === "raise_flag") {
        cb.onFlag(block.input);
        results.push({ type: "tool_result", tool_use_id: block.id, content: "Flag recorded for the user's review. Continue drafting." });
      }
    }
    messages.push({ role: "assistant", content: msg.content });
    messages.push({ role: "user", content: results });
  }

  return { raw, blocks: parseSectionText(raw) };
}
