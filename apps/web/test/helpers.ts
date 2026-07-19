import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Point env at a brand-new temp SQLite DB + files dir and clear the connection
 * `getDb()` memoises on globalThis, so each test opens its own database. Call
 * from a `beforeEach`.
 */
export function freshDb(): void {
  const dir = mkdtempSync(join(tmpdir(), "runoff-web-"));
  process.env.RUNOFF_DB = join(dir, "runoff.db");
  process.env.RUNOFF_FILES_DIR = join(dir, "files");
  process.env.RUNOFF_WAREHOUSE_DIR = join(dir, "warehouses");
  (globalThis as unknown as { __runoffDb?: unknown }).__runoffDb = undefined;
}

export function jsonReq(body: unknown, method = "POST"): Request {
  return new Request("http://x", { method, body: JSON.stringify(body) });
}

export const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
