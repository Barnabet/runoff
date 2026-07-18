import type { RunDocument } from "@runoff/core";

export interface FakeTurn {
  text?: string;                       // streamed as one text delta per word
  toolUse?: { name: string; input: unknown };
  stopReason?: "end_turn" | "tool_use" | "max_tokens" | "refusal";
}
/** client.messages.stream(...) compatible enough for draft.ts:
 *  emits text events, returns finalMessage() with content blocks + stop_reason. */
export function makeFakeClient(script: FakeTurn[][]): any {
  let call = 0;
  return { messages: { stream: (_params: unknown) => {
    const turns = script[Math.min(call++, script.length - 1)];
    const handlers: Record<string, ((...a: any[]) => void)[]> = {};
    const stream = {
      on(ev: string, fn: (...a: any[]) => void) { (handlers[ev] ??= []).push(fn); return stream; },
      async finalMessage() {
        const content: any[] = [];
        let stop: string = "end_turn";
        for (const t of turns) {
          if (t.text) {
            for (const w of t.text.split(/(?<= )/)) handlers["text"]?.forEach((f) => f(w));
            content.push({ type: "text", text: t.text });
          }
          if (t.toolUse) { content.push({ type: "tool_use", id: `tu_${content.length}`, name: t.toolUse.name, input: t.toolUse.input }); stop = "tool_use"; }
          if (t.stopReason) stop = t.stopReason;
        }
        return { content, stop_reason: stop };
      },
    };
    return stream;
  } } };
}
