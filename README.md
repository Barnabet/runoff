# Runoff

Recurring business reports that write themselves — and prove their numbers.

Runoff turns messy periodic data drops (CSV/XLSX exports, PDFs, reference docs) into polished, narrative reports, on a schedule. Every figure in the output is **cited against a SQL warehouse built from your own files**, checked by deterministic assertions, and diffed against the previous run. An LLM writes the prose; the app verifies the numbers.

## How it works

1. **Sources** — upload files into a project. An agent classifies each file into a *source family* (periodic or constant), and messy tabular files get an LLM-proposed **parse plan** (header anchoring, junk-row exclusion, wide→long unpivot, currency/date coercion) that is reused with **zero LLM calls** once it fits. Clean rows land in a per-project SQLite warehouse (`fam_*` tables with a `_period` column).
2. **Blueprints** — describe the report: sections, tone, structure. A builder **copilot** (streaming tool loop) edits sections with you, runs read-only SQL against the warehouse, inspects previous runs, and bakes `:period`-parameterized queries into each section.
3. **Runs** — pick a period, hit run. The engine executes each section's queries, writes the narrative, cites every figure with a locator that **compiles to SQL and is re-executed by the app**, and runs scalar-SQL assertions. Failures surface as flags, not silent errors.
4. **Memory & goldens** — the system learns. Project- and blueprint-scoped memory distills guidance from steers and chats. **Golden examples** (starred runs or uploaded past reports) are unified into a universal document format, then an agent **binds** every narration-driving value and table to warehouse SQL — verified by re-execution, with per-golden boundness tracking — so future blueprint building stands on data-grounded exemplars.

The through-line: the LLM proposes, the app verifies. Parse plans are executed deterministically; citations and assertions re-run as SQL; golden bindings are re-executed and stamped `bound`/`mismatch` by the app, never trusted from the model.

## Layout

```
packages/core     # SQLite (app DB + per-project warehouses), zod types, reducers
packages/engine   # LLM orchestration: run pipeline, copilot, classify, parse plans, unify/bind
apps/web          # Next.js 15 UI — Library, Builder (+copilot rail), Live Run, Reader, Sources
apps/worker       # run executor
scripts/          # seed + live eval harnesses
docs/superpowers/ # design specs and implementation plans (v1 → v1.5)
```

## Getting started

Requires Node 20+, pnpm, and an OpenAI-compatible endpoint for inference.

```bash
pnpm install
cp .env.example .env        # point OPENAI_BASE_URL / OPENAI_API_KEY / RUNOFF_MODEL at your endpoint
pnpm seed                   # demo project ("Meridian Retail") with seeded families, blueprint, bound golden
pnpm dev                    # web on :3000 + worker
```

By default `.env.example` targets a local [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) proxy; any OpenAI-compatible API works.

Schema changes are breaking by design (no migrations yet): `rm -f data/runoff.db* && rm -rf data/warehouses && pnpm seed`.

## Tests & evals

```bash
pnpm test           # full suite (fast, no LLM — 484 tests)
pnpm eval           # live end-to-end run: generate + verify a full report
pnpm eval:copilot   # copilot produces a real section edit
pnpm eval:classify  # source classification on a fresh file
pnpm eval:sql       # copilot SQL against the warehouse (exact-sum assertion)
pnpm eval:parse     # parse-plan proposal + execution on a messy XLSX
pnpm eval:golden    # unify a report + bind its figures to the warehouse
```

The unit/integration suite mocks only the LLM entry points — verification paths execute real SQL against real warehouses. The `eval:*` scripts are live smoke tests against your configured model.

## Design docs

Each milestone shipped with a spec and an implementation plan under `docs/superpowers/` — from v1 (core run pipeline) through v1.5 (golden unify + bind). Start with `docs/superpowers/specs/2026-07-18-runoff-v1-design.md`.
