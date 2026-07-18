import OpenAI from "openai";

/**
 * Construct the LLM client used across the engine. Inference runs against a
 * locally hosted CLIProxyAPI that speaks the OpenAI-compatible API (serving
 * GPT 5.6 Sol), so the client is just the `openai` SDK pointed at the local
 * proxy. Env overrides keep it configurable without code changes.
 */
export function makeLlmClient(): OpenAI {
  return new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL ?? "http://localhost:8317/v1",
    apiKey: process.env.OPENAI_API_KEY ?? "local",
  });
}
