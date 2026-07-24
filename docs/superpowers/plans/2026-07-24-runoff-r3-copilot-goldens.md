# Runoff R3 — Copilot + Goldens LLM Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the builder copilot turn engine and the goldens unify/bind LLM pipeline to the Python backend, mount the four remaining R3 routes (copilot SSE, multipart goldens, unify, bind), and lift the §4.1 multipart-501 divergence — completing the API surface ahead of R4 cutover.

**Architecture:** Four new `backend/runoff_api/engine/` modules (`scaffold_golden`, `unify_golden`, `bind_golden`, `copilot`) mirroring `packages/engine`; extensions to R1's golden services and `services/queries.py`; the copilot POST inverts the sync callback engine into SSE via one worker thread + `queue.Queue`. Three new prompt-fixture stages and two live eval twins gate the phase.

**Tech Stack:** Python ≥3.12 (uv), FastAPI, Pydantic v2, stdlib sqlite3 + `queue`/`threading`, `openai` sync SDK. **No new dependencies on either side.**

**Spec:** `docs/superpowers/specs/2026-07-24-runoff-r3-copilot-goldens-design.md`

## Global Constraints

- **Porting Contract (R1/R2, unchanged):** the named TS source file is the requirements document. Port statement-for-statement: same branch structure, same error messages, same caps and regexes, same SQL strings and aliases. TS tests are ported case-by-case with snake_cased names. On any disagreement between this plan and the TS source, **TS wins** — note the deviation in your report.
- **Plain-dict runtime:** documents/inventories/events/contexts flow as plain dicts with **camelCase keys**. Pydantic validates only where zod validates in TS. Serialize DB/wire JSON with `core.jsonutil.to_json`. zod `z.number()` fields are `int | float`.
- **Prompts and LLM request payloads are byte-identical** to TS, including whitespace, newlines, interpolation order, and payload key order. Never "improve" a prompt. Draft-JSON and inventory-JSON embedded in prompts serialize via `to_json` (matches `JSON.stringify`).
- **Sync only.** No asyncio in engine/services. Streaming uses the sync `openai` iterator. The copilot route's concurrency is a plain `threading.Thread` + `queue.Queue` — never an async generator over the engine.
- **Model/env:** `OPENAI_BASE_URL` default `http://localhost:8317/v1`, `OPENAI_API_KEY` default `"local"`, `RUNOFF_MODEL` default `"gpt-5.6-sol"`; data env `RUNOFF_DB`, `RUNOFF_FILES_DIR`, `RUNOFF_WAREHOUSE_DIR`.
- **Secrets:** the CLIProxyAPI key lives in git-ignored `.env` and must NEVER be committed or printed. `.env.example` carries only a placeholder. The repo is public. Nothing under `data/` is committed.
- **Contract frozen:** paths, status codes, error strings, and SSE framing come from `docs/api/v1.md` §2.13–§2.16 and §3.2 — copy strings from there/TS source, never invent.
- **DB schema frozen.** No DDL.
- **Engine constants (copy verbatim, tests may monkeypatch):** copilot `MAX_ITERATIONS = 12`, `MAX_TOOL_RESULT_CHARS = 10_100` (get_golden_scaffold results cap at `20_000`), `max_completion_tokens: 8000`; bind `MAX_BIND_ITERATIONS = 16`, `max_completion_tokens: 6000`; unify `max_completion_tokens: 4000`, cap 24 000 → first 20 000 + `\n…\n` + last 4 000; scaffold `PROSE_CAP = 1500`; siblings newest 3.
- **TS side is additive only:** `scripts/dump-prompt-fixtures.ts` gains three stages and the empty-payload guard; nothing else changes. TS `sourceManager.ts:229` is explicitly NOT fixed (noted for R4).
- Commands from repo root: `pnpm backend:test`, `pnpm backend:lint`; single file: `uv --directory backend run pytest tests/test_x.py -q`.
- Python: snake_case defs, type hints on public signatures, module docstring naming the TS source file it ports.

## File Map

| Task | Creates | Modifies |
|---|---|---|
| 1 | — | `backend/tests/test_run_engine.py`, `test_events_sse.py`, `test_prompt_fixtures.py`, `scripts/dump-prompt-fixtures.ts`, `scripts/dump-ingest-fixtures.ts`, `backend/runoff_api/engine/parse_plan.py`, `engine/source_pack.py`, `services/plan_propose.py` |
| 2 | `backend/runoff_api/engine/scaffold_golden.py`, `backend/tests/test_scaffold_golden.py` | — |
| 3 | — | `backend/runoff_api/services/golden_binding.py`, `services/goldens.py`, `backend/tests/test_golden_binding.py`, `test_goldens_service.py` |
| 4 | `backend/runoff_api/engine/unify_golden.py`, `backend/tests/test_unify_golden.py` | — |
| 5 | `backend/runoff_api/engine/bind_golden.py`, `backend/tests/test_bind_golden.py` | — |
| 6 | `backend/tests/test_golden_pipeline.py` | `backend/runoff_api/services/golden_pipeline.py` |
| 7 | `backend/tests/test_goldens_routes_r3.py` | `backend/runoff_api/api/goldens.py`, `backend/tests/test_api_manifest.py` |
| 8 | `backend/tests/test_copilot_context.py` | `backend/runoff_api/services/queries.py` |
| 9 | `backend/runoff_api/engine/copilot.py`, `backend/tests/test_copilot_tools.py` | — |
| 10 | `backend/tests/test_copilot_turn.py` | `backend/runoff_api/engine/copilot.py` |
| 11 | `backend/tests/test_copilot_sse.py` | `backend/runoff_api/api/blueprints.py`, `backend/tests/test_api_manifest.py` |
| 12 | `backend/tests/fixtures/prompts/copilot.json`, `bind.json`, `unify.json` | `scripts/dump-prompt-fixtures.ts`, `backend/tests/test_prompt_fixtures.py` |
| 13 | `backend/evals/eval_copilot.py`, `backend/evals/eval_golden.py` | root `package.json`, `docs/api/v1.md`, `.superpowers/sdd/progress.md` |

---

### Task 1: Chores (R2 final-review backlog)

**Files:**
- Modify: `backend/tests/test_run_engine.py`, `backend/tests/test_events_sse.py`, `backend/tests/test_prompt_fixtures.py`, `scripts/dump-prompt-fixtures.ts`, `scripts/dump-ingest-fixtures.ts`, `backend/runoff_api/engine/parse_plan.py`, `backend/runoff_api/engine/source_pack.py`, `backend/runoff_api/services/plan_propose.py`
- Reference: `.superpowers/sdd/progress.md` R2 final-review entry (the R3-chores backlog list), `scripts/dump-parity-fixtures.ts` (the R2 Task-1 null-overwrite guard to replicate), `backend/runoff_api/engine/run.py` (pause loop)

Five independent chores; commit each separately.

- [ ] **Step 1: Pause/resume engine test.** In `test_run_engine.py`, add the test the R2 reviewer's throwaway `probe_pause.py` verified manually: a scripted `io` whose `poll_inputs` returns `[{"kind": "pause"}]` on the first drain, then (while paused) a steer `[{"kind": "steer", "text": ...}]`, then `[{"kind": "resume"}]`; a recording fake `sleep`. Assert: `run_paused` and `run_resumed` events emitted in order; `sleep(200)` called before every pause-loop poll; the steer posted during pause reaches the NEXT `draft_section` call's `steers` argument. Run it, confirm green against the existing engine.
- [ ] **Step 2: Commit** — `test(backend): pin pause/resume loop behavior (probe_pause promotion)`
- [ ] **Step 3: SSE watchdog + EVERY=2 pin.** In `test_events_sse.py`: (a) wherever a reader thread consumes the stream, join it with a timeout and fail the test on timeout instead of hanging the suite; (b) add one case with `EVENTS_HEARTBEAT_EVERY = 2` pinning that the ping arrives every 2nd idle poll iteration (not off-by-one). Run the file, green.
- [ ] **Step 4: Commit** — `test(backend): SSE reader watchdog join + heartbeat increment pin`
- [ ] **Step 5: RUNOFF_MODEL pin.** `scripts/dump-prompt-fixtures.ts`: set `process.env.RUNOFF_MODEL = "gpt-5.6-sol"` before any engine import. `backend/tests/test_prompt_fixtures.py`: force the same value before the harness imports/reads `MODEL` (monkeypatch env at module scope or reload `engine.llm` — match how the file already handles imports). Verify: `RUNOFF_MODEL=other pnpm backend:prompt-fixtures` then `RUNOFF_MODEL=other uv --directory backend run pytest tests/test_prompt_fixtures.py -q` both stay green.
- [ ] **Step 6: Commit** — `fix(parity): pin RUNOFF_MODEL in prompt-fixture harness against dev-shell env leaks`
- [ ] **Step 7: `_js_string` consolidation.** Two private copies exist (`engine/parse_plan.py:33`, `engine/source_pack.py:160`; `services/plan_propose.py` uses one). Make ONE public `js_string` in `engine/parse_plan.py` (keep body byte-identical), have `source_pack.py` and `plan_propose.py` import it, delete the duplicate. If an import cycle appears, keep both but public, and note it. `pnpm backend:test` + `backend:lint` green.
- [ ] **Step 8: Commit** — `refactor(backend): single public js_string`
- [ ] **Step 9: Ingest-dump guard.** In `scripts/dump-ingest-fixtures.ts`, replace/extend the literal empty-payload check with the same refuse-to-overwrite guard `dump-parity-fixtures.ts` uses: never overwrite an existing non-empty fixture with a null/empty dump; warn + exit non-zero if any write was skipped. Verify `pnpm backend:ingest-fixtures` still writes all fixtures, `git diff` clean.
- [ ] **Step 10: Commit** — `chore(scripts): ingest-fixture dump refuses empty overwrites`

---

### Task 2: Scaffold digest engine

**Files:**
- Create: `backend/runoff_api/engine/scaffold_golden.py`, `backend/tests/test_scaffold_golden.py`
- Reference: `packages/engine/src/scaffoldGolden.ts` (all 82 lines), `packages/engine/test/scaffoldGolden.test.ts` (all 7 cases)

**Interfaces:**
- Consumes: `boundness_line` from `services/golden_binding.py` (R1).
- Produces: `build_scaffold_digest(g: dict) -> dict` — input keys `id, label, period, document, inventory`; returns ScaffoldDigest dict `{"goldenId", "label", "period", "boundness", "sections": [{"key", "heading", "prose", "queries": [{"name", "sql", "provenance"}], "warnings": [...]}]}`; `render_scaffold_digest(d: dict) -> str`. Deterministic, no LLM.

- [ ] **Step 1: Port all 7 cases** from `scaffoldGolden.test.ts`, snake_cased. Expected strings byte-for-byte.
- [ ] **Step 2: Run, confirm failure** — `uv --directory backend run pytest tests/test_scaffold_golden.py -q`
- [ ] **Step 3: Implement statement-for-statement.** `serialize_prose` (spans joined with `" "`, tables as `[table N cols × M rows: col | col]`, blocks joined `\n`, `PROSE_CAP = 1500` then `…`); per-section item grouping by `anchor.sectionKey`; bound/mismatch → queries with dedup suffix `_2, _3…`; mismatch warning `"<raw>" mismatches current data (golden says <raw> · data <verifiedValue>)` with TS `String()` semantics for verifiedValue (reuse the R1 helper the golden_binding port uses for stringifying verified values); unbound warning `"<raw>" has no data backing (<reason ?? "unbound">)`; empty-queries warning `no verified queries in this section`; render format verbatim (`SCAFFOLD DIGEST — golden "<label>" (period <period ?? "none">, <boundness>)`, `## section:` lines, `queries:`/`warnings:` blocks, `[verified]`/`[verified-mismatch]` tags).
- [ ] **Step 4: Run to verify pass**, `pnpm backend:lint`.
- [ ] **Step 5: Commit** — `feat(backend): engine scaffold digest — build + render`

---

### Task 3: Golden service extensions — renderGoldenForPrompt, summaries, digest accessor

**Files:**
- Modify: `backend/runoff_api/services/golden_binding.py` (add `render_golden_for_prompt`), `backend/runoff_api/services/goldens.py` (add `list_golden_summaries`, `scaffold_digest_for`), `backend/tests/test_golden_binding.py` (port the skipped case), `backend/tests/test_goldens_service.py` (new cases)
- Reference: `packages/engine/src/goldenBinding.ts:127-158` (`renderGoldenForPrompt`), `packages/engine/test/goldenBinding.test.ts:128` ("renders doc with annotations and boundness; inert without document" — the case `test_golden_binding.py` explicitly skipped in R1), `apps/web/lib/goldens.ts:25-32` (`listGoldenSummaries`), `:84-91` (`scaffoldDigestFor`), `apps/web/test/goldensApi.test.ts` + `apps/web/test/goldenCards.ui.test.tsx` — port any non-UI cases covering summaries/digest fallbacks (check which exist; UI rendering cases are skipped, note them)

**Interfaces:**
- Consumes: `boundness_line`, `parse_bindings` (R1 core), `resolve_golden`/`list_goldens`/`golden_label` (R1 services), Task 2 `build_scaffold_digest`/`render_scaffold_digest`.
- Produces: `render_golden_for_prompt(g: dict) -> str` (input keys `label, note, period, document, inventory, unifyError`); `list_golden_summaries(db, blueprint_id) -> list[dict]` (`{"id", "kind", "label", "note"}`, label = `<golden_label> — <boundness_line>`); `scaffold_digest_for(resolved: dict) -> str` (not-unified → `golden "<label>" is not unified (<unifyError ?? "not yet processed">)`; no inventory → `golden "<label>" has no bindings — run Bind to data first`; else render digest).

- [ ] **Step 1: Port the tests** — the skipped goldenBinding case (annotation format `«raw ← familyId: sql»`, 120-char SQL truncation with `…`, `[MISMATCH: data says X]` tag, error-status items unannotated, table row rendering, `boundness:` last line, inert `golden "<label>" is not unified (<unifyError ?? "no document">)`), plus summaries/digest-fallback cases. Remove the stale "Skipped: renderGoldenForPrompt" docstring note.
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement statement-for-statement.** Anchor map key `f"{sectionKey}|{blockIndex}|{spanIndex ?? 't'}"`; note the two distinct inert strings (`"no document"` here vs `"not yet processed"` in `scaffold_digest_for` — TS has both, keep both).
- [ ] **Step 4: Run to verify pass**, lint.
- [ ] **Step 5: Commit** — `feat(backend): render golden for prompt + summaries + scaffold digest accessor`

---

### Task 4: Unify engine

**Files:**
- Create: `backend/runoff_api/engine/unify_golden.py`, `backend/tests/test_unify_golden.py`
- Reference: `packages/engine/src/unifyGolden.ts` (all 75 lines), `packages/engine/test/unifyGolden.test.ts` (all 7 cases)

**Interfaces:**
- Consumes: `engine.llm.MODEL`, `tests/fake_client.py` (R2), R1 `RunDocument` validation + `PERIOD_REGEX` (core).
- Produces: `cap_exemplar_text(text: str) -> str`; `is_unsupported_exemplar_mime(mime: str) -> bool` (csv + xlsx only); `unify_golden_report(*, client, filename, text) -> dict | None` (`{"document": dict, "period": str | None}`).

- [ ] **Step 1: Port all 7 cases** (fake-client scripts mirroring the TS scripts: valid JSON, invalid-JSON retry message `That was not valid document JSON. Return exactly the specified JSON object.`, degeneracy retry `That document is degenerate: <reason>. Produce the full document.` exactly once and not consuming a structural attempt, zero-sections + all-empty-blocks reasons, period regex validation, client-exception → None, cap behavior).
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement statement-for-statement.** `UNIFY_CONTRACT` byte-identical; request = `{model, messages, response_format: {"type": "json_object"}, max_completion_tokens: 4000}` in that key order; 2 structural attempts, `attempt -= 1` on the single degeneracy retry; degenerate reasons `the document has zero sections` / `every block is empty`.
- [ ] **Step 4: Run to verify pass**, lint.
- [ ] **Step 5: Commit** — `feat(backend): engine unify golden report`

---

### Task 5: Bind engine

**Files:**
- Create: `backend/runoff_api/engine/bind_golden.py`, `backend/tests/test_bind_golden.py`
- Reference: `packages/engine/src/bindGolden.ts` (all 119 lines), `packages/engine/test/bindGolden.test.ts` (all 8 cases)

**Interfaces:**
- Consumes: `engine.llm.MODEL`, `engine.catalog_format.serialize_catalog` (R2), fake client, R1 `SubmittedInventory` validation + `validate_inventory_anchors` (core types).
- Produces: `render_doc_for_binding(document: dict) -> str`; `bind_golden(*, client, catalog, run_sql, document, period, siblings, prior_inventory=None, feedback=None) -> dict | None` (a SubmittedInventory dict, or None).

- [ ] **Step 1: Port all 8 cases** (doc rendering: span slice 160, `[b0.s1]`/`[b1]` coordinates, table 12-row cap + `… N more rows`; system prompt assembly incl. siblings block gated on non-empty bound items, prior-inventory and feedback lines; run_sql dispatch + error string `Tool error: sql: <msg>`; submit validation failure → `Tool error: invalid inventory: <detail sliced to 300>` with flattened `path: message` pairs joined `; ` for schema errors vs first-line for anchor errors; over-budget nudge `Tool budget exhausted. Call submit_inventory with your best inventory now.` sent once; post-nudge no-submit → None; finish without tool_calls → None; client exception → None).
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement statement-for-statement.** TOOLS via the local `fn` helper (`strict: false`, `required` = all property keys, `additionalProperties: false`); request `{model, messages, tools, max_completion_tokens: 6000}`; siblings rendered `period <p ?? "unknown">:` + `  <id>: "<raw>" ← <familyId>: <sql>`; prior inventory embedded via `to_json`; the Python analogue of the zod-flatten: pydantic `ValidationError` → `f"{'.'.join(str(p) for p in err['loc'])}: {err['msg']}"` joined `; ` (match however R1's schema layer reports; the TS wire behavior to preserve is "path: message pairs, `; `-joined, sliced to 300" — assert the format in the test, note any unavoidable message-text difference as a deviation); anchor errors (plain Error) keep first-line handling.
- [ ] **Step 4: Run to verify pass**, lint.
- [ ] **Step 5: Commit** — `feat(backend): engine bind golden — doc render, siblings, tool loop`

---

### Task 6: Golden pipeline — bindExemplar, unifyAndBindExemplar, siblings

**Files:**
- Modify: `backend/runoff_api/services/golden_pipeline.py`
- Create: `backend/tests/test_golden_pipeline.py`
- Reference: `apps/web/lib/goldenPipeline.ts` (the unported rest: `siblingsFor` :55-68, `bindExemplar` :70-99, `unifyAndBindExemplar` :101-132; `rebuildRunGoldenInventory`/`verifyStoredInventory` are R1 — untouched), `apps/web/test/goldenPipeline.test.ts` (all 8 cases; skip any already twinned in R1 — check `git grep -n "rebuild_run_golden\|verify_stored" backend/tests/` first and note skips)

**Interfaces:**
- Consumes: Task 4 `unify_golden_report`, Task 5 `bind_golden`, R1 `resolve_golden`/`get_golden_row`, R1 `verify_inventory`, R2 `extract_file_text` (engine.source_pack), warehouse SQL helpers already used by this module (`_exec_for`), `make_llm_client` (R2), R1 catalog service.
- Produces: `bind_exemplar(db, golden_id, feedback=None) -> dict` (`{"ok": True}` | `{"ok": False, "error": str}`); `unify_and_bind_exemplar(db, golden_id) -> None`; module-private `_siblings_for(db, blueprint_id, exclude_golden_id) -> list[dict]`.

- [ ] **Step 1: Port the test cases** (fake LLM seams as in the TS tests): siblings = newest 3 with non-null bindings excluding self, corrupt bindings row skipped not fatal; bind_exemplar not-unified → `{"ok": False, "error": "golden is not unified"}`; None from bind → `bind failed: no inventory produced`; success verifies + persists bindings JSON; exception → `bind failed: <msg>`; unify unsupported mime persists `unsupported exemplar type for unify: <mime>` and returns without LLM; unify None → `unify failed: no document produced`; success persists document+period, clears unify_error, auto-chains bind (bind failure leaves bindings null, no raise); extract/unify exception → `unify failed: <msg>`.
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement statement-for-statement.** Exemplar file path = `os.path.join(files_dir(), stored_filename)` with `RUNOFF_FILES_DIR` default `data/files`; EngineFile dict for extract = `{"id": g_id, "name": name ?? "exemplar", "mime": mime ?? "text/plain", "path": ...}`; `:period` binds to the GOLDEN's period in both exec and run_sql closures; client constructed where the TS does (module-level `getLlmClient()` equivalent = `make_llm_client()` per call site — keep a seam tests can monkeypatch).
- [ ] **Step 4: Run to verify pass** (R1 pipeline tests untouched-green), lint.
- [ ] **Step 5: Commit** — `feat(backend): golden pipeline — bind exemplar, unify+bind chain, siblings`

---

### Task 7: Goldens routes — multipart lift, unify, bind

**Files:**
- Modify: `backend/runoff_api/api/goldens.py` (replace the 501 branch; add two routes), `backend/tests/test_api_manifest.py` (add unify + bind)
- Create: `backend/tests/test_goldens_routes_r3.py`
- Reference: `docs/api/v1.md` §2.14 (multipart), §2.15, §2.16 (authoritative); TS `apps/web/app/api/blueprints/[id]/goldens/route.ts` (multipart branch, lines 30-53), `.../goldens/[goldenId]/unify/route.ts`, `.../goldens/[goldenId]/bind/route.ts`; `apps/web/test/goldenRoutes.test.ts` (all 11 cases; skip R1-twinned JSON-variant cases — check `backend/tests/` and note)

**Interfaces:**
- Consumes: Task 6 (`unify_and_bind_exemplar`, `bind_exemplar`), R1 (`rebuild_run_golden_inventory`, `verify_stored_inventory`, `get_golden_row`), R1 `new_id`.
- Produces: multipart branch inside the existing `create_golden` handler; `POST /api/v1/blueprints/{id}/goldens/{goldenId}/unify`; `POST /api/v1/blueprints/{id}/goldens/{goldenId}/bind`. Manifest count 30 → 32 here (33 after Task 11).

- [ ] **Step 1: Port route tests** (LLM boundary mocked at `unify_and_bind_exemplar`/`bind_exemplar` seams): multipart happy path (file stored under `RUNOFF_FILES_DIR` as `{goldenId}_{sanitized}`, exemplar row inserted, pipeline called synchronously, `{"id": ...}` returned); `file is required` 400; name/note trimming + filename fallback; mime resolution (declared unless empty/octet-stream → EXT_MIME by extension → octet-stream); sanitize `[^a-zA-Z0-9._-]` → `_`, empty → `file`. Unify: 404 `golden not found` (missing + wrong-blueprint), 400 `only exemplar goldens can be unified`, success returns `{"golden": <row>}`. Bind: 404; body parse failure → no feedback; run/section + feedback → 400 `feedback requires an exemplar golden`; run/section no feedback → rebuild called; exemplar no document → 400 `golden is not unified`; exemplar bound + no feedback → verify_stored only (no LLM seam touched); exemplar + feedback → bind_exemplar; not-ok → 500 `{"error": <r.error>}`.
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement** per the TS route files; delete the 501 branch and its `exemplar upload not yet implemented in this backend (R3)` string; EXT_MIME map verbatim (`.pdf .csv .txt .md .docx .xlsx`); add both new routes to the manifest set.
- [ ] **Step 4: Run to verify pass** (`pnpm backend:test` incl. manifest), lint.
- [ ] **Step 5: Commit** — `feat(backend): goldens routes — multipart exemplar upload (501 lift), unify, bind`

---

### Task 8: Copilot context

**Files:**
- Modify: `backend/runoff_api/services/queries.py`
- Create: `backend/tests/test_copilot_context.py`
- Reference: `apps/web/lib/queries.ts` `buildCopilotContext` (:250-end of function), `apps/web/test/copilotApi.test.ts` — the context-shape cases only (route cases land in Task 11; identify by what each case asserts, note the split)

**Interfaces:**
- Consumes: R1 db, R2 catalog service (whatever `catalog(db, projectId)` twin exists — grep `backend/runoff_api/services/` for the warehouse catalog builder and reuse).
- Produces: `build_copilot_context(db, blueprint_id, golden_cache: dict, scaffold_cache: dict) -> dict` — CopilotContext dict: `{"catalog": [...], "families": [FamilyInfo...], "defaultFiles": [EngineFile...], "periodFiles": [{"familyId", "period", "file"}...], "goldenCache": ..., "scaffoldCache": ...}` — copy the exact field set from `packages/engine/src/copilot.ts`'s `CopilotContext` interface (lines 72-90); FamilyInfo = `{"id", "key", "label", "kind", "granularity", "filedPeriods", "hasLiveFile", "bound"}`.

- [ ] **Step 1: Port the context cases** (seeded temp DB): families ordered by key with bound flags from `blueprint_families`; constant families → `filedPeriods: []` + `hasLiveFile` from null-period filed row; periodic → sorted filed periods, `hasLiveFile: False`; defaultFiles only for bound families (constant null-slot / periodic lexicographic-latest, EngineFile `id` = family id, `name` = label, path under files dir); periodFiles = every filed periodic row of bound families in period order.
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement statement-for-statement** (SQL strings and aliases verbatim from the TS).
- [ ] **Step 4: Run to verify pass**, lint.
- [ ] **Step 5: Commit** — `feat(backend): copilot context builder`

---

### Task 9: Copilot engine (a) — tools, system prompt, executeTool

**Files:**
- Create: `backend/runoff_api/engine/copilot.py`, `backend/tests/test_copilot_tools.py`
- Reference: `packages/engine/src/copilot.ts` lines 1-258 (constants, event/context interfaces, TOOLS, `fn`, `copilotSystemPrompt`, `activityLabel`) and 376-611 (`compact`, `renumber`, `familyLine`, `executeTool` and everything below it); `packages/engine/test/copilot.test.ts` — all cases EXCEPT the `copilotTurn` describe block (those are Task 10; list your split in the report); `packages/core/test/copilotTables.test.ts` (1 case — check whether R1's `test_types_copilot.py` already twinned it; skip if so)

**Interfaces:**
- Consumes: `engine.source_pack.build_source_pack`/`pack_for_prompt` (R2), `engine.catalog_format.serialize_catalog` (R2), `engine.prompts.MODEL`/`guidance_blocks` (R2), R1 BlueprintContent validation, core SQL result formatting (R1 `format_sql_result` twin — grep and reuse).
- Produces (this task): module constants `MAX_ITERATIONS = 12`, `MAX_TOOL_RESULT_CHARS = 10_100`; `TOOLS` (all 12 schemas verbatim); `copilot_system_prompt(draft, selected_key, memories, catalog) -> str`; `activity_label(name, args, families) -> str`; `execute_tool(name, args, state) -> dict` (`{"draft": dict, "result": str}`, `state` carrying `draft, default_pack, period_pack, ctx, io, actions` — mirror the TS signature); helpers `compact`, `renumber`, `family_line`.

- [ ] **Step 1: Port the non-turn cases** — tool executors: edit_section patch semantics (compact strips nulls, zod-strict validation, renumber), add_section afterKey insert/append + key collision behavior, remove_section, update_masthead, update_global_rules, update_section_queries; query_sources (family tree via `family_line`, familyId → pack sample, familyId+period → period pack keyed `{familyId}:{period}`, unknown → error strings verbatim); run_sql (`:period` binds latest filed period, result via SQL formatter, error passthrough); list_runs/get_run_section/list_goldens/get_golden/get_golden_scaffold (cache lookups + miss strings)/save_memory (emits `memory_saved`, appends action, inserts row — exactly as TS structures it); `activity_label` all 15 branches; system prompt byte-identity (draft embedded via `to_json`).
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement** lines 1-258 + 376-611 statement-for-statement. `structuredClone(draft)` → `copy.deepcopy`. Where `executeTool` validates via zod schemas, use the R1 core validation twins; error strings verbatim.
- [ ] **Step 4: Run to verify pass**, lint.
- [ ] **Step 5: Commit** — `feat(backend): copilot engine — tools, system prompt, executors`

---

### Task 10: Copilot engine (b) — the streaming turn loop

**Files:**
- Modify: `backend/runoff_api/engine/copilot.py`
- Create: `backend/tests/test_copilot_turn.py`
- Reference: `packages/engine/src/copilot.ts` lines 259-375 (`copilotTurn`), `packages/engine/test/copilot.test.ts` — the `copilotTurn` describe block (all cases)

**Interfaces:**
- Consumes: Task 9 surface, R2 fake client (streaming), `build_source_pack`.
- Produces: `copilot_turn(*, client, draft, selected_key, message, thread, memories, ctx, io) -> dict` (`{"reply", "actions", "draft"}`); `io` duck-type: `emit(event: dict)` with events `{"type": "text_delta", "text"}`, `{"type": "tool_activity", "label"}`, `{"type": "edit", "op"}`, `{"type": "memory_saved", "memoryId", "body"}` (terminal `done`/`error` are the ROUTE's job, not the engine's).

- [ ] **Step 1: Port the copilotTurn cases** (fake streaming client): text deltas accumulate + emit; tool-call fragment assembly by index (id/name first fragment only, arguments concatenated); finish without tool_calls → reply returned; tool round → assistant message with tool_calls appended, per-call: invalid-JSON args → `Invalid tool arguments — ignored.` tool message; `tool_activity` emit + action appended before execution; executor exception → `Tool error: <msg>`; result cap 10 100 (20 000 for get_golden_scaffold); iteration cap 12 then single exhaustion nudge `Tool budget for this turn is exhausted. Summarize what you have and finish your reply now.`; post-nudge tool_calls → hard stop, tools NOT executed; two source packs built once up front (default by family id, period pack keyed `{familyId}:{period}`).
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement statement-for-statement.** Request payload `{model, stream: True, messages, tools, max_completion_tokens: 8000}` in that key order (Task 12 byte-checks it). Message list: system prompt, thread rows as role/content, then the user message. `reply` = the final round's streamed text.
- [ ] **Step 4: Run to verify pass**, lint.
- [ ] **Step 5: Commit** — `feat(backend): copilot streaming turn loop`

---

### Task 11: Copilot SSE route

**Files:**
- Modify: `backend/runoff_api/api/blueprints.py` (POST beside the R1 GET), `backend/tests/test_api_manifest.py` (add copilot POST → 33)
- Create: `backend/tests/test_copilot_sse.py`
- Reference: `docs/api/v1.md` §2.13 POST + §3.2 (authoritative); TS `apps/web/app/api/blueprints/[id]/copilot/route.ts` POST; `apps/web/test/copilotApi.test.ts` — the route cases (the split noted in Task 8); spec §5

**Interfaces:**
- Consumes: Task 10 `copilot_turn`, Task 8 `build_copilot_context`, Task 3 (`list_golden_summaries` is NOT used here — the caches are: `resolve_golden` + `boundness_line`/`render_golden_for_prompt` for golden_cache, `scaffold_digest_for` for scaffold_cache), R1 `new_id`, R2 `make_llm_client`.
- Produces: `POST /api/v1/blueprints/{id}/copilot` → `StreamingResponse` (`text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`).

- [ ] **Step 1: Write tests** (engine seam mocked; TestClient streaming): pre-stream 400s in order (invalid JSON body / `message is required` for missing, non-string, and whitespace-only / `invalid draft`) as JSON not SSE; selectedKey non-string → None; thread+memories loaded BEFORE the user row insert (assert the engine received a thread that excludes the just-posted message); user row inserted with `new_id("cmsg")`; golden+scaffold caches built from every resolvable golden (description `<label> — <boundness_line>`, text `render_golden_for_prompt`, scaffold `scaffold_digest_for`; unresolvable goldens skipped); success: every emitted event framed `data: <to_json(event)>\n\n` in order, assistant row persisted (`body` = reply, `actions` JSON) BEFORE `{"type": "done", "messageId": <row id>}`, stream closes after; failure mid-turn: partial text + accumulated edit/memory actions persisted as `status='failed'` row, `{"type": "error", "message": <msg>}` terminal; memories query scope (blueprint + project of the blueprint, active only, rowid order).
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement per spec §5:** guards → loads → user insert → caches → context → `threading.Thread` running the turn with `emit = q.put` and its OWN `open_db` connection; thread persists the terminal row then puts the terminal event then a `None` sentinel; sync generator drains `queue.Queue` until sentinel, yielding frames; assistant `msg_id = new_id("cmsg")` created before the turn; text/edit/memory accumulation mirrors TS `io.emit` wrapper. Tolerate client disconnect (GeneratorExit) without killing the thread's persistence (the thread finishes its work regardless — it holds no reference to the response). Add the route to the manifest (33).
- [ ] **Step 4: Run to verify pass** (`pnpm backend:test`), lint.
- [ ] **Step 5: Commit** — `feat(backend): copilot SSE route — thread+queue streaming turn`

---

### Task 12: Prompt-fixture stages — copilot, bind, unify

**Files:**
- Modify: `scripts/dump-prompt-fixtures.ts`, `backend/tests/test_prompt_fixtures.py`
- Create (generated, committed): `backend/tests/fixtures/prompts/copilot.json`, `bind.json`, `unify.json`
- Reference: the existing four stages in both files (mechanism to replicate: canned inputs hard-coded in-script, recording fake client, deep-key-sorted `JSON.stringify(v, null, 2)`, transcribed identically into Python, unified-diff on mismatch), spec §7

- [ ] **Step 1: Extend `dump-prompt-fixtures.ts`.** Canned inputs hard-coded in the script: **copilot** — a 2-section BlueprintContent draft, selectedKey, a 2-message thread, memories of both scopes, a CopilotContext with 2 families (1 bound periodic with 1 filed period, 1 constant), one golden+scaffold cache entry built via the REAL `renderGoldenForPrompt`/`scaffoldDigestFor` over a canned resolved golden with a bound+mismatch inventory, empty file lists (`defaultFiles: []`, `periodFiles: []` — so `buildSourcePack` runs on empty input and no fs access happens); capture the FIRST `create()` params of `copilotTurn` (fake client returns a no-tool-call finish). **bind** — canned RunDocument (paragraph spans + one table), catalog, period, one sibling with a bound item, and TWO captures: `initial` (no prior/feedback) and `rebind` (priorInventory + feedback string); fixture = `{"initial": params, "rebind": params}`. **unify** — filename + a text > 24 000 chars (deterministic, e.g. a repeated literal) so the cap path is captured; fake returns valid document JSON. Write the three fixture files (with the Task 1 guard).
- [ ] **Step 2: Extend `test_prompt_fixtures.py`.** Transcribe the same canned inputs; run `copilot_turn` / `bind_golden` / `unify_golden_report` with recording fakes; deep-key-sort; assert byte-equality per stage.
- [ ] **Step 3: Run** — `pnpm backend:prompt-fixtures` then `uv --directory backend run pytest tests/test_prompt_fixtures.py -q` → all seven stages byte-identical. Any mismatch is a port bug: fix the port (TS wins), never the fixture.
- [ ] **Step 4: Commit** — `feat(parity): copilot/bind/unify prompt-payload fixtures byte-identical`

---

### Task 13: Eval twins, live arc, docs, ledger

**Files:**
- Create: `backend/evals/eval_copilot.py`, `backend/evals/eval_golden.py`
- Modify: root `package.json` (`backend:eval:copilot`, `backend:eval:golden`), `docs/api/v1.md`, `.superpowers/sdd/progress.md`
- Reference: `scripts/evalCopilot.ts`, `scripts/evalGolden.ts` (mirror structure + assertions), `backend/evals/eval_classify.py` (preflight/exit-code pattern), spec §8/§10/§12

- [ ] **Step 1: `eval_copilot.py`.** Mirror `evalCopilot.ts`: same seeded blueprint (`Quarterly Performance Report`), same request message, live client via env; build the context/caches through the REAL Python services against the seeded DB; assert ≥1 applied edit op in actions and a non-empty reply; exit 0/1/2/3 with the same preflight probe. package.json: `"backend:eval:copilot": "set -a; [ -f .env ] && . ./.env; set +a; RUNOFF_DB=$PWD/data/runoff.db RUNOFF_FILES_DIR=$PWD/data/files RUNOFF_WAREHOUSE_DIR=$PWD/data/warehouses uv --directory backend run python evals/eval_copilot.py"` (mirror whatever env prefix `evalCopilot.ts`'s runner and the existing eval lines actually use — copy the existing `backend:eval:*` pattern and add the data envs only if the TS eval script needs them too).
- [ ] **Step 2: `eval_golden.py`.** Mirror `evalGolden.ts`: seeded AR-review exemplar markdown → live `unify_golden_report` → live `bind_golden` against the seeded warehouse → `verify_inventory`; name-agnostic assertions (some bound numeric value equals the warehouse AR total within tolerance; boundness > 50%). Add the package.json line. Run both live → PASS (classify-style flake protocol: one retry sanctioned, note it).
- [ ] **Step 3: Live arc on :8400.** With `pnpm backend:dev` up: `curl -F` a real report file (e.g. a small markdown exemplar) to `POST /api/v1/blueprints/<seeded>/goldens` → verify response id, `unify_error` null, document + period + bindings populated in the DB; `POST .../bind` with `{"feedback": ...}` → 200 verified inventory; then `curl -N -X POST .../copilot` with a message asking to scaffold from that golden → tail the SSE: expect `tool_activity` incl. `scaffolding from golden <id>`, `edit` events, terminal `done`, and the assistant row persisted. Record ids/outputs in the report.
- [ ] **Step 4: Composed dev boot check.** `pnpm dev` (web + Python worker together): both boot, then one run enqueued from the web UI or via curl reaches `complete`. (Clears the R2 leftover.)
- [ ] **Step 5: Docs.** `docs/api/v1.md`: flip §2.13 POST/§2.14 multipart/§2.15/§2.16/§3.2 R3 markers to implemented; delete §4.1 and reword §4's intro to one wire divergence (§4.2) + PDF near-parity (§4.3); extend §4.3 with the exemplar-unify PDF caveat; update the closing "only R3-tagged endpoints remain unmounted" paragraph; drift-guard §5 count 30 → 33.
- [ ] **Step 6: Full gate.** `pnpm backend:test`, `pnpm backend:lint`, `pnpm test` (solo re-run protocol), `pnpm backend:diff`, `pnpm backend:parity`, `pnpm backend:prompt-fixtures` + fixture test green.
- [ ] **Step 7: Commit** — `feat(backend): R3 eval twins, live arc, contract flips`

---

## Self-Review

- **Spec coverage:** §2 decisions → Global Constraints + Tasks 12/13; §3 routes → Tasks 7/11 (+manifest 33); §4 port map → Tasks 2–11 (every row assigned; renderGoldenForPrompt in Task 3); §5 SSE design → Task 11; §6 route behavior → Task 7; §7 fixtures → Task 12; §8 evals → Task 13; §9 chores → Task 1 (all five; exclusions honored); §10 docs → Task 13; §12 criteria 1–8 → Tasks 12 (1), 13 (2,3,4,6,7), suite-wide gates (5), 1 (8). No gaps.
- **Placeholders:** none — every task names exact TS reference files/lines and "all N cases"; the only judgment calls (Task 5 pydantic error-text, Task 13 env prefix) state the resolution rule (assert format / copy existing pattern) and require a report note.
- **Type consistency:** `io.emit` event dicts match Task 10 ↔ 11; CopilotContext dict defined Task 8, consumed Tasks 9/10/11/12; `execute_tool` state signature Task 9 ↔ 10; `bind_exemplar`/`unify_and_bind_exemplar` signatures Task 6 ↔ 7; ScaffoldDigest Task 2 ↔ 3; manifest count staged 30→32 (Task 7) →33 (Task 11) consistently.
