# Runoff v1 — Design Spec

**Date:** 2026-07-18
**Status:** Approved by Louis (brainstorming session)
**Design reference:** `design_handoff_runoff_app/` — "Manuscript" design language, high-fidelity, recreate faithfully.

## 1. Goal & scope

Runoff automates recurring document generation with LLM agents: **Blueprint** (sections, instructions, rules, output format) **+ Data** (uploaded file sources) **+ Agent** (drafts, checks, cites, flags) **→ Run** (a sourced, checked document).

**V1 goal: a real working tool** — a functional end-to-end app used to generate real documents with a real LLM agent. First concrete use case: a recurring client performance report (the handoff's "Monthly Performance Report" for Meridian Retail scenario).

### In scope (v1)

- All five surfaces from the design handoff: **Library, Blueprint Builder, Live Run, Reader, Sources** (+ add-source modal).
- Real run engine with all four signature agent behaviors:
  1. **Cited drafting** — section-by-section drafting from blueprint + sources, with citation chips tying figures to sources.
  2. **Checks & flags** — blueprint rules/assertions evaluated per section; flagged passages block "release" until cleared in the Reader.
  3. **Mid-run questions** — the agent can pause on ambiguity, ask with a fallback, and continue.
  4. **Margin-note editing** — conversational blueprint refinement in the Builder; agent proposes red-pencil edits the user accepts/revises.
- Source kind: **file upload only** (CSV, XLSX, PDF, DOCX). Other kinds appear in the UI but are disabled.
- PDF export via print stylesheet.

### Deferred (not dropped)

Scheduling (cadence is a display label; runs are manual), email delivery, DOCX export, run-vs-run compare, drop-a-PDF blueprint reverse-engineering, SaaS/API/database/web-research sources, auth/multi-tenancy.

### Success criteria

Build a Monthly Performance Report blueprint from scratch, upload CSVs/PDF, watch a real run draft it with citations and checks, answer or skip a mid-run question, clear flags in the Reader, print a clean PDF.

## 2. Architecture

**App + worker** (user's choice), coordinated entirely through SQLite:

```
runoff/
  apps/web/        # Next.js app — five surfaces + HTTP API + SSE
  apps/worker/     # Node process — claims queued runs, executes the engine
  packages/core/   # DB schema (Drizzle + SQLite), blueprint & document types, run-event types
  packages/engine/ # Run engine — Anthropic SDK; no HTTP/React knowledge
```

- pnpm workspaces, TypeScript throughout.
- SQLite in WAL mode at `data/runoff.db`; uploaded files on disk under `data/files/`.
- **Run lifecycle:** web writes a `runs` row with status `queued` → worker polls (~250 ms), claims it, executes → every step appends a typed row to `run_events` → web's SSE endpoint tails that table and streams to the browser. Live Run is a pure projection of the event log.
- **User → engine during a run:** `run_inputs` table (pause/resume/steer/answer); the engine checks it between steps.
- Benefits: run history, crash recovery, and the Reader's run-report numbers come from the event log for free. The engine package could later move behind a queue/worker fleet without touching the UI.

## 3. Data model (Drizzle + SQLite)

| Table | Key fields | Notes |
|---|---|---|
| `blueprints` | id, name, client_name, cadence_label, status (`draft`/`active`), current_rev | Library ledger rows |
| `blueprint_revisions` | id, blueprint_id, rev, content JSON, created_at | Append-only. Full blueprint content per revision (sections live inside the JSON — makes REV n, diff, revert trivial) |
| `sources` | id, name, kind (`file`), stored_filename, mime, size, uploaded_at, refreshed_at | Freshness/stale display derives from timestamps |
| `blueprint_sources` | blueprint_id, source_id | Binding |
| `runs` | id, blueprint_id, blueprint_rev, trigger, status (`queued`/`running`/`paused`/`complete`/`failed`), started_at, finished_at, stats JSON, document JSON | `document` = materialized final AST so the Reader never replays events |
| `run_events` | id, run_id, seq, type, payload JSON, created_at | Append-only event log |
| `run_inputs` | id, run_id, kind (`pause`/`resume`/`steer`/`answer`), payload JSON, created_at, consumed_at | User → engine channel |
| `flags` | id, run_id, code (F1…), section_key, question, options JSON, status (`open`/`resolved`), resolution JSON, created_at | Authoritative flag state; resolutions also logged as events. All-resolved ⇒ report "released" |
| `notes` | id, blueprint_id, section_key, author (`user`/`agent`), body, proposed_edit JSON nullable, status (`open`/`resolved`), created_at | Builder margin threads |

Run event types (minimum): `run_started`, `source_read`, `section_started`, `text_delta`, `section_completed`, `check_passed`, `check_failed`, `retry_started`, `question_raised`, `question_answered`, `question_fallback_applied`, `flag_raised`, `steer_received`, `paused`, `resumed`, `render_started`, `run_completed`, `run_failed`, `log` (free-form line for the Agent's Desk feed).

## 4. Blueprint content JSON

The contract between Builder and engine (stored per revision):

```jsonc
{
  "title": "Monthly Performance Report",
  "clientName": "Meridian Retail Group",
  "eyebrow": "PREPARED FOR … · JULY 2026",
  "dateline": "…",
  "sections": [{
    "key": "exec-summary",
    "number": 2,
    "heading": "Executive summary",
    "mode": "fixed" | "auto" | "review",   // fixed = verbatim text; auto = drafted, no gate;
                                            // review = drafted, always held for judgment
    "instruction": "prose brief for the agent",
    "fixedText": "…",                       // fixed mode only
    "sourceIds": ["src_…"],
    "rules": [{
      "kind": "assert" | "style" | "judgment",
      "text": "human-readable rule",
      "expression": "…"                     // optional, for deterministic asserts over parsed tables
    }]
  }],
  "globalRules": ["tone…", "citation policy…"],
  "delivery": { "recipient": "reports@…", "autoDeliverOnClear": true }  // display-only in v1
}
```

## 5. Run engine

**Model:** `claude-opus-4-8`, adaptive thinking (`thinking: {type: "adaptive"}`), `output_config: {effort: "high"}`, streaming. Anthropic client injected (testability). Credentials via standard SDK resolution (`ANTHROPIC_API_KEY` or `ant auth login` profile).

### Source ingestion (run start)

Build a **source pack**: CSV/XLSX parsed to structured tables (papaparse / SheetJS) with computed summaries (row counts, column stats, totals); DOCX text via mammoth; PDFs passed to Claude as base64 document blocks. Each source gets a stable id + short label (what citation chips render). Emit `source_read` events (drives "READING SOURCES" phase).

### Per-section drafting

One streaming call per non-fixed section. System prompt (stable, `cache_control` breakpoint) = global rules + document conventions + AST output contract. User turn = section instruction + relevant source-pack slice + previously completed sections (coherence). Output = document AST via structured outputs: paragraphs and tables whose numeric spans carry `{sourceId, locator}` citations. Text deltas forwarded as `text_delta` events (Live Run typewriter).

### Checks, retries, flags

After each section:

1. **`assert` rules** — evaluated deterministically in code where the expression references parsed table data (recompute, compare within tolerance). Fail → `check_failed` + one retry with failure context appended. Second fail → flag.
2. **Citation audit** (code): every numeric span must cite a bound source; figures traceable to parsed tables are recomputed and must match.
3. **`judgment` rules and `review` sections** — model states its concern as a structured flag → `flags` row + `flag_raised`. Flags never stop the run; they block release in the Reader.

### Mid-run questions

The model can call an `ask_user` tool: `{question, options, fallback, deadlineSection}` → `question_raised` event; the engine **keeps drafting independent sections**. Between sections it checks `run_inputs`; an answer is injected into subsequent prompts; if the deadline section is reached unanswered, the fallback applies (`question_fallback_applied`) and a review note is logged.

### Pause / steer

Checked between sections. `pause` → wait (status `paused`); `steer` text appended to every subsequent section prompt and echoed to the log feed.

### Completion

Assemble full document AST, run whole-document stats (duration, words, sources used, checks passed, flags, citation count), write `runs.document` + `stats`, emit `run_completed`.

### Engine error handling

- SDK default retries for transient API errors.
- `stop_reason: "max_tokens"` → retry the section with a higher cap.
- `stop_reason: "refusal"` → section marked failed with explanation in the log.
- Unrecoverable → `run_failed` + status `failed`; "Run it again" starts a fresh run.
- Worker startup marks stale `running` runs as `failed` (no mid-run resume in v1).

## 6. Margin-notes agent (Builder)

Direct API route, no worker. A conversation thread per section (`notes` table). The agent responds via structured output with either prose or a **proposed edit** — deletion/insertion spans against the section's current text. Accept applies spans and writes a new blueprint revision; the red-pencil rendering is those spans visualized. A "review this section" action asks the agent to proactively propose edits (e.g. instruction/rule conflicts) — this populates the open-notes count. No background daemon in v1.

## 7. Frontend

Next.js (App Router) + TypeScript + **Tailwind CSS v4** with the entire Manuscript design language as theme tokens (paper `#FAF6EE`, card `#FFFDF8`, selected wash `#F1EADC`, ink `#201A15`, red pencil `#B3392B`, amber `#8A5A22`, citation purple `#5B4A8A`, hairline opacities, pill radii, etc. — per the handoff's Design Tokens section). Fonts via `next/font/google`: Newsreader, Archivo, IBM Plex Mono. Fidelity target: pixel-faithful to `Runoff Prototype.dc.html`.

**Routes**

| Route | Surface |
|---|---|
| `/` | Library — review queue + ledger + filters |
| `/blueprints/[id]` | Builder — ToC rail · document page · margin notes |
| `/runs/[id]` | Live Run while running; Reader once complete (topbar/rails swap on completion) |
| `/sources` | Sources ledger + add-source modal (file upload live; other kinds disabled) |

**Live data:** `GET /api/runs/[id]/events` (SSE) tails `run_events`. A single **event reducer** (in `packages/core`, shared with engine tests) projects events → UI state; the same reducer replays the stored log when opening an in-flight or finished run.

**Document renderer:** one component renders the document AST for Builder preview, Live Run, and Reader — differing only in annotations (pencil edits / typewriter caret / flag highlights + citation chips).

**Export:** Reader print stylesheet + `window.print()` for "Export PDF". DOCX button present, toast-mocked. Toasts follow the prototype (single ink pill, 2.4 s).

## 8. HTTP API (route handlers in `apps/web`)

- Blueprints: CRUD, `POST /api/blueprints/[id]/revisions` (new rev), publish (draft → active).
- Sources: upload (multipart → `data/files/`), list, delete, refresh timestamp.
- Runs: `POST /api/runs` (enqueue), `GET /api/runs/[id]`, `GET /api/runs/[id]/events` (SSE), `POST /api/runs/[id]/inputs` (pause/resume/steer/answer).
- Flags: `POST /api/flags/[id]/resolve`.
- Notes: `GET/POST /api/blueprints/[id]/notes` (post → agent reply), `POST /api/notes/[id]/accept`.
- No auth: localhost, single user.

## 9. Testing

- **Engine unit tests (vitest):** check evaluation, citation audit, source parsing, event reducer.
- **Engine integration test:** scripted fake Anthropic client exercising the full event sequence — drafting, assert failure + retry, question with fallback, flags, completion.
- **Live smoke (opt-in):** `pnpm eval` runs a real Meridian-style blueprint against the real API; asserts document shape, citations present, checks executed.
- **UI:** component tests for reducer-driven screens; end-to-end manual verification against the prototype.

## 10. Decisions log

| Decision | Choice |
|---|---|
| First-version goal | Real working tool |
| First use case | Recurring client performance report |
| V1 source kinds | File upload only |
| Agent behaviors in v1 | All four (cited drafting, checks & flags, mid-run questions, margin-note editing) |
| Stack | Next.js + SQLite, local-first |
| Architecture | App + worker (separate processes, SQLite-coordinated) |
| Model | `claude-opus-4-8`, adaptive thinking, effort high, streaming |
