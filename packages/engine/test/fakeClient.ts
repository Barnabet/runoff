export interface FakeTurn {
  text?: string; // streamed as one content delta per word
  toolUse?: { name: string; input: unknown };
  stopReason?: "end_turn" | "tool_use" | "max_tokens" | "refusal";
}

/**
 * A stand-in for the `openai` client, compatible enough for draft.ts and
 * notesAgent.ts. `chat.completions.create` branches on `params.stream`:
 *
 *  - streaming (draft.ts): returns an async-iterable of chat-completion chunks
 *    built from the FakeTurn parts — text becomes word-split `delta.content`
 *    chunks; a `toolUse` becomes several `delta.tool_calls` chunks (its
 *    `arguments` string is split across fragments, with `id` + `function.name`
 *    present ONLY on the first fragment — exactly as OpenAI streams them) plus a
 *    final `finish_reason: "tool_calls"`; a `refusal` stop becomes
 *    `delta.refusal`; otherwise the final `finish_reason` is `"stop"`.
 *  - non-streaming (notesAgent.ts): returns `{ choices: [{ message }] }` with
 *    the concatenated text as `content` (and `refusal` when the turn refused).
 */
export function makeFakeClient(script: FakeTurn[][]): any {
  let call = 0;
  const create = async (params: any) => {
    const turns = script[Math.min(call++, script.length - 1)];
    return params?.stream ? streamResponse(turns) : blockingResponse(turns);
  };
  return { chat: { completions: { create } } };
}

function streamResponse(turns: FakeTurn[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      let toolIndex = 0;
      let finish: "stop" | "tool_calls" = "stop";
      let refused = false;

      for (const t of turns) {
        if (t.text) {
          for (const w of t.text.split(/(?<= )/)) {
            yield { choices: [{ delta: { content: w }, finish_reason: null }] };
          }
        }
        if (t.toolUse) {
          const idx = toolIndex++;
          const fragments = chunkString(JSON.stringify(t.toolUse.input));
          // First fragment carries id + name; later fragments carry only more
          // argument text keyed by the same index — the OpenAI streaming shape.
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: idx,
                      id: `call_${idx}`,
                      type: "function",
                      function: { name: t.toolUse.name, arguments: fragments[0] },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          };
          for (let i = 1; i < fragments.length; i++) {
            yield {
              choices: [{ delta: { tool_calls: [{ index: idx, function: { arguments: fragments[i] } }] }, finish_reason: null }],
            };
          }
          finish = "tool_calls";
        }
        if (t.stopReason === "refusal") {
          yield { choices: [{ delta: { refusal: "The model refused." }, finish_reason: null }] };
          refused = true;
        }
      }

      yield { choices: [{ delta: {}, finish_reason: refused ? "stop" : finish }] };
    },
  };
}

/** Split a string into fixed-size fragments (at least one) to exercise accumulation. */
function chunkString(s: string, size = 8): string[] {
  if (s.length <= size) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

function blockingResponse(turns: FakeTurn[]): any {
  const content = turns.filter((t) => t.text).map((t) => t.text).join("");
  const refused = turns.some((t) => t.stopReason === "refusal");
  return {
    choices: [
      {
        message: {
          content: content || null,
          refusal: refused ? "The model refused." : null,
        },
      },
    ],
  };
}
