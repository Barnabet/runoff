import { openDb, type RunoffDb } from "@runoff/core";

// Cache the connection on globalThis so Next.js dev hot-reload does not open a
// new SQLite handle on every module reload.
const globalForDb = globalThis as unknown as { __runoffDb?: RunoffDb };

export function getDb(): RunoffDb {
  if (!globalForDb.__runoffDb) {
    globalForDb.__runoffDb = openDb(process.env.RUNOFF_DB ?? "data/runoff.db");
  }
  return globalForDb.__runoffDb;
}
