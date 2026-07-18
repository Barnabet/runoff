import { describe, it, expect, vi, afterEach } from "vitest";
import { makeLlmClient } from "../src/llm.js";

describe("makeLlmClient", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to the local CLIProxyAPI endpoint when env is unset", () => {
    vi.stubEnv("OPENAI_BASE_URL", undefined);
    vi.stubEnv("OPENAI_API_KEY", undefined);
    expect(makeLlmClient().baseURL).toContain("localhost:8317");
  });

  it("reflects OPENAI_BASE_URL when overridden", () => {
    vi.stubEnv("OPENAI_BASE_URL", "http://example.test:9000/v1");
    expect(makeLlmClient().baseURL).toBe("http://example.test:9000/v1");
  });
});
