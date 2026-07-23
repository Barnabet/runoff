# Runoff R1 — API Contract + Python Core (Design)

**Date:** 2026-07-23
**Status:** Approved design, pre-plan
**Program:** Frontend/backend separation & rewrite (Angular / Python), phase R1 of R1–R5

## 1. Context and program

Runoff v1–v1.6 is a working TypeScript monorepo: Next.js 15 web app with server API
routes (`apps/web`), a DB-polling worker (`apps/worker`), and shared packages
(`packages/core`, `packages/engine`), all on a single SQLite database
(`data/runoff.db`) that serves as both store and run queue. 501 tests plus a live
LLM eval battery (`eval:copilot`, `eval:parse`, `eval:golden`, `eval:scaffold`,
`eval:classify`, …) verify it.

The program: fully separate frontend and backend, rewriting the backend in
**Python** and the frontend in **Angular**, driven by (a) an external stack
requirement, (b) Python's ecosystem fit for the LLM/data-heavy backend, and
(c) the goal of a hard, independently deployable API boundary.

Program-level decisions (fixed, apply to every phase):

- **Backend first.** The API contract + Python backend land before any Angular
  work; the existing TS app keeps serving users throughout.
- **Same repo, new dirs.** `backend/` (Python) and later `frontend/` (Angular)
  grow alongside the existing tree; TS pieces are deleted as they are replaced.
- **Behavior + DB compatible.** Same SQLite schema (one seeded `runoff.db`
  works with either backend), same prompts, same API-visible behavior. The
  schema is frozen for the duration of the port; migrations remain backlog.
- **Phases:** R1 contract + Python core (this spec) → R2 run pipeline +
  sources/warehouse ingestion + SSE → R3 copilot + goldens (LLM surface, prompt
  parity) → R4 cutover (Next.js proxies or fetches `/api/v1`; TS backend
  deleted) → R5+ Angular frontend (own brainstorm once the API is stable).

## 2. R1 goal

Two deliverables, verified against the TS implementation:

1. **The v1 contract** — `docs/api/v1.md`, covering the *entire* backend
   surface (including endpoints implemented only in R2/R3).
2. **`backend/`** — a FastAPI application implementing everything that is pure
   SQLite CRUD (no LLM, no file storage, no SSE) against the same `runoff.db`,
   plus a full port of `packages/core` minus warehouse ingestion.

The Python backend runs **dark** in R1: Next.js keeps serving users from its own
TS routes until R4. Nothing user-facing changes in this phase.

## 3. The contract (`docs/api/v1.md`)

### 3.1 Rules

- Base path **`/api/v1`**. Paths are the existing Next.js route paths verbatim,
  just prefixed — e.g. `/api/blueprints/:id/copilot` → `/api/v1/blueprints/:id/copilot`.
  No renaming, no resource remodeling.
- Request/response JSON shapes are the current TS shapes **verbatim**: camelCase
  field names, same nesting, same nullability. The TS route source is the
  authority; the doc is written by reading each route handler.
- Errors: `{"error": "<message>"}` with the status codes the TS routes use
  today (400 invalid body, 404 missing resource, 409 where currently used, 500
  unexpected).
- SSE endpoints (`GET /runs/:id/events`, copilot streaming) are documented in
  R1 with their exact event framing (`data:` lines, event names, terminal
  behavior) even though their Python implementation is R2/R3.
- No auth, no pagination, no rate limiting — single-user local app (YAGNI).
- The doc carries one table per endpoint: method, path, request shape, response
  shape, status codes, and the phase (R1/R2/R3) in which the Python
  implementation lands.

### 3.2 Full surface (23 routes) and phase assignment

| Method(s) | Path (under `/api/v1`) | Python impl |
|---|---|---|
| GET, POST | `/projects` | R1 |
| GET, PATCH | `/projects/:id` | R1 |
| GET | `/projects/:id/sources` | R1 |
| POST | `/projects/:id/sources` (multipart upload) | R2 |
| PATCH, DELETE | `/projects/:id/sources/:sourceId` | R2 |
| POST | `/projects/:id/sources/classify` (LLM) | R2 |
| POST | `/projects/:id/sources/confirm` | R2 |
| POST | `/projects/:id/sources/:sourceId/replan` (LLM) | R2 |
| GET, POST | `/blueprints` | R1 |
| GET, PATCH | `/blueprints/:id` | R1 |
| POST | `/blueprints/:id/revisions` | R1 |
| GET | `/blueprints/:id/run-options` | R1 |
| GET | `/blueprints/:id/memories` | R1 |
| GET | `/blueprints/:id/copilot` (conversation fetch) | R1 |
| POST | `/blueprints/:id/copilot` (LLM, streaming) | R3 |
| GET | `/blueprints/:id/goldens` | R1 |
| POST | `/blueprints/:id/goldens` — JSON variant (star run/section) | R1 |
| POST | `/blueprints/:id/goldens` — multipart variant (exemplar upload → unify+bind) | R3 |
| POST | `/blueprints/:id/goldens/:goldenId/unify` (LLM) | R3 |
| POST | `/blueprints/:id/goldens/:goldenId/bind` (LLM) | R3 |
| PATCH, DELETE | `/goldens/:id` | R1 |
| PATCH, DELETE | `/memories/:id` | R1 |
| POST | `/flags/:id` (resolve) | R1 |
| POST | `/runs` (enqueue) | R1 |
| GET | `/runs/:id` | R1 |
| GET | `/runs/:id/events` (SSE backlog + live tail) | R2 |
| POST | `/runs/:id/inputs` (pause/resume/steer/answer) | R1 |

Notes:

- `POST /blueprints/:id/goldens` splits by content type. The JSON variant
  (`{kind: "run"|"section", runId, sectionKey?, note?}`) is CRUD plus the
  non-LLM `rebuildRunGoldenInventory` and ships in R1. The multipart exemplar
  variant stores a file and triggers the LLM unify+bind pipeline — R3.
- `POST /runs` is a pure enqueue (insert run row + initial events). Because the
  DB is the queue, a run enqueued by the Python backend is picked up and
  executed by the **existing TS worker** — the first live cross-language
  integration, exercised in R1's tests.
- `POST /runs/:id/inputs` is a pure `run_inputs` insert/replace (including the
  replace-pending-answer semantics) — R1.
- `GET /runs/:id/events` remains SSE-only in the contract. R1 does not add a
  JSON backlog variant; the Python implementation of the SSE endpoint is R2.

### 3.3 Drift guard

A pytest asserts the FastAPI app's mounted route set (method + path) equals a
manifest of the R1-implemented subset. The manifest lives next to the contract
doc; adding a route without updating manifest + doc fails the test. FastAPI's
generated OpenAPI (`/openapi.json`) is a debugging aid, not the contract
artifact — `docs/api/v1.md` is authoritative.

## 4. `backend/` layout and tooling

```
backend/
  pyproject.toml            # uv-managed; requires-python >= 3.12
  runoff_api/
    core/                   # port of packages/core (see §6)
      schema.py db.py ids.py reducer.py bindings.py
      dialect.py diff.py warehouse_catalog.py previous_run.py
      types/                # one module per TS types file (see §5)
    api/                    # FastAPI routers, one per resource
      projects.py blueprints.py goldens.py runs.py memories.py flags.py
    main.py                 # app factory + router mounting
  tests/                    # pytest
```

- **Tooling:** `uv` for environment and dependencies; `pytest`; `ruff` for lint
  and format. Dependencies: `fastapi`, `uvicorn`, `pydantic` (v2). (`openai`
  and `sse-starlette` arrive in R2/R3, not R1.)
- **Run:** `uvicorn runoff_api.main:app` on port **8400**, wrapped as
  `pnpm backend:dev`. `pnpm backend:test` runs pytest via uv. Root
  `package.json` gains these scripts so the workflow stays one command away.
- **DB path:** `RUNOFF_DB` env var, default `data/runoff.db` — same variable
  and default as the TS side, resolved relative to the repo root.

## 5. Type port — wire compatibility

- zod schemas in `packages/core/src/types/*` port to **Pydantic v2** models,
  one Python module per TS file (`document.py`, `events.py`, `blueprint.py`,
  `copilot.py`, `sources.py`, `parsePlan` → `parse_plan.py`, `catalog.py`,
  `goldenBinding` → `golden_binding.py`).
- Models use snake_case Python attributes with
  `alias_generator=to_camel` + `populate_by_name=True`, and every serialization
  to the wire or the DB uses `by_alias=True`. Result: JSON is byte-compatible
  in field naming with what TS wrote — load-bearing, because the DB's JSON TEXT
  columns (documents, events, bindings, parse plans) round-trip through both
  backends against the same file.
- Discriminated unions (events, edit ops, blueprint items) port to Pydantic
  discriminated unions on the same tag fields. Validation strictness mirrors
  zod: unknown fields are ignored where zod ignores them, rejected where zod
  `.strict()` rejects them.

## 6. Core port scope

Ported in R1 (each with its pytest suite translated from the TS tests):

| TS source (`packages/core/src`) | Python module | TS test ported |
|---|---|---|
| `db/schema.ts` | `core/schema.py` | `db.test.ts` |
| `db/index.ts` (openDb) | `core/db.py` | `db.test.ts` |
| `db/previousRun.ts` | `core/previous_run.py` | `previousRun.test.ts` |
| `ids.ts` | `core/ids.py` | (covered incidentally) |
| `reducer.ts` | `core/reducer.py` | `reducer.test.ts` |
| `bindings.ts` | `core/bindings.py` | `bindings.test.ts` |
| `dialect.ts` | `core/dialect.py` | (covered via reducer/diff use) |
| `diff.ts` | `core/diff.py` | `diff.test.ts` |
| `warehouseCatalog.ts` | `core/warehouse_catalog.py` | `warehouseCatalog.test.ts` |
| `types/*` | `core/types/*` | `types.test.ts`, `sourcesModel.test.ts`, `parsePlan.test.ts`, `goldenBinding.test.ts`, `copilotTables.test.ts` |

Explicitly **not** ported in R1: `warehouse.ts` (ingestion — R2), everything in
`packages/engine` (LLM — R2/R3), `client.ts` (TS-only browser barrel; the
Angular app consumes HTTP, not a shared package).

DB layer rules:

- `schema.py` carries the `CREATE TABLE` / `CREATE INDEX` statements
  **byte-copied** from `schema.ts`, with a header comment marking it as a
  mirror that changes only in lockstep with the TS file (both frozen during
  the port anyway).
- `db.py` reproduces `openDb` semantics: same PRAGMAs (WAL etc., copied from
  the TS source), `sqlite3.Row` row factory, schema ensured on open.
- Queries are hand-written SQL ported statement-for-statement from the TS
  source so every query is diffable against its origin. No ORM, no query
  builder.

## 7. Verification — three layers

1. **Ported unit suite.** The `packages/core` tests translated to pytest
   (§6 table). Semantics translate test-by-test; test names reference their TS
   origin.
2. **Cross-implementation fixtures.** A TS script
   (`scripts/dump-parity-fixtures.ts`) dumps reference projections to JSON
   fixtures under `backend/tests/fixtures/` — at minimum: reducer output over
   the seeded run's full event log, diff output over the seeded run pair,
   `boundnessCounts`/`parseBindings` over the seeded golden, and the warehouse
   catalog of the seeded project. Pytest asserts the Python port produces
   equal output (compared as parsed JSON, key order ignored). Catches semantic
   drift no translated unit test would.
3. **Contract diff harness.** `scripts/diff-api.ts`: boots the Next.js dev
   server and the Python backend against the same freshly seeded DB, hits
   every R1-implemented GET route pair (TS `/api/...` ↔ Python `/api/v1/...`),
   and diffs the parsed JSON. Zero diffs = R1 done. Write endpoints are
   exercised by the pytest suites, not the diff harness (double-writing one DB
   from two backends in one harness run invites ordering flakiness). The
   harness is a keeper: it re-verifies every later phase and becomes the
   Angular era's contract test.

Additionally, the existing TS suite (501) must stay green throughout — R1
touches no TS production code except additive scripts.

## 8. Out of scope for R1

- Any LLM call, any prompt, `packages/engine` — untouched, unported.
- SSE streaming (contract-documented only), file uploads, warehouse ingestion.
- Next.js changes: no proxying, no fetch retargeting; the Python backend is
  dark. Cutover is R4.
- Angular, schema changes, migrations, auth, deployment/packaging.

## 9. Success criteria

1. `docs/api/v1.md` covers all 23 routes with shapes, status codes, SSE
   framing, and phase tags.
2. `pnpm backend:test` green: ported unit suites + fixture parity tests +
   route-manifest drift guard.
3. `scripts/diff-api.ts` reports zero diffs across all R1 GET routes against a
   seeded DB.
4. A run enqueued via Python `POST /api/v1/runs` is executed to completion by
   the TS worker (asserted by an integration test polling the run row).
5. Existing TS suite stays at 501 green; `pnpm backend:dev` serves on :8400.
