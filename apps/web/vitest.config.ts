import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The web package mixes Node API-route tests (default `node` env) with React
// component tests. esbuild's automatic JSX runtime lets `.tsx` tests transform
// without importing React; component test files opt into jsdom per file via a
// `// @vitest-environment jsdom` pragma so the Node tests stay on `node`.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  // Machine-load headroom: jsdom component tests time out under parallel churn,
  // so give each test a generous ceiling and cap concurrency to 4 workers.
  test: {
    testTimeout: 30000,
    maxWorkers: 4,
  },
  resolve: {
    // Mirror the `@/*` path alias from tsconfig so components can use it.
    alias: [{ find: /^@\//, replacement: fileURLToPath(new URL("./", import.meta.url)) }],
  },
});
