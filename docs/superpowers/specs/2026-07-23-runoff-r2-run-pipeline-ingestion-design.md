# Runoff R2 — Run Pipeline, Ingestion, SSE (Python port) — Design

**Date:** 2026-07-23
**Phase:** R2 of the rewrite program (R1 shipped at `1fa5750`; see
`docs/superpowers/specs/2026-07-23-runoff-r1-api-contract-python-core-design.md`)
**Contract:** `docs/api/v1.md` (frozen in R1; R2 implements its R2-tagged surface)

## 1. Goal

Port the run pipeline (worker + LLM engine), sources/warehouse ingestion
(multipart upload, classify/parse-plan LLM stages, warehouse build), and the
run-events SSE endpoint from TypeScript to the Python backend. After
verification passes, **the Python worker becomes the default run executor**;
the TS worker stays runnable as a fallback until R4 deletes it.

One branch (`r2`), one plan, subagent-driven execution per
[[sdd-model-split-preference]] (Opus 4.8 implements, Fable reviews).

## 2. Decisions (fixed)

- **Executor cutover:** Python worker takes over once R2's three verification
  layers pass. TS worker remains available via a dedicated script until R4.
  Only one worker runs at a time in normal operation (the claim SQL is atomic,
  so accidental overlap cannot double-claim, but assignment would be
  nondeterministic — not an operating mode).
- **LLM parity bar:** prompts and request construction are byte-ported.
  Verified by **prompt-payload fixtures** (deterministic: canned inputs →
  byte-identical request bodies across stacks) plus **live evals** (Python
  twins of `eval:classify` / `eval:parse` + live smoke runs).
- **File-parsing parity bar:** CSV/XLSX → **byte-identical warehouse tables**
  from identical input files (hard bar, fixture-verified). PDF text extraction
  (pypdf replacing pdf-parse) is a **documented near-parity divergence** — it
  feeds only prompt text and `source_read` event summaries, never the
  warehouse. Documented in `docs/api/v1.md` §4.
- **R2-first harness chores** fold in as Task 0 (see §10).
- **Porting contract carries over from R1 unchanged:** the TS source file is
  the requirements document; statement-for-statement ports (same SQL strings,
  branch structure, error messages, caps, regexes); TS tests ported
  case-by-case with snake_cased names; on plan-vs-source disagreement, TS
  wins. Plain-dict runtime with camelCase keys; Pydantic validates only where
  zod validates; `to_json()` for all DB/wire JSON; `int | float` for zod
  number fields. DB schema stays frozen.

## 3. Surface

### 3.1 Routes (all specified in `docs/api/v1.md`; R2-tagged there)

| Route | Nature |
|---|---|
| `POST /api/v1/projects/:id/sources` (multipart) | upload + slot logic |
| `PATCH /api/v1/projects/:id/sources/:sourceId` | CRUD |
| `DELETE /api/v1/projects/:id/sources/:sourceId` | CRUD |
| `POST /api/v1/projects/:id/sources/classify` | LLM |
| `POST /api/v1/projects/:id/sources/confirm` | CRUD + warehouse build |
| `POST /api/v1/projects/:id/sources/:sourceId/replan` | LLM |
| `GET /api/v1/runs/:id/events` | SSE |

Error strings, status codes, and SSE framing are already frozen in the
contract — implementations match it exactly. The R1 manifest drift-guard test
(`backend/tests/test_api_manifest.py`) moves these seven from "not mounted"
to required.

### 3.2 Non-route deliverable: the worker

`python -m runoff_api.worker` — a standalone process (mirroring `apps/worker`)
that polls the shared `runoff.db` queue. Not part of the FastAPI app.

## 4. Port map (TS → Python)

New package `backend/runoff_api/engine/` holds the LLM/run side (mirror of
`packages/engine`); `backend/runoff_api/worker/` holds the worker. Existing
R1 modules are extended in place.

| TS source (requirements doc) | Python target | Notes |
|---|---|---|
| `packages/engine/src/llm.ts` | `engine/llm.py` | Python `openai` SDK; same env vars (`OPENAI_BASE_URL` default `http://localhost:8317/v1`, `OPENAI_API_KEY` default `"local"`) |
| `packages/engine/src/prompts.ts` | `engine/prompts.py` | `MODEL` = `RUNOFF_MODEL` env default `"gpt-5.6-sol"`; `system_prompt`, `section_user_prompt`, `guidance_blocks` byte-ported |
| `packages/engine/src/tabular.ts` | `engine/tabular.py` | openpyxl replaces ExcelJS; CSV logic statement-for-statement; grid/scan/sample/executeParsePlan/isDegenerate surface |
| `packages/engine/src/sourcePack.ts` | `engine/source_pack.py` | pypdf replaces pdf-parse (documented divergence); tabular-derived pack text stays exact |
| `packages/engine/src/runData.ts` | `engine/run_data.py` | `section_data_block` + RunData shape |
| `packages/engine/src/catalogFormat.ts` | `engine/catalog_format.py` | small formatter used by run_data/checks (plan confirms whether any of it already landed in R1; no duplication) |
| `packages/engine/src/checks.ts` (rest) | `engine/checks.py` | `evaluate_assert`, `audit_citations`, `count_citations`. `compile_locator` stays in `services/golden_binding.py` (R1); no move, cross-reference only |
| `packages/engine/src/draft.ts` | `engine/draft.py` | streaming draft; `on_delta`/`on_question`/`on_flag` callbacks; `RefusalError` |
| `packages/engine/src/run.ts` | `engine/run.py` | `execute_run` — the 9-rule orchestrator (pause/resume/steer/answer, fallbacks, check-retry-flag, stats) |
| `packages/engine/src/distill.ts` | `engine/distill.py` | post-run memory distillation |
| `packages/engine/src/classify.ts` | `engine/classify.py` | `classify_source` |
| `packages/engine/src/proposePlan.ts` | `engine/propose_plan.py` | `propose_parse_plan` |
| `packages/engine/src/parsePlan.ts` | `engine/parse_plan.py` | plan validation/amendment surface |
| `apps/worker/src/runLoop.ts` | `worker/run_loop.py` | `claim_queued_run` (byte-copied CLAIM_SQL), `make_engine_io`, `fail_stale_runs`, `process_one`, `distill_completed_run`, memory cap 30 |
| `apps/worker/src/resolveSources.ts` | `worker/resolve_sources.py` | |
| `apps/worker/src/runData.ts` | `worker/run_data.py` | `build_run_data` (distinct from `engine/run_data.py`) |
| `apps/worker/src/index.ts` | `worker/__main__.py` | boot recovery → poll loop; 250 ms idle sleep, 1000 ms error backoff |
| `packages/core/src/warehouse.ts` (write side) | `core/warehouse.py` (extend) | warehouse build from parse plans; R1 ported only the read side |
| `apps/web/lib/sourceManager.ts` (rest) | `services/source_manager.py` (extend) | upload/save to FILES_DIR, source rows, slot logic, PATCH/DELETE/confirm/replan flows; R1 ported only `list_project_sources` |
| `apps/web/app/api/projects/[id]/sources/*` (5 routes) | `api/sources.py` (new router) | mounted under projects paths exactly as the contract states |
| `apps/web/app/api/runs/[id]/events/route.ts` | `api/runs.py` (extend) | SSE — see §7 |

New Python dependencies: `openai`, `openpyxl`, `pypdf`, `python-multipart`.

## 5. LLM layer

- The Python `openai` SDK against CLIProxyAPI produces the same wire format as
  the TS `openai` SDK by construction; parity therefore reduces to **payload
  parity**: identical model string, messages, tools/response-format, and
  sampling params for identical inputs.
- **Prompt-payload fixture harness:**
  - `scripts/dump-prompt-fixtures.ts` (TS, additive): feeds canned inputs
    through each LLM stage with a recording fake client (captures every
    `create(...)` argument object instead of calling the network) and writes
    `backend/tests/fixtures/prompts/<stage>.json`.
  - Stages covered: `draftSection` (first draft **and** retry-with-feedback
    variant), `classifySource`, `proposeParsePlan` (initial **and** the
    replan/amend-with-feedback variant, wherever that call lives in
    `proposePlan.ts`/`parsePlan.ts` — the plan confirms from source),
    `distillRun`. (Copilot/golden stages are R3.)
  - `backend/tests/test_prompt_fixtures.py` replays the same canned inputs
    through the Python ports with a recording fake client and asserts
    byte-identical payloads (deep-key-sorted compare, R1 style).
  - Streaming: the fixture captures the request only; response handling is
    covered by ported unit tests with scripted fake streams.

## 6. File parsing and ingestion

- `engine/tabular.py` port bar: for every file in `scripts/fixtures/`
  (`ga4_export.csv`, `spend_june.csv`, `ar_aging_q2_2026.xlsx`,
  `regional_summary.xlsx`), TS and Python ingestion must produce
  **byte-identical warehouse tables**.
- **Ingest-diff fixture harness:**
  - `scripts/dump-ingest-fixtures.ts` (TS, additive): loads each fixture file,
    runs the real TS parse (grids → scan → executeParsePlan with a canned,
    committed ParsePlan per file — no LLM involved) and the warehouse build
    into a temp DB, then dumps the resulting tables (schema + all rows) to
    `backend/tests/fixtures/ingest/<file>.json`.
  - `backend/tests/test_ingest_parity.py` runs the same canned plans through
    the Python port into a temp warehouse and compares dumps exactly
    (R1 comparison rules: `pytest.approx` not needed here — byte bar).
- `services/source_manager.py` gains the upload path: multipart save under
  `FILES_DIR`, source-row creation, slot/family logic, confirm → warehouse
  build, replan → re-parse; PATCH/DELETE per contract.
- PDF: `source_pack.py` extracts text via pypdf. Divergence note added to
  `docs/api/v1.md` §4: `source_read.summary` and prompt text for PDF sources
  may differ in whitespace/ordering from the TS backend; tabular sources
  remain exact.

## 7. Run engine, worker, SSE

- **All sync Python.** A dedicated worker process needs no event loop: the
  openai sync streaming iterator replaces the TS async stream, `io.sleep` is
  `time.sleep`, FastAPI SSE uses a sync generator. No asyncio in R2 code.
- `make_engine_io.emit` wraps the event insert + status mirror in a
  **`BEGIN IMMEDIATE`** transaction (the TS `emitTx.immediate` — takes the
  write lock up front so MAX(seq)+insert see one snapshot; avoids
  SQLITE_BUSY_SNAPSHOT under concurrent web writes). Flag rows are namespaced
  `{runId}_{flagId}` exactly as TS.
- Worker main loop: `fail_stale_runs` on boot (any `running`/`paused` run →
  `run_failed` "worker restarted mid-run"), then poll: `process_one` else
  sleep 250 ms; escaping errors logged + 1000 ms backoff, loop never dies.
- The worker opens its own DB connection via R1's `open_db` (WAL,
  busy_timeout 5000) and its own LLM client. Env: `RUNOFF_DB`, `FILES_DIR`,
  `WAREHOUSE_DIR`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `RUNOFF_MODEL`.
- **SSE `GET /runs/:id/events`** per contract §3.1: full backlog replay from
  `last = 0` on connect (no query params), then poll every 200 ms;
  `data: <payload>\n\n` frames; heartbeat comment `: ping\n\n` every 75th loop
  iteration; stream closes after a batch containing
  `run_completed`/`run_failed` (no close frame); unknown run id → open stream
  with heartbeats (documented behavior). Client disconnect ends the generator.

## 8. Verification (three layers, gate for cutover)

1. **Ported pytest suites** — every ported file's TS tests, case-by-case:
   engine (tabular, sourcePack, runData, checks, draft, run, distill,
   classify, proposePlan, parsePlan, prompts), worker (runLoop incl. claim /
   engineIO / stale-recovery / distillation / memory cap), sourceManager,
   warehouse write side, SSE route (TestClient with a short-poll patch),
   multipart routes.
2. **Deterministic cross-impl fixtures** — prompt payloads (§5), ingest
   parity (§6), R1's four fixture suites stay green, and `scripts/diff-api.ts`
   extended: after a scripted Python-side ingestion (upload → confirm) run
   against both backends' source GETs, zero diffs.
3. **Live** — in order:
   - Full ingestion through the Python API on the real fixture files:
     multipart upload → classify → confirm → warehouse built; verified via
     existing GET endpoints and warehouse queries.
   - `pnpm backend:eval:classify` and `pnpm backend:eval:parse` — Python
     twins of the TS eval scripts (same fixtures, same assertions, live
     CLIProxyAPI) under `backend/evals/`.
   - ≥3 smoke runs enqueued via the Python API and **executed to `complete`
     by the Python worker**, at least one exercising a live input
     (steer or pause/resume) and one raising a flag; SSE endpoint tailed
     live during one run to verify framing.
   - TS suite still green (`pnpm test`); accepted solo-re-run protocol for
     known machine-load jsdom flakes.

**Cutover (last task):** root `pnpm dev` switches the worker component to
`pnpm backend:worker`; the TS worker becomes `pnpm worker:ts`. No TS code is
deleted in R2 (that is R4).

## 9. Scripts and commands

Added to root `package.json`:
- `backend:worker` — `uv run python -m runoff_api.worker` with the R1 env
  wiring (RUNOFF_DB/FILES_DIR/WAREHOUSE_DIR + .env sourcing for LLM vars).
- `backend:eval:classify`, `backend:eval:parse` — live Python evals.
- `backend:prompt-fixtures` — runs `scripts/dump-prompt-fixtures.ts`.
- `backend:ingest-fixtures` — runs `scripts/dump-ingest-fixtures.ts`.
- `worker:ts` — the existing TS worker invocation, kept until R4.
- `dev` — worker side flips to Python at cutover.

## 10. Task 0 — harness chores (from the R1 final review)

1. **`backend:fixtures` null-overwrite guard:** the dump script must refuse to
   overwrite an existing fixture file with null/empty content (the footgun:
   after a reseed the referenced run ids no longer exist and the dump would
   silently blank good fixtures).
2. **Vitest flake chore:** raise `testTimeout` and/or cap workers in the
   `apps/web` vitest config so full-suite runs stop flaking under machine
   load (every observed flake passes solo today).
3. **Canned run in seed:** the seed script bakes one completed run with a
   realistic event log, so all four R1 parity fixtures (and R2's new ones)
   regenerate from a fresh reseed without live smoke runs.

These land first on the `r2` branch; they harden the harness the rest of R2's
verification relies on.

## 11. Documentation updates

- `docs/api/v1.md`: the seven R2 routes' phase notes flip to implemented;
  §4 gains the PDF-extraction near-parity divergence note. No contract
  changes — the contract was frozen in R1.
- Ledger `.superpowers/sdd/progress.md`: new `## R2` section, per-task
  entries as in R1.

## 12. Out of scope (unchanged program boundaries)

- Copilot streaming route, goldens multipart/unify/bind/scaffold (LLM golden
  surface) — **R3**. The multipart goldens POST keeps its 501.
- Deleting any TS code, changing `pnpm test`, or touching the TS worker
  beyond renaming its script — **R4**.
- Angular frontend — **R5+**.
- Schema changes, new features, prompt changes — frozen during the port.

## 13. Success criteria

1. `pnpm backend:test` green (existing 180 + all new suites), `backend:lint`
   clean.
2. Prompt-payload fixtures: byte-identical across stacks for every captured
   stage and variant of §5.
3. Ingest parity: all four fixture files → byte-identical warehouse tables.
4. `pnpm backend:diff` zero diffs including the new source coverage; R1
   parity fixtures still 4/4.
5. Live layer complete: Python-only ingestion on real files; both Python
   evals pass; ≥3 Python-worker-executed runs to `complete` (one with a live
   input, one with a flag); SSE verified live.
6. Cutover done: `pnpm dev` runs the Python worker; `pnpm worker:ts` works.
7. `docs/api/v1.md` updated; the manifest drift-guard grows by exactly the
   seven R2 handlers of §3.1 and still fails on any unspecified route.
8. TS suite green; no TS behavior changes outside additive scripts.
