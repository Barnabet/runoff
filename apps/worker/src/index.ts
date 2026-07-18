import { openDb } from "@runoff/core";
import { makeLlmClient } from "@runoff/engine";
import { failStaleRuns, processOne } from "./runLoop.js";

const db = openDb(process.env.RUNOFF_DB ?? "data/runoff.db");

const recovered = failStaleRuns(db);
if (recovered > 0) console.log(`[worker] recovered ${recovered} stale run(s) on boot`);

const client = makeLlmClient();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

console.log("[worker] polling for queued runs…");
for (;;) {
  try {
    if (!(await processOne(db, client))) await sleep(250);
  } catch (err) {
    // A run's own failure is handled inside processOne; this guards against an
    // escaping error (e.g. a claim/DB fault) so the poll loop never dies.
    console.error("[worker] poll loop error:", err);
    await sleep(1000);
  }
}
