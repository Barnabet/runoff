/**
 * Cross-implementation route-pair diff harness. Enumerates seeded ids from
 * data/runoff.db, then for each R1 GET route fetches the TS handler
 * (http://localhost:3000/api, override TS_BASE) and the Python handler
 * (http://localhost:8400/api/v1, override PY_BASE), parses both bodies, deep
 * key-sorts, and diffs. Prints one line per pair (OK / DIFF) and exits 1 on any
 * divergence. Write endpoints and SSE (/runs/:id/events) are out of scope (R1).
 *
 * Source coverage (R2): the per-project `GET /projects/:id/sources` (and the
 * `/projects/:id` payload) pairs diff the full source-manager state — families,
 * filed entries, unfiled rows + their LLM classify proposals, and the
 * warehouse-backed `tables[].rowCount`. Run this harness AFTER a live ingestion
 * smoke (upload → classify → confirm) and every post-ingestion source row is
 * re-enumerated from the DB, so the seeded project's mutated source state is
 * diffed TS↔PY on the next run. The intro line reports the source count so that
 * coverage is visible.
 *
 * Both stacks must be up: `pnpm dev` (web :3000 + worker) and `pnpm backend:dev`.
 * Run: pnpm backend:diff
 */
import { openDb } from "@runoff/core";

const TS_BASE = process.env.TS_BASE ?? "http://localhost:3000/api";
const PY_BASE = process.env.PY_BASE ?? "http://localhost:8400/api/v1";

/** Recursively sort object keys; arrays keep their order (ordered data). */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

interface DiffEntry {
  path: string;
  ts: unknown;
  py: unknown;
}

const EPS_REL = 1e-9;

function numsClose(a: number, b: number): boolean {
  if (a === b) return true;
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= EPS_REL * scale;
}

/** Structural deep diff of two already key-sorted JSON values. */
function deepDiff(a: unknown, b: unknown, path: string, out: DiffEntry[], epsHits: string[]): void {
  if (a === b) return;
  if (typeof a === "number" && typeof b === "number") {
    if (a !== b && numsClose(a, b)) {
      epsHits.push(`${path} (ts=${a} py=${b})`);
      return;
    }
    if (!numsClose(a, b)) out.push({ path, ts: a, py: b });
    return;
  }
  const aObj = a && typeof a === "object";
  const bObj = b && typeof b === "object";
  if (!aObj || !bObj) {
    out.push({ path, ts: a, py: b });
    return;
  }
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) {
    out.push({ path, ts: a, py: b });
    return;
  }
  if (aArr && bArr) {
    if (a.length !== b.length) {
      out.push({ path: `${path}.length`, ts: a.length, py: b.length });
      return;
    }
    for (let i = 0; i < a.length; i++) deepDiff(a[i], b[i], `${path}[${i}]`, out, epsHits);
    return;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of [...keys].sort()) {
    if (!(k in ao)) out.push({ path: `${path}.${k}`, ts: undefined, py: bo[k] });
    else if (!(k in bo)) out.push({ path: `${path}.${k}`, ts: ao[k], py: undefined });
    else deepDiff(ao[k], bo[k], `${path}.${k}`, out, epsHits);
  }
}

async function fetchBody(base: string, suffix: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(base + suffix, { headers: { accept: "application/json" } });
  let body: unknown;
  const text = await res.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = { __nonJson: text.slice(0, 500) };
  }
  return { status: res.status, body };
}

function fmt(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? "<absent>" : s.length > 200 ? s.slice(0, 200) + "…" : s;
}

async function comparePair(label: string, suffix: string): Promise<boolean> {
  let ts: { status: number; body: unknown };
  let py: { status: number; body: unknown };
  try {
    [ts, py] = await Promise.all([fetchBody(TS_BASE, suffix), fetchBody(PY_BASE, suffix)]);
  } catch (e) {
    console.log(`ERR  ${label} — fetch failed: ${(e as Error).message}`);
    return false;
  }
  const out: DiffEntry[] = [];
  const epsHits: string[] = [];
  if (ts.status !== py.status) {
    out.push({ path: "<status>", ts: ts.status, py: py.status });
  }
  deepDiff(sortKeys(ts.body), sortKeys(py.body), "$", out, epsHits);
  if (out.length === 0) {
    const eps = epsHits.length ? `  [float-eps: ${epsHits.join(", ")}]` : "";
    console.log(`OK   ${label}${eps}`);
    return true;
  }
  console.log(`DIFF ${label} — ${out.length} difference(s):`);
  for (const d of out.slice(0, 25)) {
    console.log(`       ${d.path}\n         TS: ${fmt(d.ts)}\n         PY: ${fmt(d.py)}`);
  }
  if (out.length > 25) console.log(`       … ${out.length - 25} more`);
  return false;
}

async function main(): Promise<void> {
  const dbPath = process.env.RUNOFF_DB ?? "data/runoff.db";
  const db = openDb(dbPath);
  const projects = (db.sqlite.prepare("SELECT id FROM projects ORDER BY id").all() as { id: string }[]).map(
    (r) => r.id,
  );
  const blueprints = (db.sqlite.prepare("SELECT id FROM blueprints ORDER BY id").all() as { id: string }[]).map(
    (r) => r.id,
  );
  const runs = (db.sqlite.prepare("SELECT id FROM runs ORDER BY id").all() as { id: string }[]).map((r) => r.id);
  // Post-ingestion source coverage: count source rows per project so the intro
  // line makes the diffed source state visible (the rows themselves surface
  // through each project's `/sources` pair below).
  const sourceRows = db.sqlite
    .prepare("SELECT project_id AS projectId FROM sources")
    .all() as { projectId: string }[];
  const sourcesByProject = new Map<string, number>();
  for (const s of sourceRows) sourcesByProject.set(s.projectId, (sourcesByProject.get(s.projectId) ?? 0) + 1);
  db.sqlite.close();

  const pairs: { label: string; suffix: string }[] = [];
  pairs.push({ label: "GET /projects", suffix: "/projects" });
  for (const p of projects) {
    const n = sourcesByProject.get(p) ?? 0;
    pairs.push({ label: `GET /projects/${p}`, suffix: `/projects/${p}` });
    pairs.push({ label: `GET /projects/${p}/sources (${n} source${n === 1 ? "" : "s"})`, suffix: `/projects/${p}/sources` });
    pairs.push({ label: `GET /blueprints?projectId=${p}`, suffix: `/blueprints?projectId=${p}` });
  }
  for (const b of blueprints) {
    pairs.push({ label: `GET /blueprints/${b}`, suffix: `/blueprints/${b}` });
    pairs.push({ label: `GET /blueprints/${b}/run-options`, suffix: `/blueprints/${b}/run-options` });
    pairs.push({ label: `GET /blueprints/${b}/memories`, suffix: `/blueprints/${b}/memories` });
    pairs.push({ label: `GET /blueprints/${b}/copilot`, suffix: `/blueprints/${b}/copilot` });
    pairs.push({ label: `GET /blueprints/${b}/goldens`, suffix: `/blueprints/${b}/goldens` });
  }
  for (const r of runs) {
    pairs.push({ label: `GET /runs/${r}`, suffix: `/runs/${r}` });
  }

  console.log(
    `Diffing ${pairs.length} route pairs across ${projects.length} project(s), ` +
      `${sourceRows.length} source(s)  (TS=${TS_BASE}  PY=${PY_BASE})\n`,
  );
  let anyDiff = false;
  for (const { label, suffix } of pairs) {
    const ok = await comparePair(label, suffix);
    if (!ok) anyDiff = true;
  }
  console.log(anyDiff ? "\nRESULT: diffs found" : "\nRESULT: zero diffs");
  process.exit(anyDiff ? 1 : 0);
}

main();
