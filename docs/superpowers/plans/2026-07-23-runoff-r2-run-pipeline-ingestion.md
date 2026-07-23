# Runoff R2 — Run Pipeline, Ingestion, SSE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the run pipeline (worker + LLM engine), sources/warehouse ingestion, and the run-events SSE endpoint to the Python backend, then cut the default run executor over to the Python worker.

**Architecture:** New `backend/runoff_api/engine/` (mirror of `packages/engine`) and `backend/runoff_api/worker/` (mirror of `apps/worker`) packages; extensions to R1's `core/warehouse.py`, `services/source_manager.py`, and routers. Two new deterministic cross-impl harnesses (prompt-payload fixtures, ingest-diff fixtures) plus live evals gate the cutover. All Python code is synchronous.

**Tech Stack:** Python ≥3.12 (uv), FastAPI, Pydantic v2, stdlib sqlite3, `openai` (Python SDK against CLIProxyAPI), `openpyxl`, `pypdf`, `python-multipart`; TS side only gains additive scripts.

**Spec:** `docs/superpowers/specs/2026-07-23-runoff-r2-run-pipeline-ingestion-design.md`

## Global Constraints

- **Porting Contract (R1, unchanged):** the named TS source file is the requirements document. Port statement-for-statement: same SQL strings and aliases, same branch structure, same error messages, same caps and regexes. TS tests are ported case-by-case with snake_cased names. On any disagreement between this plan and the TS source, **TS wins** — note the deviation in your report.
- **Plain-dict runtime:** documents/events/plans/catalogs flow as plain dicts with **camelCase keys**. Pydantic validates only where zod validates in TS. Serialize DB/wire JSON with `core.jsonutil.to_json` (`json.dumps(..., separators=(",", ":"), ensure_ascii=False)`). zod `z.number()` fields are `int | float`, never bare `float`.
- **Prompts are byte-identical** to the TS strings, including whitespace, newlines, and interpolation order. Never "improve" a prompt.
- **Sync only.** No asyncio anywhere in R2 code. TS `async` functions become plain Python functions; `await client.chat...` becomes the sync `openai` call; streaming uses the sync iterator; `io.sleep` is injected (worker passes `time.sleep`-based impl).
- **Model/env:** LLM base URL env `OPENAI_BASE_URL` default `http://localhost:8317/v1`, key env `OPENAI_API_KEY` default `"local"`, model env `RUNOFF_MODEL` default `"gpt-5.6-sol"`. Data env: `RUNOFF_DB`, `RUNOFF_FILES_DIR`, `RUNOFF_WAREHOUSE_DIR` (exact names, as in root `package.json` scripts).
- **Secrets:** the CLIProxyAPI key lives in git-ignored `.env` and must NEVER be committed or printed. `.env.example` carries only a placeholder. The repo is public.
- **Contract frozen:** route paths, status codes, error strings, and SSE framing come from `docs/api/v1.md` (§2.3–2.7, §2.22, §3.1) — copy strings from there/TS source, never invent.
- **DB schema frozen.** No DDL changes. The worker and routes use R1's `core.db.open_db`.
- **New Python deps exactly:** `openai`, `openpyxl`, `pypdf`, `python-multipart` (runtime); nothing else without a report note.
- **TS side is additive only** (scripts, fixtures, config values, package.json lines); no TS behavior changes except the Task 1 chores and the Task 14 `dev`-script cutover.
- Commands from repo root: `pnpm backend:test`, `pnpm backend:lint`; single backend test file: `uv --directory backend run pytest tests/test_x.py -q`.
- Python: snake_case defs, type hints on public signatures, module docstring pointing at the TS source file it ports.

## File Map

| Task | Creates | Modifies |
|---|---|---|
| 1 | — | `scripts/dump-parity-fixtures.ts`, `apps/web/vitest.config.ts`, `scripts/seed.ts` |
| 2 | `backend/runoff_api/engine/__init__.py`, `engine/llm.py`, `engine/prompts.py`, `backend/tests/fake_client.py`, `backend/tests/test_prompts.py`, `test_llm.py` | `backend/pyproject.toml` (openai) |
| 3 | `engine/tabular.py`, `backend/tests/test_tabular.py` | `backend/pyproject.toml` (openpyxl) |
| 4 | `engine/parse_plan.py`, `backend/tests/test_parse_plan_engine.py` | — |
| 5 | `engine/source_pack.py`, `engine/catalog_format.py`, `engine/run_data.py`, `backend/tests/test_source_pack.py`, `test_catalog_format.py`, `test_run_data_engine.py` | `backend/pyproject.toml` (pypdf) |
| 6 | `engine/draft.py`, `backend/tests/test_draft.py` | `engine/checks.py` (new file; see task), `backend/tests/test_checks_engine.py` |
| 7 | `engine/run.py`, `engine/distill.py`, `backend/tests/test_run_engine.py`, `test_distill.py` | — |
| 8 | `engine/classify.py`, `engine/propose_plan.py`, `backend/tests/test_classify.py`, `test_propose_plan.py` | — |
| 9 | `backend/tests/test_warehouse_write.py`, `test_source_manager_ingest.py` | `backend/runoff_api/core/warehouse.py`, `services/source_manager.py`, `backend/pyproject.toml` (python-multipart) |
| 10 | `backend/runoff_api/api/sources.py`, `backend/tests/test_sources_routes.py` | `backend/runoff_api/main.py`, `backend/tests/test_api_manifest.py` |
| 11 | `backend/tests/test_events_sse.py` | `backend/runoff_api/api/runs.py`, `backend/tests/test_api_manifest.py` |
| 12 | `backend/runoff_api/worker/__init__.py`, `worker/__main__.py`, `worker/run_loop.py`, `worker/resolve_sources.py`, `worker/run_data.py`, `backend/tests/test_run_loop.py`, `test_resolve_sources.py`, `test_worker_run_data.py`, `test_worker_memories.py` | root `package.json` (backend:worker) |
| 13 | `scripts/dump-prompt-fixtures.ts`, `scripts/dump-ingest-fixtures.ts`, `backend/tests/test_prompt_fixtures.py`, `test_ingest_parity.py`, fixtures under `backend/tests/fixtures/prompts/` and `.../ingest/` | root `package.json` (backend:prompt-fixtures, backend:ingest-fixtures) |
| 14 | `backend/evals/eval_classify.py`, `backend/evals/eval_parse.py` | `scripts/diff-api.ts`, `docs/api/v1.md`, root `package.json` (dev cutover, worker:ts, backend:eval:*) |

---

### Task 1: Harness chores (TS side)

**Files:**
- Modify: `scripts/dump-parity-fixtures.ts`, `apps/web/vitest.config.ts`, `scripts/seed.ts`
- Reference: `backend/tests/fixtures/` (the four R1 fixture JSONs), `.superpowers/sdd/progress.md` R1 final-review entry

Three independent chores; commit each separately.

- [ ] **Step 1: Null-overwrite guard.** In `scripts/dump-parity-fixtures.ts`, before writing each fixture file: if the data resolved for it is null/empty (e.g. the referenced run id no longer exists after a reseed) **and** the target file already exists with non-empty content, print a warning naming the fixture and skip the write; exit non-zero at the end if any fixture was skipped. Never write a fixture whose payload is null/empty. Test by running `pnpm backend:fixtures` twice (second run against current DB must still write all four or skip loudly), then `pnpm backend:test` — R1 fixture suites stay green.
- [ ] **Step 2: Commit** — `chore(scripts): backend:fixtures refuses to overwrite fixtures with empty dumps`
- [ ] **Step 3: Vitest flake chore.** In `apps/web/vitest.config.ts` raise `testTimeout` to 30000 and cap parallelism (`maxWorkers: 4` or pool options — match the config file's existing style). Run `pnpm test` twice; note any flakes (accepted protocol: solo re-run must pass).
- [ ] **Step 4: Commit** — `chore(web): raise vitest testTimeout and cap workers to stop machine-load flakes`
- [ ] **Step 5: Canned run in seed.** In `scripts/seed.ts`, after the existing seeding, insert one completed run for a seeded blueprint: a `runs` row (`status='complete'`, `document`, `stats`, timestamps) plus a realistic `run_events` log (run_started → source_read → per-section section_started/text_delta/section_completed → check events → render_started → run_completed) with correct `seq` ordering, built with the same helpers/SQL style the seed already uses. The document must be a valid RunDocument for the seeded blueprint's sections. Then verify the full regeneration path works from scratch: `rm -f data/runoff.db*`, `pnpm seed`, `pnpm backend:fixtures` (all four fixtures written, none skipped), `pnpm backend:test` green.
- [ ] **Step 6: Commit** — `feat(seed): bake a canned completed run so parity fixtures regenerate from scratch`

---

### Task 2: LLM client, prompts, fake client

**Files:**
- Create: `backend/runoff_api/engine/__init__.py` (empty marker), `backend/runoff_api/engine/llm.py`, `backend/runoff_api/engine/prompts.py`, `backend/tests/fake_client.py`, `backend/tests/test_prompts.py`, `backend/tests/test_llm.py`
- Modify: `backend/pyproject.toml` — add `openai` to dependencies
- Reference: `packages/engine/src/llm.ts`, `packages/engine/src/prompts.ts`, `packages/engine/test/prompts.test.ts`, `packages/engine/test/llm.test.ts`, `packages/engine/test/fakeClient.ts`

**Interfaces:**
- Produces: `make_llm_client() -> openai.OpenAI` (base_url `OPENAI_BASE_URL` default `http://localhost:8317/v1`, api_key `OPENAI_API_KEY` default `"local"`); `MODEL: str` (env `RUNOFF_MODEL`, default `"gpt-5.6-sol"`) — read at import, matching TS module-level `const`; `guidance_blocks(memories: list[dict]) -> str`; `system_prompt(content: dict, memories: list[dict] | None = None) -> str`; `section_user_prompt(**kwargs) -> str` (exact kwargs = the TS args object's fields).
- Produces (tests): `fake_client.make_fake_client(script) -> object` — sync port of `fakeClient.ts`: `client.chat.completions.create(**params)` returns, when `params.get("stream")`, a plain iterator of chunk objects; otherwise a blocking response object. Build chunks/responses as `types.SimpleNamespace` trees so attribute access (`chunk.choices[0].delta.content`, `.delta.tool_calls[0].function.arguments`, `.delta.refusal`, `.finish_reason`, and non-streaming `resp.choices[0].message.content/.refusal`) mirrors the openai SDK. Preserve the TS streaming semantics exactly: text word-split into one delta per word; toolUse arguments string split across fragments with `id` + `function.name` present ONLY on the first fragment; refusal stop → `delta.refusal`; final `finish_reason` `"stop"`/`"tool_calls"`. The `FakeTurn` dict keys mirror the TS interface (`text`, `toolUse` {`name`, `input`, `rawArguments`}, `stopReason`).

- [ ] **Step 1: Port the test cases** from `prompts.test.ts` and `llm.test.ts` (every case, snake_cased). Prompt tests assert exact output strings — copy the expected strings byte-for-byte from the TS tests.
- [ ] **Step 2: Run, confirm failure** — `uv --directory backend run pytest tests/test_prompts.py tests/test_llm.py -q`
- [ ] **Step 3: Implement.** `uv --directory backend add openai`. Port `llm.ts` and `prompts.ts` statement-for-statement; every template literal becomes an f-string with identical whitespace/newlines. Then write `fake_client.py` per the Produces block (it has no TS test file — `draft.test.ts`/`run.test.ts` exercise it; Task 6/7 will fail loudly if it drifts, but port it faithfully now from the `fakeClient.ts` doc-comment and code).
- [ ] **Step 4: Run to verify pass**, `pnpm backend:lint`.
- [ ] **Step 5: Commit** — `feat(backend): engine llm client + prompts + fake streaming client`

---

### Task 3: Tabular extraction

**Files:**
- Create: `backend/runoff_api/engine/tabular.py`, `backend/tests/test_tabular.py`
- Modify: `backend/pyproject.toml` — add `openpyxl`
- Reference: `packages/engine/src/tabular.ts` (all), `packages/engine/test/tabular.test.ts` (all cases), test fixtures it uses (`packages/engine/test/fixtures/spend.csv` etc. — reuse the same fixture files by path or copy them under `backend/tests/fixtures/tabular/`, whichever the ported tests need)

**Interfaces:**
- Produces: `is_tabular(mime: str, name: str) -> bool`; `slugify(name: str) -> str`; `detect_islands(...)` (exact TS signature); `csv_grid(path: str) -> list[list]`; `xlsx_grids(path: str) -> list[dict]` (`{"slug": str, "grid": list[list]}`); `scan_tabular(path: str, mime: str, name: str) -> dict` (TabularScan: `{"tables": [...], "skipped": [...]}` with DetectedTable dicts `{"slug", "columns", "rowCount", "sample"}`); `scan_sample(scan: dict) -> str`; `read_tabular(...)` (exact TS signature). TS `async` functions become plain sync functions.

- [ ] **Step 1: Port every case** in `tabular.test.ts` (snake_cased).
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement statement-for-statement.** openpyxl (`load_workbook(path, data_only=True)`) replaces ExcelJS. Grid cell parity notes: TS empty cells appear as `null`/`undefined` in the grid → Python `None`; ExcelJS returns JS `Date` for date cells and openpyxl returns `datetime` — everything downstream that stringifies cells must produce the same final strings (Task 13's ingest-diff harness is the byte-level referee; where `tabular.ts`/`parsePlan.ts` formats a date, match that exact output format for datetime input). `detectIslands` and `slugify` regex/loop structure verbatim.
- [ ] **Step 4: Run to verify pass**, lint.
- [ ] **Step 5: Commit** — `feat(backend): engine tabular — islands, grids, scan (openpyxl)`

---

### Task 4: Parse-plan execution

**Files:**
- Create: `backend/runoff_api/engine/parse_plan.py`, `backend/tests/test_parse_plan_engine.py`
- Reference: `packages/engine/src/parsePlan.ts` (all), `packages/engine/test/parsePlan.test.ts` (all cases), `packages/core/test/parsePlan.test.ts` (port any cases NOT already covered by R1's type tests — check `backend/tests/` first and skip duplicates, noting which)

**Interfaces:**
- Consumes: `engine.tabular.csv_grid`, `xlsx_grids` (Task 3); ParsePlan validation from R1 `core/types/parse_plan.py`.
- Produces: `norm_cell(v) -> str`; `raw_cell(v) -> str`; `load_grids(path: str, mime: str, name: str) -> list[dict]` (SheetGrid `{"sheet": str, "grid": list[list]}`); `execute_parse_plan(...)` returning ExecTable dicts `{"logical", "columns", "rows"}` (exact TS signature/return incl. the report shape); `coerce_cell(v, parse) -> dict` (`{"out": ..., "failed": bool}`, parse ∈ number/currency/percent/date/None); `derive_period(iso: str, granularity: str) -> str`; `fit_parse_plan(...)` (exact TS signature).

- [ ] **Step 1: Port every case** from both parsePlan test files (minus R1-covered duplicates).
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement statement-for-statement.** `coerce_cell` regexes and branch order verbatim (currency symbols, thousands separators, percent, date parsing — match TS output values exactly, including how numbers round-trip: JS `parseFloat` semantics were solved in R1, reuse `core` helpers if they exist rather than reimplementing). `derive_period` month/quarter/year math verbatim. `execute_parse_plan` unpivot/coercion/skip-count behavior verbatim.
- [ ] **Step 4: Run to verify pass**, lint.
- [ ] **Step 5: Commit** — `feat(backend): engine parse-plan execution — loadGrids, coerce, fit, derivePeriod`

---

### Task 5: Source pack, catalog format, engine run data

**Files:**
- Create: `backend/runoff_api/engine/source_pack.py`, `backend/runoff_api/engine/catalog_format.py`, `backend/runoff_api/engine/run_data.py`, `backend/tests/test_source_pack.py`, `backend/tests/test_catalog_format.py`, `backend/tests/test_run_data_engine.py`
- Modify: `backend/pyproject.toml` — add `pypdf`
- Reference: `packages/engine/src/sourcePack.ts`, `catalogFormat.ts`, `runData.ts`; tests `sourcePack.test.ts`, `catalogFormat.test.ts`, `runData.test.ts` (all cases)

**Interfaces:**
- Consumes: `engine.tabular` (Task 3).
- Produces: `build_source_pack(files: list[dict]) -> dict` (EngineFile dicts `{"id","label","path","mime","name"}` — copy exact field set from the TS interface; SourcePack dict mirrors TS); `extract_file_text(file: dict) -> str`; `pack_for_prompt(pack: dict, source_ids: list[str]) -> str`; `cell_text(v) -> str`; `cell_value(v) -> str | int | float`; `serialize_catalog(families: list[dict]) -> str`; `section_data_block(section: dict, data: dict, pack: dict) -> str` and the RunData dict shape (copy field-for-field from `runData.ts`'s `RunData` interface).

- [ ] **Step 0: Dedup check.** `grep -rn "serialize_catalog\|serializeCatalog" backend/` — if R1 already ported it (e.g. inside `warehouse_catalog.py` or golden services), import/reuse instead of creating `catalog_format.py`, and note it.
- [ ] **Step 1: Port every case** from the three TS test files.
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement statement-for-statement.** PDF: `extract_file_text` uses `pypdf.PdfReader(path)` and joins `page.extract_text()` — this is the ONE sanctioned near-parity divergence (spec §6): output text may differ from pdf-parse; tests for the PDF branch assert Python-side behavior (non-empty text, truncation caps applied), not TS byte-equality. Everything tabular-derived (`cell_text`, `cell_value`, sample tables in pack text) stays byte-exact — these feed prompts. Truncation caps and summary formats verbatim.
- [ ] **Step 4: Run to verify pass**, lint.
- [ ] **Step 5: Commit** — `feat(backend): engine source pack (pypdf), catalog format, run data block`

---

### Task 6: Checks (run-side) and draft

**Files:**
- Create: `backend/runoff_api/engine/checks.py`, `backend/runoff_api/engine/draft.py`, `backend/tests/test_checks_engine.py`, `backend/tests/test_draft.py`
- Reference: `packages/engine/src/checks.ts` (`evaluateAssert`, `auditCitations`, `countCitations` — NOT `compileLocator`, which R1 ported into `services/golden_binding.py`), `packages/engine/src/draft.ts` (all), tests `checks.test.ts` (the three functions' cases; `compileLocator` cases are already ported — skip), `draft.test.ts` (all cases)

**Interfaces:**
- Consumes: `engine.prompts` (Task 2), `tests/fake_client.py` (Task 2), R1 `core.dialect.parse_section_text`.
- Produces: `evaluate_assert(rule: dict, data: dict) -> dict` (`{"pass": bool, "detail": str}` — if `pass` clashes as a name use the dict key `"pass"` regardless), `audit_citations(blocks: list, data: dict, family_ids: list[str]) -> dict` (`{"pass": bool, "failures": list[str]}`), `count_citations(blocks: list) -> int`; `class RefusalError(Exception)` with the TS message; `draft_section(*, client, content, section, data_block, completed, steers, answers, retry_feedback=None, previous_section_text=None, memories, cb) -> dict` (DraftResult mirror), `cb` an object/dict with `on_delta(text)`, `on_question(q)`, `on_flag(f)` (mirror `DraftCallbacks`).
- `engine/checks.py` imports `compile_locator` FROM `services/golden_binding.py` if it needs it (do not move or duplicate it).

- [ ] **Step 1: Port the test cases** (checks: all evaluateAssert/auditCitations/countCitations cases; draft: all, driving `make_fake_client` scripts mirroring the TS test scripts).
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement statement-for-statement.** `draft.py`: sync streaming loop over `client.chat.completions.create(stream=True, ...)` chunks — text deltas → `cb.on_delta`; tool-call fragment assembly (arguments accumulate across fragments keyed by index; name/id only on first) exactly as TS; tool dispatch (question/flag tools), refusal → `RefusalError`; the request payload (model, messages, tools, params) field-for-field identical to TS — Task 13's prompt fixtures will byte-check this, so build the params dict in the same key order/content as the TS object literal.
- [ ] **Step 4: Run to verify pass**, lint.
- [ ] **Step 5: Commit** — `feat(backend): engine run checks + streaming section draft`

---

### Task 7: Run orchestrator and distillation

**Files:**
- Create: `backend/runoff_api/engine/run.py`, `backend/runoff_api/engine/distill.py`, `backend/tests/test_run_engine.py`, `backend/tests/test_distill.py`
- Reference: `packages/engine/src/run.ts` (all — the 9-rule orchestrator), `packages/engine/src/distill.ts` (all); tests `run.test.ts`, `distill.test.ts` (all cases)

**Interfaces:**
- Consumes: Tasks 2–6 surface (`draft_section`, `RefusalError`, `evaluate_assert`, `audit_citations`, `count_citations`, `build_source_pack`, `section_data_block`, prompts) plus R1 `core.dialect.parse_section_text` and core word/plaintext helpers (`count_words`, `blocks_to_plain_text` — R1 ported these with the reducer/dialect; grep `backend/runoff_api/core/` and reuse; if either is genuinely absent, port it into `core/` from `packages/core` and note it).
- Produces: `execute_run(*, client, content, files, data, io, blueprint_rev, previous_document=None, memories=None, period=None, gaps=None) -> dict` (`{"document": ..., "stats": ...}`); `io` is duck-typed with `emit(event: dict)`, `poll_inputs() -> list[dict]` (RunInputMsg dicts `{"kind", "text", "questionId"}`), `sleep(ms: float)`; `distill_run(*, client, title, section_headings, interactions, existing) -> list[dict]` (DistilledMemory `{"body", "scope"}`).

- [ ] **Step 1: Port every case** from `run.test.ts` (fake client + scripted io; mirror the TS test harness including its fake `sleep`) and `distill.test.ts`.
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement `run.py` statement-for-statement** — all nine rule blocks in TS order: run_started emit (conditional `memoryIds`/`period`/`gaps` keys only when non-empty, exactly as the TS spreads), source pack + source_read emits, section loop in `number` order, drain/pause-resume/steer/answer handling, question fallbacks (`Assume: {fallback}` steer + event), fixed sections (no model call), draft with callbacks, single retry on check failure then flag-and-keep (exact flag question strings), review-mode flag, refusal containment (section_failed + continue), render_started, document/stats assembly (all 8 stat fields), run_failed emit + re-raise. Timing: TS `Date.now()` deltas → `time.time()*1000` ints for `ms`/`durationMs`. Then `distill.py` verbatim (prompt built via its TS template).
- [ ] **Step 4: Run to verify pass**, lint.
- [ ] **Step 5: Commit** — `feat(backend): engine run orchestrator + memory distillation`

---

### Task 8: Ingestion LLM stages — classify and propose plan

**Files:**
- Create: `backend/runoff_api/engine/classify.py`, `backend/runoff_api/engine/propose_plan.py`, `backend/tests/test_classify.py`, `backend/tests/test_propose_plan.py`
- Reference: `packages/engine/src/classify.ts`, `packages/engine/src/proposePlan.ts`; tests `classify.test.ts`, `proposePlan.test.ts` (all cases)

**Interfaces:**
- Consumes: `engine.llm.MODEL`, fake client, `engine.parse_plan` (`execute_parse_plan` for plan-fit checks), R1 ParsePlan validation.
- Produces: `classify_source(*, client, filename, content_sample, families) -> dict | None` (family dicts `{"key","label","kind","granularity"}`); `build_grid_sample(grids: list[dict], hints: str) -> str`; `propose_parse_plan(...) -> ...` (exact TS signature — including however the TS handles the replan/amend-with-feedback variant; port whatever parameters exist in the source); `is_degenerate(report: dict) -> bool`.

- [ ] **Step 1: Port every case** from both test files.
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement statement-for-statement** — prompts byte-identical; request payloads field-for-field (non-streaming `create` calls; JSON parsing/validation of the model reply and every fallback branch verbatim).
- [ ] **Step 4: Run to verify pass**, lint.
- [ ] **Step 5: Commit** — `feat(backend): engine classify + parse-plan proposal`

---

### Task 9: Warehouse write side and source manager

**Files:**
- Modify: `backend/runoff_api/core/warehouse.py` (extend — R1 read side stays untouched), `backend/runoff_api/services/source_manager.py` (extend — `list_project_sources` stays), `backend/pyproject.toml` (python-multipart)
- Create: `backend/tests/test_warehouse_write.py`, `backend/tests/test_source_manager_ingest.py`
- Reference: `packages/core/src/warehouse.ts` (write side: `warehouseDir`, `warehousePath`, `attachWarehouse`, `detachWarehouse`, `whFamilyTables`, `computeDrift`, `applySchema`, `deleteRows`, `insertRows`, plus `readWarehouseTables` if R1 skipped it), `apps/web/lib/sourceManager.ts` (rest: `withIngestLock`, `tableNamesFor`, `fileSource`, `readContentSample`); tests `packages/core/test/warehouse.test.ts` (write-side cases not ported in R1 — check `backend/tests/test_warehouse.py` and skip duplicates, noting which), `apps/web/test/sourceManager.test.ts` (all cases; `sourceManager.ui.test.tsx` is UI — skip)

**Interfaces:**
- Consumes: R1 `core.warehouse` read side, `core.db`, `engine.tabular`/`engine.parse_plan` (Tasks 3–4) for the ingest path.
- Produces: `warehouse_dir() -> str`, `warehouse_path(project_id: str) -> str`, `attach_warehouse(conn, project_id)`, `detach_warehouse(conn)`, `wh_family_tables(conn, family_key) -> list[dict]`, `compute_drift(existing, incoming) -> list[str]`, `apply_schema(conn, periodic: bool, incoming)`, `delete_rows(conn, tables, period)`, `insert_rows(conn, table, columns, rows, period)`; `with_ingest_lock(fn)` (module-level `threading.Lock`), `table_names_for(family_key, slugs) -> dict`, `file_source(db, args: dict) -> dict` (`{"ok": True}` or `{"error": str, "status": int}` — exact TS error strings/statuses; the contract §2.3/2.6 lists them), `read_content_sample(...)` (exact TS signature).

- [ ] **Step 1: Port the test cases** (warehouse write-side + sourceManager, snake_cased; sourceManager tests run against a temp DB + temp `RUNOFF_FILES_DIR`/`RUNOFF_WAREHOUSE_DIR` via monkeypatched env, mirroring the TS test setup).
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement statement-for-statement.** `ATTACH DATABASE`/`DETACH` SQL strings verbatim; `apply_schema` DDL construction (periodic period column, drop/recreate rules) verbatim; `compute_drift` message strings verbatim; `insert_rows` batching verbatim. `file_source` ports the full flow: save the uploaded bytes under `RUNOFF_FILES_DIR`, source row insert/update, slot/family handling, ingest into the warehouse via the parse-plan path — follow the TS call graph exactly.
- [ ] **Step 4: Run to verify pass** (including R1 `test_warehouse.py` untouched-green), lint.
- [ ] **Step 5: Commit** — `feat(backend): warehouse write side + source manager ingest path`

---

### Task 10: Sources routes

**Files:**
- Create: `backend/runoff_api/api/sources.py`, `backend/tests/test_sources_routes.py`
- Modify: `backend/runoff_api/main.py` (mount router), `backend/tests/test_api_manifest.py` (add `R2_SOURCES_ROUTES`)
- Reference: `docs/api/v1.md` §2.3–2.7 (authoritative for paths/statuses/error strings), TS handlers `apps/web/app/api/projects/[id]/sources/route.ts` (POST), `.../sources/[sourceId]/route.ts` (PATCH, DELETE), `.../sources/classify/route.ts`, `.../sources/confirm/route.ts`, `.../sources/[sourceId]/replan/route.ts`

**Interfaces:**
- Consumes: Task 9 (`file_source`, `with_ingest_lock`, `read_content_sample`, warehouse write), Task 8 (`classify_source`, `propose_parse_plan`), Task 3–4 (scan/load), R1 `deps.get_db`/`err`, `make_llm_client` (Task 2) — construct the client per-request exactly where the TS handler does.
- Produces: router mounted in `main.py` under the same prefix style as R1 routers; six handlers (POST multipart, PATCH, DELETE, classify, confirm, replan).

- [ ] **Step 1: Port route tests.** Cover, per contract: happy paths (multipart upload with a real small fixture file via TestClient `files=`, PATCH/DELETE effects, confirm building the warehouse) and every documented error (unknown project/source 404 strings, validation 400 strings, `fileSource` `{status, error}` pass-through). LLM handlers (classify, replan) are tested with the fake client injected the same way the TS tests do it — if the TS routes construct the client inline, add the same seam the TS code has (env-pointed client) and test the non-LLM error paths only, noting that live coverage lands in Task 14.
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement** each handler statement-for-statement from its TS route file; body parsing/validation and response shapes per contract. Add the six routes to `test_api_manifest.py` as `R2_SOURCES_ROUTES` and include them in the required set.
- [ ] **Step 4: Run to verify pass** (`pnpm backend:test` — manifest test green), lint.
- [ ] **Step 5: Commit** — `feat(backend): sources routes — upload, patch/delete, classify, confirm, replan`

---

### Task 11: Run-events SSE route

**Files:**
- Modify: `backend/runoff_api/api/runs.py`, `backend/tests/test_api_manifest.py` (add the events route)
- Create: `backend/tests/test_events_sse.py`
- Reference: `docs/api/v1.md` §3.1 (authoritative framing), `apps/web/app/api/runs/[id]/events/route.ts`

**Interfaces:**
- Consumes: R1 `deps.get_db`.
- Produces: `GET /api/v1/runs/{id}/events` → `StreamingResponse` (`text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`) from a **sync generator**. Module-level constants `EVENTS_POLL_SECONDS = 0.2` and `EVENTS_HEARTBEAT_EVERY = 75` so tests can monkeypatch them.

- [ ] **Step 1: Write tests** against the contract: (a) finished run → connect replays the entire log as `data: <payload>\n\n` frames in seq order and the stream ends after the `run_completed` frame; (b) payloads are the raw stored JSON (byte-compare against the rows); (c) heartbeat `: ping\n\n` appears when idle (monkeypatch `EVENTS_HEARTBEAT_EVERY = 1`, `EVENTS_POLL_SECONDS = 0.01`, run with no terminal event, read a few frames, then close); (d) unknown run id → stream stays open and heartbeats (read one heartbeat, close); (e) `run_failed` also terminates. Use `TestClient.stream("GET", ...)` with `iter_raw()`/line iteration.
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement** per §3.1: `last = 0`; loop: select `seq, type, payload FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq`, yield each payload frame, advance `last`; break after a batch containing `run_completed`/`run_failed`; every 75th iteration yield `: ping\n\n`; sleep `EVENTS_POLL_SECONDS` between iterations. The generator must tolerate client disconnect (GeneratorExit) silently. Add the route to the manifest test.
- [ ] **Step 4: Run to verify pass**, lint.
- [ ] **Step 5: Commit** — `feat(backend): run-events SSE endpoint`

---

### Task 12: Worker process

**Files:**
- Create: `backend/runoff_api/worker/__init__.py`, `worker/__main__.py`, `worker/run_loop.py`, `worker/resolve_sources.py`, `worker/run_data.py`, `backend/tests/test_run_loop.py`, `test_resolve_sources.py`, `test_worker_run_data.py`, `test_worker_memories.py`
- Modify: root `package.json` — add `backend:worker`
- Reference: `apps/worker/src/runLoop.ts`, `resolveSources.ts`, `runData.ts`, `index.ts`; tests `apps/worker/test/runLoop.test.ts`, `resolveSources.test.ts`, `runData.test.ts`, `memories.test.ts` (all cases; `previousRun.test.ts` was R1 — check `backend/tests/` and skip duplicates)

**Interfaces:**
- Consumes: `engine.run.execute_run`, `engine.distill.distill_run` (Task 7), `engine.llm.make_llm_client` (Task 2), R1 `core.db.open_db`, `core.previous_run.previous_completed_document`, `core.ids.new_id`, BlueprintContent validation (R1 types), `worker.run_data.build_run_data` (below).
- Produces: `claim_queued_run(db) -> dict | None` (CLAIM_SQL byte-copied incl. aliases); `make_engine_io(db, run_id)` returning an object with `emit`/`poll_inputs`/`sleep` satisfying Task 7's `io` protocol; `fail_stale_runs(db) -> int`; `process_one(db, client) -> bool`; `resolve_run_sources(db, blueprint_id, period) -> dict` (`{"files": [...], "gaps": [...]}` — EngineFile dicts per Task 5); `build_run_data(db, project_id, bound_family_ids, period) -> dict` (RunData per Task 5).

- [ ] **Step 1: Port every case** from the four worker test files (fake engine/client seams mirroring the TS tests).
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement statement-for-statement.** `make_engine_io.emit`: `conn.execute("BEGIN IMMEDIATE")` then MAX(seq)+1 select, event insert, and the per-type mirror (flag row id `f"{run_id}_{flag_id}"`, paused/resumed status, complete with stats+document via `to_json`, failed) in one commit; on exception, rollback and re-raise. `poll_inputs` drains + marks consumed. `fail_stale_runs` emits `run_failed` "worker restarted mid-run". `process_one`: claim → revision load (validate via BlueprintContent) → `resolve_run_sources` → project id → bound family ids (deduped, TS `Set` order = first-seen) → `build_run_data` → previous document → memories query (SQL verbatim) → `execute_run` → `distill_completed_run`; catch-all marks failed only if not already failed (SQL verbatim). `distill_completed_run` + `enforce_memory_cap(db, scope)` (cap 30, oldest-active disabled) verbatim, distillation errors swallowed+logged. `__main__.py`: `open_db(os.environ.get("RUNOFF_DB", "data/runoff.db"))`, boot recovery print, loop `process_one` else sleep 0.25; on escaping error, log + sleep 1.0. package.json: `"backend:worker": "set -a; [ -f .env ] && . ./.env; set +a; RUNOFF_DB=$PWD/data/runoff.db RUNOFF_FILES_DIR=$PWD/data/files RUNOFF_WAREHOUSE_DIR=$PWD/data/warehouses uv --directory backend run python -m runoff_api.worker"`.
- [ ] **Step 4: Run to verify pass**, lint.
- [ ] **Step 5: Commit** — `feat(backend): python worker — claim loop, engine IO, distillation`

---

### Task 13: Prompt-payload and ingest-diff fixture harnesses

**Files:**
- Create: `scripts/dump-prompt-fixtures.ts`, `scripts/dump-ingest-fixtures.ts`, `backend/tests/test_prompt_fixtures.py`, `backend/tests/test_ingest_parity.py`; generated fixtures under `backend/tests/fixtures/prompts/*.json` and `backend/tests/fixtures/ingest/*.json` (committed)
- Modify: root `package.json` — `"backend:prompt-fixtures": "tsx scripts/dump-prompt-fixtures.ts"`, `"backend:ingest-fixtures": "tsx scripts/dump-ingest-fixtures.ts"`
- Reference: spec §5–§6; `scripts/dump-parity-fixtures.ts` (style + Task 1's null-overwrite guard — replicate it); TS stages `draftSection`, `classifySource`, `proposeParsePlan` (+ its replan variant), `distillRun`; fixture files `scripts/fixtures/ga4_export.csv`, `spend_june.csv`, `ar_aging_q2_2026.xlsx`, `regional_summary.xlsx`

**Interfaces:**
- Consumes: Python stages from Tasks 6–8 and the ingest path from Tasks 3–4 + 9.

- [ ] **Step 1: `dump-prompt-fixtures.ts`.** Hard-code canned inputs IN the script (a small BlueprintContent with 2 sections, one completed section, one steer, one answer, memories of both scopes, a data block from a tiny RunData, a retry-feedback string; classify inputs = the `evalClassify.ts` family list + a fixed content sample string; propose inputs = a small grid + hints, and a replan variant with feedback; distill inputs = a small interactions/existing set). Recording fake client: `create(params)` pushes `params` onto a list and returns a minimal scripted response (reuse `packages/engine/test/fakeClient.ts`). For each stage write `backend/tests/fixtures/prompts/<stage>.json` = the array of captured `params` objects, `JSON.stringify(v, null, 2)` with **deep-key-sorted objects** (same sort helper style as `diff-api.ts`).
- [ ] **Step 2: `test_prompt_fixtures.py`.** Recreate the identical canned inputs in Python (transcribe values exactly), run each Python stage with a recording fake client, deep-key-sort, and assert equality with the fixture JSON. Any mismatch prints a unified diff of the two payloads.
- [ ] **Step 3: Run dump + test** — `pnpm backend:prompt-fixtures` then `uv --directory backend run pytest tests/test_prompt_fixtures.py -q` → all stages byte-identical.
- [ ] **Step 4: Commit** — `feat(parity): prompt-payload fixtures — TS/PY request bodies byte-identical`
- [ ] **Step 5: `dump-ingest-fixtures.ts`.** For each of the four `scripts/fixtures/` files: hard-code a canned ParsePlan IN the script (write a real, working plan per file — derive it by running the TS scan/propose flow ONCE manually if needed, then freeze the plan literal); run the real TS path `loadGrids` → `executeParsePlan` → `applySchema` + `insertRows` into a fresh temp SQLite file; dump every produced table as `{name, columns (schema), rows (all, ordered by rowid)}` to `backend/tests/fixtures/ingest/<basename>.json` (key-sorted, same guard).
- [ ] **Step 6: `test_ingest_parity.py`.** Same four files + the SAME canned plans (transcribed) through Python `load_grids` → `execute_parse_plan` → `apply_schema`/`insert_rows` into a temp DB; dump identically; assert **exact** equality (no approx — spec's byte bar; if a float repr differs, that is a finding to fix in the port, not in the test).
- [ ] **Step 7: Run dump + test**, lint both sides (`pnpm backend:lint`, TS typecheck via existing repo command).
- [ ] **Step 8: Commit** — `feat(parity): ingest-diff fixtures — identical warehouse tables from identical files`

---

### Task 14: Live verification, evals, diff extension, cutover, docs

**Files:**
- Create: `backend/evals/eval_classify.py`, `backend/evals/eval_parse.py`
- Modify: `scripts/diff-api.ts` (sources coverage), `docs/api/v1.md` (phase notes + §4 PDF divergence), root `package.json` (`backend:eval:classify`, `backend:eval:parse`, `worker:ts`, `dev` cutover), `.superpowers/sdd/progress.md`
- Reference: `scripts/evalClassify.ts`, `scripts/evalParse.ts` (mirror assertions), spec §8–§9, `docs/api/v1.md` §4

- [ ] **Step 1: Python evals.** `eval_classify.py`: same ga4 fixture sample, same family list, live client (env-configured), expect a non-null valid proposal; exit 1 otherwise. `eval_parse.py`: the AR-aging xlsx through Python scan → `propose_parse_plan` → `execute_parse_plan`, mirroring `evalParse.ts`'s name-agnostic assertions (row counts, sums, non-degenerate). package.json: `"backend:eval:classify": "set -a; [ -f .env ] && . ./.env; set +a; uv --directory backend run python evals/eval_classify.py"` (same pattern for parse). Run both live → PASS.
- [ ] **Step 2: diff-api sources coverage.** Extend `scripts/diff-api.ts` with the sources GET(s) for the seeded project so post-ingestion source state is diffed TS↔PY. Run `pnpm backend:diff` → zero diffs.
- [ ] **Step 3: Live ingestion smoke (Python only).** With `pnpm backend:dev` up: multipart-upload `scripts/fixtures/spend_june.csv` and `ar_aging_q2_2026.xlsx` via `curl -F` to the Python API → classify → confirm; verify via GET sources + a warehouse SQL probe that tables exist and row counts match the ingest fixtures. Record ids/outputs in the report.
- [ ] **Step 4: Live run smoke (Python worker).** Stop the TS worker; start `pnpm backend:worker`. Enqueue ≥3 runs via the Python API on the seeded blueprints: (a) one plain to `complete`; (b) one with a steer posted mid-run (POST the run input via the existing R1 endpoint) — verify `steer_received` in events; (c) one that raises a flag (review-mode section or failing check) — verify flag row + event. Tail one run live: `curl -N http://localhost:8400/api/v1/runs/<id>/events` — verify framing (data frames, heartbeat, terminal close). All three runs must reach `complete` with documents.
- [ ] **Step 5: Cutover.** package.json: add `"worker:ts"` preserving the current TS worker invocation from `dev`; change `dev`'s worker half to the Python worker (same concurrently structure, env unchanged). Full gate re-run: `pnpm backend:test`, `pnpm backend:lint`, `pnpm test` (solo re-run protocol for known flakes), `pnpm backend:diff`, `pnpm backend:parity`.
- [ ] **Step 6: Docs.** `docs/api/v1.md`: flip the seven R2 routes' phase notes to implemented; add the §4 PDF-extraction near-parity divergence note (pypdf vs pdf-parse — affects `source_read.summary`/prompt text for PDF sources only). Update `§5`-style mounting notes if they mention R2 as unmounted.
- [ ] **Step 7: Commit** — `feat(backend): R2 live verification, python evals, worker cutover, contract notes`

---

## Self-Review

- **Spec coverage:** §2 decisions → Global Constraints + Tasks 12/13/14; §3.1 routes → Tasks 10/11; §3.2 worker → Task 12; §4 port map → Tasks 2–12 (every row assigned); §5 → Task 13 steps 1–4; §6 → Tasks 3/4/9 + 13 steps 5–8 + §4-note in Task 14; §7 → Tasks 6/7/11/12; §8 layers → suites (2–12), fixtures (13), live (14); §9 scripts → Tasks 12/13/14; §10 chores → Task 1; §11 docs → Task 14; §12 boundaries → constraints; §13 criteria → Tasks 13/14 gates. No gaps found.
- **Placeholders:** none — tasks without inline code carry exact reference files + "all cases" scope per the Porting Contract (the R1-proven pattern); the only "derive it manually" step (Task 13 canned plans) specifies the freeze-the-literal procedure.
- **Type consistency:** `io` protocol (emit/poll_inputs/sleep) matches Tasks 7↔12; EngineFile/RunData dicts defined in Task 5, consumed in Tasks 7/12; `file_source` return shape matches contract pass-through in Task 10; fake-client surface defined in Task 2, consumed in 6/7/8/13.
