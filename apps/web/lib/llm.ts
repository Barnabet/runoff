import { makeLlmClient } from "@runoff/engine";

// Memoised LLM client for server-side routes (e.g. the margin-notes agent).
// `makeLlmClient()` points the OpenAI SDK at the local CLIProxyAPI; caching it
// avoids re-constructing the client on every request. Tests replace this module
// via `vi.mock("../lib/llm", …)`.
let cached: ReturnType<typeof makeLlmClient> | undefined;

export function getLlmClient(): ReturnType<typeof makeLlmClient> {
  if (!cached) cached = makeLlmClient();
  return cached;
}
