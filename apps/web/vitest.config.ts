import { defineConfig } from "vitest/config";

// The web package mixes Node API-route tests (default `node` env) with React
// component tests. esbuild's automatic JSX runtime lets `.tsx` tests transform
// without importing React; component test files opt into jsdom per file via a
// `// @vitest-environment jsdom` pragma so the Node tests stay on `node`.
export default defineConfig({
  esbuild: { jsx: "automatic" },
});
