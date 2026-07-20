import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../src");
const FORBIDDEN = /^(better-sqlite3|drizzle-orm|node:)/;

function imports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
}

describe("@runoff/core/client purity", () => {
  it("client barrel transitively imports no server-only modules", () => {
    const seen = new Set<string>();
    const queue = [join(SRC, "client.ts")];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of imports(file)) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(FORBIDDEN);
        if (spec.startsWith(".")) queue.push(join(dirname(file), spec.replace(/\.js$/, ".ts")));
      }
    }
    expect(seen.size).toBeGreaterThan(3); // sanity: the walk actually recursed
  });
});
