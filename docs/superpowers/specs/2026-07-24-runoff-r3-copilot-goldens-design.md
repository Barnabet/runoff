# Runoff R3 — Copilot + Goldens LLM Surface (Python Port)

**Phase:** R3 of the rewrite program (R1 contract + CRUD shipped `1fa5750`; R2
run pipeline + ingestion shipped `d26330e`; R4 cutover follows).

**Goal:** port the last LLM surfaces — the builder copilot turn and the goldens
unify/bind pipeline — to the Python backend, mount the four remaining R3
routes, and lift the §4.1 multipart-goldens 501 divergence. After R3, every
route in `docs/api/v1.md` is implemented in Python; only R4 (cutover, delete
TS backend) remains.

## 1. Porting Contract (unchanged from R1/R2)

The TS source file is the requirements document. Statement-for-statement port;
prompts and LLM request payloads byte-identical; TS tests twinned case-by-case,
snake_cased; TS wins on any plan disagreement; plain-dict camelCase runtime
values; `to_json` (JSON.stringify framing) for anything serialized into
prompts or the DB; `int | float` for zod numbers; sync-only Python (no
asyncio in engine/services). Same SQLite file, schema frozen.

## 2. Decisions (brainstorm 2026-07-24)

- **Parity bar: fixtures + live evals.** Extend the R2 prompt-fixture harness
  with byte-identical first-call `create()` payloads for the copilot turn,
  bind, and unify; add live Python eval twins of `scripts/evalCopilot.ts` and
  `scripts/evalGolden.ts`.
- **Live proof: full arc.** Against :8400 with the real LLM: multipart
  exemplar upload → unify → bind → verified inventory, then a copilot turn
  that exercises `get_golden_scaffold`, SSE tailed to `done`. Plus the
  outstanding composed `pnpm dev` boot check from R2.
- **Chores: early R3 tasks.** The Python-side R3-chores backlog from the R2
  final review folds in as Task 0 (§9). The TS `sourceManager.ts:229`
  rollback-masking twin stays noted for R4 deletion — not fixed in TS.
- **Approach A:** one spec, one plan, one branch (~13 tasks), mirroring R2.

## 3. Route Surface

Four handler additions to the Python app (drift-guard manifest 30 → 33; the
multipart variant shares the existing goldens-POST handler):

| Route | Contract | Status today |
|---|---|---|
| `POST /api/v1/blueprints/:id/copilot` | §2.13 + SSE §3.2 | unmounted (404) |
| `POST /api/v1/blueprints/:id/goldens` (multipart) | §2.14 | **501** (§4.1) |
| `POST /api/v1/blueprints/:id/goldens/:goldenId/unify` | §2.15 | unmounted |
| `POST /api/v1/blueprints/:id/goldens/:goldenId/bind` | §2.16 | unmounted |

The §4.1 divergence is deleted from the contract when the multipart branch
lands. §4.2 (PATCH malformed JSON → 400) and §4.3 (pypdf near-parity, which
now also covers exemplar PDF text fed to unify) remain.

## 4. Port Map

Everything below builds on already-ported R1/R2 modules:
`build_source_pack`/`pack_for_prompt`/`extract_file_text` (source_pack),
`serialize_catalog` (catalog_format), `verify_inventory` /
`inventory_from_citations` / `boundness_line` / `parse_span_number`
(golden_binding), `resolve_golden`/`get_golden_row`/`list_goldens`/
`golden_label` (goldens service), warehouse SQL + `format_sql_result`,
`MODEL`/`guidance_blocks` (prompts).

| TS source | Python target | Contents |
|---|---|---|
| `packages/engine/src/scaffoldGolden.ts` | `backend/runoff_api/engine/scaffold_golden.py` (new) | `build_scaffold_digest`, `render_scaffold_digest`, `serialize_prose` (PROSE_CAP 1500). Pure/deterministic. |
| `packages/engine/src/unifyGolden.ts` | `backend/runoff_api/engine/unify_golden.py` (new) | `cap_exemplar_text` (24 000 threshold; first 20 000 + `\n…\n` + last 4 000), `is_unsupported_exemplar_mime` (csv + xlsx), `UNIFY_CONTRACT` prompt byte-identical, `unify_golden_report`: `response_format: {type:"json_object"}`, `max_completion_tokens: 4000`, 2 structural attempts + at most 1 degeneracy retry (retry does not consume an attempt), period validated against `PERIOD_REGEX` values. |
| `packages/engine/src/bindGolden.ts` | `backend/runoff_api/engine/bind_golden.py` (new) | `render_doc_for_binding` (anchor coordinates, span text sliced to 160, tables 12 rows + "… N more rows"), `render_siblings`, TOOLS (`run_sql`, `submit_inventory`), `bind_golden`: MAX_BIND_ITERATIONS 16, `max_completion_tokens: 6000`, submit validated by `SubmittedInventorySchema` + `validate_inventory_anchors`, zod-flattening of validation errors mirrored from the Python schema layer (path: message pairs, sliced to 300), over-budget nudge sent at most once, post-nudge round without a valid submit returns None. |
| `packages/engine/src/copilot.ts` (611 lines) | `backend/runoff_api/engine/copilot.py` (new) | Split across two tasks: **(a)** TOOLS (all 12 function schemas verbatim), `copilot_system_prompt`, `activity_label`, `compact`, `renumber`, `family_line`, `execute_tool` (all tool executors incl. edit ops applied to the draft, `get_golden_scaffold` from the scaffold cache); **(b)** `copilot_turn`: streaming loop (`stream: True`, `max_completion_tokens: 8000`), delta accumulation of text + tool_calls by index, `io.emit` of `text_delta`/`tool_activity`/`edit`/`memory_saved`, MAX_ITERATIONS 12 then a single exhaustion nudge, post-nudge tool_calls → hard stop without executing, tool results capped at MAX_TOOL_RESULT_CHARS 10 100 (20 000 for `get_golden_scaffold`), returns `{reply, actions, draft}`. |
| `goldenBinding.ts:127 renderGoldenForPrompt` | `services/golden_binding.py` (extend) | `render_golden_for_prompt`. |
| `apps/web/lib/goldens.ts` additions | `services/goldens.py` (extend) | `list_golden_summaries` (the R1 Task-5 deferral — label = `golden_label` + boundness line over `parse_bindings`), `scaffold_digest_for` (not-unified / no-bindings fallbacks then digest render). |
| `apps/web/lib/goldenPipeline.ts` | `services/golden_pipeline.py` (extend) | `_siblings_for` (newest 3 with non-null bindings, corrupt rows degrade to skip), `bind_exemplar` (returns ok/error dict; catches everything into `bind failed: …`), `unify_and_bind_exemplar` (unsupported-mime persists `unify_error` and returns; extract → unify → persist document+period+clear error → auto-chain `bind_exemplar`, whose failure leaves bindings null; extraction/unify exceptions persist `unify failed: …`). Golden-scoped executors bind `:period` to the **golden's** period. |
| `apps/web/lib/queries.ts buildCopilotContext` | `services/queries.py` (extend) | `build_copilot_context`: families with filedPeriods/hasLiveFile/bound, defaultFiles (constant null-slot / periodic lexicographic-latest, EngineFile id = family id), periodFiles (id `familyId:period` set at pack time by the engine), catalog, golden + scaffold caches passed in. |
| `apps/web/app/api/blueprints/[id]/copilot/route.ts` POST | `api/blueprints.py` (extend, beside the R1 GET) | §5. |
| goldens multipart / unify / bind routes | `api/goldens.py` (extend) | §6. |

## 5. Copilot SSE Route (`POST /blueprints/:id/copilot`)

Pre-stream guards, in TS order, JSON errors before any SSE bytes:
1. invalid JSON body → 400 `{"error": "invalid JSON body"}`
2. `message` missing/non-string/empty-after-trim → 400 `{"error": "message is required"}`
3. `draft` fails BlueprintContent validation → 400 `{"error": "invalid draft"}`
4. `selectedKey`: string or null (non-strings → null).

Sequencing (parity-critical): thread (`status='ok'` rows, rowid order) and
memories (blueprint + project scope, active, rowid order) are loaded **before**
inserting the new user `copilot_messages` row. Then golden + scaffold caches
are pre-resolved for every golden (description = `label — boundness_line`,
text = `render_golden_for_prompt`, scaffold = `scaffold_digest_for`), then
`build_copilot_context`.

**Sync/stream inversion.** The engine stays sync + callback (`io.emit`, the
same duck-type as the R2 run engine). The route spawns one worker thread with
a `queue.Queue`:
- The thread runs `copilot_turn` with `emit = queue.put`. On success it
  persists the assistant row (reply + actions JSON), then enqueues
  `{type:"done", messageId}`. On exception it persists the partial streamed
  text + streamed actions as a `status: 'failed'` row, then enqueues
  `{type:"error", message}`. Accumulation mirrors TS: `text_delta` appends to
  streamed text; `edit`/`memory_saved` append to streamed actions.
- The thread uses its own SQLite connection (thread affinity), as the worker
  already does.
- The generator behind `StreamingResponse` drains the queue and frames each
  event as `data: <to_json(event)>\n\n`; after the terminal event (exactly one
  of `done`/`error`) it returns, closing the stream. No heartbeats, no replay
  — this stream is not DB-backed (contract §3.2).
- Message ids: user row and assistant row are `new_id("cmsg")`, assistant id
  generated before the turn (TS parity: persisted row id = streamed
  `messageId`).

## 6. Goldens Routes

**Multipart branch of `create_golden`** (content-type contains
`multipart/form-data`; replaces the 501):
- `file` part required, else 400 `{"error": "file is required"}`.
- `name` = trimmed form field if non-empty, else the upload's filename;
  `note` = trimmed field or null.
- `stored_filename` = `{goldenId}_{sanitize(filename)}` where sanitize is
  basename + `[^a-zA-Z0-9._-]` → `_`, empty → `file`.
- mime = declared type unless empty/`application/octet-stream`, else the
  EXT_MIME map (`.pdf .csv .txt .md .docx .xlsx`), else
  `application/octet-stream`.
- mkdir files dir, write bytes, INSERT exemplar row, then
  `unify_and_bind_exemplar` runs **synchronously before responding** (TS
  awaits it; errors are persisted to `unify_error`, never thrown), return
  `{"id": goldenId}`.

**`POST …/unify`:** golden must exist on this blueprint (404
`golden not found`), kind must be `exemplar` (400
`only exemplar goldens can be unified`), then `unify_and_bind_exemplar`,
respond `{"golden": get_golden_row(...)}`.

**`POST …/bind`:** 404 guard as above; body parse failure swallowed →
no feedback; then the four-way split in TS order:
1. kind ≠ exemplar: with feedback → 400 `feedback requires an exemplar
   golden`; without → `rebuild_run_golden_inventory`.
2. exemplar without document → 400 `golden is not unified`.
3. exemplar with bindings and **no** feedback → `verify_stored_inventory`
   only (no LLM).
4. else → `bind_exemplar`; on not-ok → 500 `{"error": <r.error>}`.
Success responds `{"golden": get_golden_row(...)}`.

## 7. Prompt-Fixture Harness Extension

Extend `scripts/dump-prompt-fixtures.ts` and
`backend/tests/test_prompt_fixtures.py` with three stages (same canned seed
state and recording-fake mechanism R2 used, including the streaming fake
already proven on the draft stage):

- **`copilot.json`** — the first `create()` payload of a copilot turn: model,
  `stream: true`, full message list (system prompt with draft, selectedKey,
  memories, catalog; thread; user message), all 12 tool schemas,
  `max_completion_tokens: 8000`. Seed state must include at least one golden
  with a scaffold-capable inventory so the golden/scaffold cache paths feed
  the context deterministically.
- **`bind.json`** — the first bind-loop payload: system prompt with rendered
  document, catalog, golden period, siblings block, prior-inventory and
  feedback variants included as two keys in the one fixture file
  (`initial`, `rebind` — the latter with priorInventory + feedback), tools,
  `max_completion_tokens: 6000`.
- **`unify.json`** — UNIFY_CONTRACT system message + user message with
  filename and capped text (include a >24 000-char text so the head/tail cap
  is exercised), `response_format`, `max_completion_tokens: 4000`.

Assertion: Python-built payloads byte-identical to the fixtures
(`to_json` framing), as in R2.

## 8. Live Eval Twins

Same exit-code protocol as R2 evals (0 ok, 1 failed, 2 proxy unreachable,
3 auth), same preflight probe, run against the seeded dev DB:

- **`backend:eval:copilot`** (`backend/evals/eval_copilot.py`, beside the R2
  `eval_classify.py`/`eval_parse.py`): one real conversation turn asking for a
  section-instruction tightening; asserts ≥1 applied edit op and a coherent
  reply — the same assertions as `scripts/evalCopilot.ts`.
- **`backend:eval:golden`** (`eval_golden.py`): live unify of the seeded
  AR-review exemplar markdown, live bind against the seeded warehouse,
  verify; asserts some bound numeric value equals the warehouse AR total
  within tolerance and boundness clears 50% — name-agnostic, as in
  `scripts/evalGolden.ts`.

Root `package.json` gains `backend:eval:copilot` and `backend:eval:golden`.

## 9. Task 0 — Chores (R2 final-review backlog)

1. Promote `probe_pause.py` to a real test.
2. SSE-test watchdog: worker-thread join + `EVENTS_HEARTBEAT_EVERY=2`
   increment pin.
3. Pin `RUNOFF_MODEL` in the fixture harness + tests (env leak fails prompt
   fixtures in dev shells).
4. `_js_string` public rename.
5. Ingest-dump literal `isEmptyPayload` guard.

Not in scope: TS `sourceManager.ts:229` (noted for R4 deletion);
`brand_guidelines.pdf` metadata strip (only on next fixture churn); Task-4
byte-compare watchlist (stays a ledger watchlist).

## 10. Documentation

- `docs/api/v1.md`: flip all R3 markers to implemented; delete §4.1 and
  renumber/reword §4 to "one wire divergence (§4.2) + PDF near-parity
  (§4.3)"; extend §4.3 to note exemplar unify shares the pypdf caveat for
  PDF exemplars; drift-guard route manifest 30 → 33 with set-equality.
- Ledger: per-task entries + final-review entry + merge entry, as R1/R2.

## 11. Out of Scope

- R4 cutover (delete TS backend, `worker:ts` removal, TS route deletion).
- R5 Angular frontend.
- Any TS behavior change (the TS side only gains dump-script additions).
- New features on either stack; the port is behavior-identical.

## 12. Success Criteria

1. All three new fixture stages byte-identical on the Python side.
2. `backend:eval:copilot` and `backend:eval:golden` green live.
3. Live arc on :8400: multipart exemplar upload → unified document + bound
   verified inventory in the DB; then a copilot POST whose turn calls
   `get_golden_scaffold`, SSE tailed to a `done` terminal event.
4. Composed `pnpm dev` boot check: web + Python worker up together, one
   smoke run to complete (clears the R2 leftover).
5. `pnpm backend:test` + `backend:lint` clean; TS suite untouched-green.
6. `pnpm backend:diff` zero diffs; drift guard passes at 33 routes.
7. `docs/api/v1.md` shows every route implemented; §4.1 gone.
8. Task 0 chores landed.
