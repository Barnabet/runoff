# Handoff: Runoff — LLM Document-Automation App

## Overview
Runoff automates recurring document generation with LLM agents. The mental model: **Blueprint** (sections, instructions, rules, output format, schedule) **+ Data** (constant + variating sources: files, APIs, warehouses, web research) **+ Agent** (drafts, checks, cites, flags) **→ Run** (a sourced, checked document). This handoff covers the five core surfaces: Library, Blueprint Builder, Live Run, Reader, and Sources — plus a connect-source modal.

Primary persona: non-technical consultant/analyst producing recurring client reports. Demo scenario throughout: "Monthly Performance Report" for client Meridian Retail.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, **not production code to copy directly**. The task is to **recreate these designs in the target codebase's existing environment** (React, Vue, etc.) using its established patterns and libraries. If no environment exists yet, choose the most appropriate stack (e.g. React + a component layer of your choice) and implement the designs there.

- `Runoff Prototype.dc.html` — the clickable prototype (source of truth for layout, styling, interactions). All styles are inline in the markup; the logic lives in the embedded `Component` class.
- `Runoff Explorations.dc.html` — the option-exploration canvas. Turn 1 shows three visual directions (1a/1b/1c); **1b "Manuscript" was chosen** and turn 2 elaborates it. Reference only.

## Fidelity
**High-fidelity.** Colors, typography, spacing, copy, and interactions are final intent. Recreate pixel-perfectly, mapping to the codebase's conventions (design tokens, component library) where equivalent.

## Design Language ("Manuscript")
The finished document is the interface. Editorial print aesthetic: warm paper surfaces, ink text, serif for content and headings, small sans for UI chrome, monospace for metadata/ledger values. The agent appears as **margin notes** and **red-pencil edits** on the document — never a floating chatbot. Accent red is used sparingly: active-tab underline, selected-section spine, live indicators, agent deletions/insertions.

## Design Tokens

### Colors
- App background (paper): `#FAF6EE`
- Card / document page: `#FFFDF8`
- Selected wash (active ToC row, resolved cards, picked cards): `#F1EADC`
- Ink (text, solid buttons, toggles): `#201A15`
- Red pencil (accent: active tab underline, selected spine, REVIEW badges, live dot, agent edits, negative deltas): `#B3392B`
- Amber (warnings: stale sources, flags, held items): `#8A5A22`; amber washes: `rgba(216,161,59,.14)` banner, `rgba(216,161,59,.1)` row, `rgba(216,161,59,.3)` text highlight
- Citation chips: `#5B4A8A` text, border `rgba(91,74,138,.4)`
- Hairlines/borders on ink: `rgba(32,26,21,.1)` row dividers, `.12–.16` card borders, `.15` topbar border, `.2–.3` input/button borders, `.25` heavier rules
- Muted text: `rgba(32,26,21,.65)` secondary, `.55–.6` tertiary, `.45` labels, `.35–.4` faint
- Modal scrim: `rgba(32,26,21,.38)`
- Page shadow: `0 3px 18px rgba(32,26,21,.09)`; card shadow `0 1px 6px rgba(32,26,21,.06)`; modal `0 14px 44px rgba(32,26,21,.3)`

### Typography (Google Fonts)
- **Newsreader** (serif) — document content, headings, italic hints/placeholders. Wordmark: italic 500, 21px. Page title: 500, 33px/1.15. Section headings: 500, 19px. Body: 400, 14–14.5px/1.75–1.8. Screen titles ("Blueprints", "Sources"): 500, 30px. ToC items: 400/500, 14px.
- **Archivo** (sans) — UI chrome. Buttons: 500, 11–12.5px. Nav tabs: 500, 13px. Column headers / eyebrow labels: 600, 9–9.5px, letter-spacing 1.8–2.5px, uppercase.
- **IBM Plex Mono** — metadata, ledger values, timestamps, badges. Values: 400, 10.5px. Badges: 500, 8–8.5px, letter-spacing 1px. Log feed: 400, 10.5px/2.

### Shape & spacing
- Buttons and chips: pill (`border-radius: 99px`). Solid = ink bg + paper text; outline = 1px `rgba(32,26,21,.3)` border. Padding ≈ 7–8px × 14–16px (primary), 4–6px × 10–13px (small).
- Badges (FIXED / AUTO / REVIEW / DRAFT / FLAG / 2 FLAGS / CLEARED): 3px radius, 1px border, 2px × 5–6px padding. REVIEW/flags use red or amber; neutral uses `rgba(32,26,21,.2)` border + `.45` text.
- Cards: square corners, 1px border; margin-note cards carry a 2px **top** border in their status color (red = needs judgment, amber = warning, ink = info).
- Topbar: 56px, 1px bottom hairline. Content max-width 1360px, centered; screen padding 28px × 40px.
- Document page: 648px wide, padding 54px × 58px, on-paper card.
- Builder/Run/Reader 3-column grid: left rail 248px · center flexible (page centered) · right rail 312–322px.
- Avatar: 28px circle, ink bg, italic serif initial.
- Toggle: 30×17px pill, 13px knob, ink when on, `rgba(32,26,21,.25)` when off.

### Motion
- Blink (caret + live dot): 1.1s steps(1) infinite, opacity 1→0 at 55%.
- Toggle knob/background: 0.2s. Everything else is instant — no slide/fade theatrics.

## Screens / Views

### 1. Library (`Blueprints` tab)
Purpose: home; find blueprints, triage what needs review.
- Topbar: wordmark → Library; tabs Blueprints / Runs / Sources (active tab = 2px red underline flush with the topbar hairline); right: search field (pill outline, italic serif placeholder), solid "New blueprint" pill, avatar.
- Heading row: "Blueprints" (serif 30) + mono count "6 ACTIVE · 2 AWAIT REVIEW"; right-aligned filter pills (All active/solid; Monthly, Weekly, Quarterly, Drafts outline).
- **Review queue**: two side-by-side cards (flex, gap 14px), 2px top border red (flags) / amber (agent question). Serif title 14.5px, mono meta line, action pill right (solid "Review" / outline "Answer").
- **Ledger table**: column headers (Archivo 600 9.5px, ls 1.8px) BLUEPRINT / CLIENT / CADENCE / SOURCES / LAST RUN / NEXT RUN, bottom-ruled `.3`; rows (13px vertical padding, `.1` dividers, cursor pointer): name serif 15.5, client 12px, mono cadence/counts/dates, status inline in LAST RUN (red "2 FLAGS", amber "QUESTION", muted "✓ CLEAN"), trailing "→" `.4` ink. Draft rows: muted name + DRAFT badge.
- Footer affordance (italic serif, `.45`): "Start from a past report — drop any PDF or DOCX here and the agent will reverse-engineer it into a blueprint."

### 2. Blueprint Builder
Purpose: define/edit a blueprint while previewing the resulting document; converse with the agent in the margin.
- Topbar: wordmark · "← Blueprints" · breadcrumb "Meridian Retail — **Monthly Performance Report**" · amber pill badge "DRAFT · REV 15" · right: History, Sources (text links), "Preview run" (outline pill), "Publish" (solid pill).
- **Left rail — CONTENTS** (248px): 7 numbered ToC rows: mono number `.4`, serif name, right badge (FIXED / REVIEW / AUTO / "4 SRC"). Selected row: `#F1EADC` wash + 2px red left spine (row shifts -10px left margin to bleed the spine). Below: italic "+ add a section…", then SOURCES mini-list (mono 10.5px, name + freshness; stale in amber) pinned to bottom above a hairline.
- **Center — the page** (648px): eyebrow "PREPARED FOR MERIDIAN RETAIL GROUP · JULY 2026" (Archivo 9.5 ls2.5), title serif 33, italic dateline, 1px rule. §02 selected shows: "Executive summary" heading + REVIEW badge; body paragraph with **agent edits inline** — deletion = `line-through` in `rgba(179,57,43,.75)`, insertion = 2px red bottom-border on ink text — and **citation chips** after figures (superscript mono 8.5px purple bordered chips: GA4, CSV, CRM); KPI table (headers Archivo caps; metric serif 13.5; values mono 12 right-aligned; negative/flagged deltas red "▼ 12.4%"; source col mono 9.5 `.45`); "Channel performance" heading + greeked stripe block (repeating-linear-gradient rgba(32,26,21,.08) 9px/20px) + mono caption "channel tables render here at run time — GA4 · spend_june.csv". Other sections show: heading, italic instruction summary, greeked block, mono meta line.
- **Right rail — MARGIN NOTES** (312px): label + red mono count "2 OPEN"; edit legend (italic serif 11.5: struck = removal, underline = insertion). Note cards (paper, 1px border, 2px top border red/amber): header row = 20px ink circle with italic serif "R" + "Agent" (Archivo 600 11.5) + mono anchor "¶ Executive summary · 4m"; serif body 13/1.6; pill actions (Accept solid / Revise… outline; Pace-adjust / Remind me). User note card uses `#F1EADC` bg + outlined "S" avatar; agent reply card uses ink top border. Input row: 1px bordered field, italic serif placeholder "Note to the agent about this section…", small "Send" outline pill. Bottom (pinned): mono "RESOLVED TODAY — n" + struck example.

### 3. Live Run
Purpose: watch (and steer) the agent generating a document.
- Topbar: "← Blueprint" · "Monthly Performance Report — run #39" · **live badge**: red outlined pill "DRAFTING §04" with blinking 6px red dot (label follows phase: READING SOURCES → DRAFTING §02…§07 → RENDERING; PAUSED while paused). Right: mono "00:12 ELAPSED · EST 00:14", "Pause run"/"Resume run" outline pill. When done: solid ink pill badge "COMPLETE · n FLAGS", "Open the report →" solid pill.
- **Progress bar**: 3px track `rgba(32,26,21,.1)`, ink fill = elapsed/14.
- **Left rail — THIS RUN**: same ToC geometry; states: done = "✓" + muted name + mono meta (1.2s / 178w / retry 1 / held); active = "✎" red + selected-row wash/spine + italic red "writing…"; queued = "○" `.3` + name `.45`. Below: mono block "TRIGGER — MANUAL PREVIEW / BLUEPRINT — REV 15 / SOURCES — 5 · 1 STALE ▲"; after completion an italic underlined "Run it again".
- **Center — the page writes itself**: sections appear as reached; the active paragraph types character-by-character with an 8×15px ink block caret (blink animation). After §04 completes, a greeked tail block + mono caption tracks §05–§07 → "14 pages rendered".
- **Right rail — THE AGENT'S DESK**: mono log feed (10.5px/2): faint timestamps `.35`, message; warnings amber, failures red ("§05 budget — assert fail spend-total Δ0.9% → retry"), user/steer + final lines ink 600. **Mid-run flag card** (amber top border) at ~6s: agent asks a question, "Cite them" (solid) / "Leave it out" (outline), italic fallback note "No answer by §06? I'll leave it unattributed and note it for review." — resolves into a `#F1EADC` italic result card (answered or auto-resolved at 11s). **Completion card**: ink bg, serif "Run #39 complete in 14.2s", mono meta, paper pill "Open the report →". Bottom: steer input ("Steer the run — 'skip web research'…") appending an ink log line.
- Run timeline (seconds, scaled by speed): §01 0.9 · §02 2.3 (types 0.9–2.3) · §03 3.5 · §04 types 3.5–9.6 · flag 5.8 · §05 fail 9.9 → ok 10.9 · §06 11.9 · §07 12.9 · render 13.6 · done 14.

### 4. Reader (finished run)
Purpose: review a generated document, clear flags, deliver.
- Topbar: "← Blueprints" · bold title · run picker outline pill "Run #38 — Jul 1, 2026 ▾" · underlined "compare with #37" · right: Share (text), DOCX (outline), Export PDF (solid).
- **Status banner** under topbar: flags open → amber wash `rgba(216,161,59,.14)`, amber bottom border, "2 FLAGS" badge + italic serif "Two passages await your judgment — clearing them releases the report for delivery." All cleared → solid ink banner, "CLEARED" badge + italic paper text "Cleared. Delivered to reports@meridianretail.com — Jul 1, 09:14. ✓" (or "Auto-delivery is off…" per toggle).
- **Center — the document**: clean page (no pencil edits); the flagged sentence carries an amber text highlight `rgba(216,161,59,.3)` + superscript amber mono "F1" marker; both clear when F1 resolves ("Soften" also swaps the sentence to the softened wording). Greeked tail + mono "PP. 3–14 — CHANNELS · BUDGET · RECOMMENDATIONS · APPENDIX".
- **Right rail** (322px): **RUN REPORT card** — 2-col mono ledger: DURATION 29.4s · 1 retry / LENGTH 2,140 words · 14pp / SOURCES 5 used · 1 stale ▲ / CHECKS 10 pass · n flags (→ "2 resolved ✓") / CITATIONS 31 figures, all sourced. **Flag cards F1/F2** (amber top border): mono "F1" + Archivo title + mono anchor; serif question; pills (F1: Keep solid / Soften / Sources; F2: Fine solid / Show all 9) — resolve to `#F1EADC` italic result cards. **DELIVERY card**: recipient in mono, "Auto-deliver on clear" toggle.

### 5. Sources (+ connect modal)
Purpose: manage connections and freshness; add new sources.
- Topbar: tabs with Sources active; solid "Add source" pill.
- Heading "Sources" + mono "6 CONNECTED · 1 STALE".
- **Ledger**: SOURCE / KIND / USED BY / FRESHNESS / SYNC. Name serif 15; kind mono caps (API / FILE / WAREHOUSE / DOCUMENT / AGENT); freshness mono ("✓ 2M AGO", "FIXED", "AT RUN TIME"); stale row = amber wash + "▲ 31D — STALE" + amber underlined action "Request update" (→ "REMINDER SENT ✓"). Footer italic: "Every source is read-only. The agent queries and quotes; it never writes back."
- **Add-source modal**: scrim-centered 600px paper card. Header: serif 22 "Add a source" + mono stepper "1 CHOOSE — **2 CONNECT** — 3 MAP FIELDS". 3×2 grid of kind cards (serif title + mono sub): Upload a file / Database / SaaS API / Cloud drive / Web research / Paste text; picked card = 1.5px ink border + `#F1EADC`. Credential fields (Database): HOST, DATABASE, READ-ONLY KEY (masked) — labeled Archivo caps, mono values, 1px bordered. Footer: italic reassurance "Read-only, encrypted at rest. The agent queries; it never writes." + Cancel (outline) / "Test & continue →" (solid). Scrim click or Cancel closes; inner clicks don't propagate.

## Interactions & Behavior
- Navigation: wordmark → Library everywhere; tabs Blueprints/Runs/Sources; library row → Builder (Meridian); Review → Reader; Builder "Preview run" → Live Run (starts the timeline); run completion → Reader.
- Builder: ToC click swaps the center page content; Accept on the rewrite note applies the pencil edit (deletion/insertion collapse to clean text) and removes the REVIEW badge; each resolved note increments "RESOLVED TODAY"; note input (Enter or Send) posts a user card, agent reply card follows after ~900ms; empty send → toast "Type a note first."
- Live run: interval-driven timeline (100ms ticks × speed); pause/resume; flag answerable only until 11s, then auto-resolves with a log line; steering appends to the log; "Run it again" resets.
- Reader: resolving both flags flips the banner (amber → ink) and the CHECKS line; "Soften" rewrites the flagged sentence; highlight + F1 marker clear on resolve; delivery toggle animates.
- Toasts: single ink pill, fixed bottom-center, italic serif 14px, auto-dismiss 2.4s — used for all mocked/secondary actions (publish, exports, share, history, reminders, connect).
- Hover: pointer cursor on all actionables; keep hover treatments minimal (e.g. slight underline on text links) consistent with the flat editorial look.

## State Management
- `view`: 'library' | 'builder' | 'run' | 'reader' | 'sources'
- Builder: `section` (1–7), `note1`/`note2` ('open'|'done'), `sentNote`, `agentReply`, `chatDraft`
- Run: `{started, elapsed, paused, done, flagAnswer: null|'cite'|'skip'|'auto', extra: log[]}` — derived per-section status from elapsed vs milestones; typed text = substring by progress
- Reader: `f1` ('open'|'kept'|'softened'), `f2` ('open'|'fine'|'all9'), `autoDeliver`
- Sources: `modalOpen`, `pickedKind`, `requested`
- Transient: `toast`
- Real implementation additionally needs: blueprints/sources/runs collections, revisions (rev n, diff, revert), run log streaming (SSE/websocket), flag threads, delivery settings.

## Assets
None — no images or icon fonts. Placeholders are CSS stripe blocks (`repeating-linear-gradient`). Glyphs are unicode text (✓ ✎ ○ ▲ ▼ → ¶ ↑ ▾). Fonts via Google Fonts: Newsreader, Archivo, IBM Plex Mono.

## Files
- `Runoff Prototype.dc.html` — clickable prototype; inline styles are the styling source of truth; `Component` class at the bottom holds all interaction logic, timeline constants, and copy.
- `Runoff Explorations.dc.html` — exploration canvas (brief, chosen direction 1b, turn-2 screen statics). Reference for rationale and rejected directions (1a cyanotype "Drafting sheet", 1c dark "Production line").
