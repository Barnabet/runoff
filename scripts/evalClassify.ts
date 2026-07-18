/**
 * Live smoke for classifySource against the local proxy: sample the ga4 fixture
 * and expect a valid proposal (any family/period — the model's call), i.e. a
 * non-null return. Exits 1 on null.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { classifySource } from "@runoff/engine";

const HERE = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const client = new OpenAI({
    baseURL: process.env.OPENAI_BASE_URL ?? "http://localhost:8317/v1",
    apiKey: process.env.OPENAI_API_KEY ?? "",
  });
  const p = await classifySource({
    client,
    filename: "ga4_export_q3.csv",
    contentSample: readFileSync(join(HERE, "fixtures", "ga4_export.csv"), "utf8").slice(0, 2000),
    families: [
      { key: "marketing_spend", label: "Marketing spend", kind: "periodic", granularity: "quarter" },
      { key: "ga4_analytics", label: "GA4 analytics", kind: "periodic", granularity: "quarter" },
      { key: "brand_guidelines", label: "Brand guidelines", kind: "constant", granularity: null },
    ],
  });
  if (!p) {
    console.error("EVAL CLASSIFY FAILED: null proposal");
    process.exit(1);
  }
  console.log(`EVAL CLASSIFY OK: ${p.familyKey} · ${p.period ?? "constant"} · ${p.confidence}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
