import { Fragment, type ReactNode } from "react";
import type { Block, Span } from "@runoff/core";
import { CitationChip } from "./CitationChip";

/**
 * Decorates a rendered span. Called with the span, a stable key, and the span's
 * already-rendered `content` (text + optional citation chip). Return the full
 * replacement node to substitute — the caller owns composition, so it must
 * include `content` wherever it wants the text to appear (e.g.
 * `<mark>{content}<sup>F1</sup></mark>` keeps both the passage and the marker).
 * Return `null` — or `false`, so the `cond && <mark>` idiom is safe — to fall
 * back to default rendering. Reader uses this to wrap flagged passages in an
 * amber highlight.
 */
export type Annotate = (
  span: Span,
  key: string,
  content: ReactNode
) => ReactNode | null;

/**
 * Renders a document section's block AST (paragraphs + KPI tables) with the
 * editorial typography from the design handoff. Cited spans get a
 * `<CitationChip/>` appended; negative table deltas (leading "▼" or "-") render
 * in red pencil. Optional `annotate` lets a client parent wrap specific spans.
 * With `caret`, a blinking block caret trails the last block's writing edge —
 * the Live Run page streams drafts through this same AST as they type.
 *
 * Server-safe: pure presentational, no hooks / no "use client". Passing a
 * client-defined `annotate` from a client parent forces client rendering there.
 */
export function SectionBlocks({
  blocks,
  sourceLabels = {},
  annotate,
  caret = false,
}: {
  blocks: Block[];
  sourceLabels?: Record<string, string>;
  annotate?: Annotate;
  caret?: boolean;
}) {
  if (!blocks.length && caret) {
    return (
      <p className="font-serif text-[14.5px] leading-[1.8] text-ink">
        <Caret />
      </p>
    );
  }
  return (
    <div>
      {blocks.map((block, i) =>
        block.type === "paragraph" ? (
          <Paragraph
            key={i}
            block={block}
            first={i === 0}
            index={i}
            sourceLabels={sourceLabels}
            annotate={annotate}
            caret={caret && i === blocks.length - 1}
          />
        ) : (
          <Table
            key={i}
            block={block}
            first={i === 0}
            index={i}
            sourceLabels={sourceLabels}
            annotate={annotate}
            caret={caret && i === blocks.length - 1}
          />
        )
      )}
    </div>
  );
}

/** The 8×15px ink block caret that blinks at the writing edge. */
function Caret() {
  return (
    <span
      aria-hidden
      className="blink ml-[1px] inline-block h-[15px] w-[8px] translate-y-[2px] bg-ink"
    />
  );
}

/**
 * Resolve a source's short chip label. Falls back to the id with a leading
 * `src_` stripped and the remainder uppercased (`src_spend_june` → `SPEND_JUNE`).
 */
function resolveLabel(sourceId: string, labels: Record<string, string>): string {
  const explicit = labels[sourceId];
  if (explicit) return explicit;
  const stripped = sourceId.startsWith("src_") ? sourceId.slice(4) : sourceId;
  return stripped.toUpperCase();
}

/** Render a single span: text, optional citation chip, optional annotate wrap. */
function renderSpan(
  span: Span,
  key: string,
  labels: Record<string, string>,
  annotate?: Annotate
): ReactNode {
  const content: ReactNode = (
    <>
      {span.text}
      {span.citation ? (
        <CitationChip label={resolveLabel(span.citation.sourceId, labels)} />
      ) : null}
    </>
  );
  const annotated = annotate ? annotate(span, key, content) : null;
  // Fall back to default rendering when the callback declines. `null`/`undefined`
  // is the explicit opt-out; `false` covers the `cond && <mark>` idiom so a
  // falsy conditional never blanks the span (Task 15 review).
  const useDefault = annotated == null || annotated === false;
  return <Fragment key={key}>{useDefault ? content : annotated}</Fragment>;
}

function Paragraph({
  block,
  first,
  index,
  sourceLabels,
  annotate,
  caret = false,
}: {
  block: Extract<Block, { type: "paragraph" }>;
  first: boolean;
  index: number;
  sourceLabels: Record<string, string>;
  annotate?: Annotate;
  caret?: boolean;
}) {
  return (
    <p
      className={`font-serif text-[14.5px] leading-[1.8] text-ink${first ? "" : " mt-[12px]"}`}
    >
      {block.spans.map((span, i) =>
        renderSpan(span, `${index}-${i}`, sourceLabels, annotate)
      )}
      {caret ? <Caret /> : null}
    </p>
  );
}

/** Column flex ratio: wider first (label) column, uniform for the rest. */
function flexClass(col: number): string {
  return col === 0 ? "flex-[2.2]" : "flex-[1.2]";
}

/** A delta cell reads negative when it leads with "▼" or a minus sign. */
function isNegative(text: string): boolean {
  return /^\s*(?:▼|-)/.test(text);
}

function Table({
  block,
  first,
  index,
  sourceLabels,
  annotate,
  caret = false,
}: {
  block: Extract<Block, { type: "table" }>;
  first: boolean;
  index: number;
  sourceLabels: Record<string, string>;
  annotate?: Annotate;
  caret?: boolean;
}) {
  return (
    <div className={`border-y border-ink/20${first ? "" : " mt-[22px]"}`}>
      <div className="flex px-[2px] py-[9px] font-sans text-[9.5px] font-semibold uppercase tracking-[1.8px] text-ink/50">
        {block.columns.map((column, c) => (
          <span key={c} className={`${flexClass(c)}${c === 0 ? "" : " text-right"}`}>
            {column}
          </span>
        ))}
      </div>
      {block.rows.map((row, r) => (
        <div
          key={r}
          className="flex items-baseline border-t border-ink/10 px-[2px] py-[8px]"
        >
          {row.cells.map((cell, c) => {
            const plain = cell.map((s) => s.text).join("");
            const cls =
              c === 0
                ? "font-serif text-[13.5px] text-ink"
                : `text-right font-mono text-[12px]${isNegative(plain) ? " text-pencil" : ""}`;
            return (
              <span key={c} className={`${flexClass(c)} ${cls}`}>
                {cell.map((span, s) =>
                  renderSpan(span, `${index}-${r}-${c}-${s}`, sourceLabels, annotate)
                )}
              </span>
            );
          })}
        </div>
      ))}
      {caret ? (
        <div className="border-t border-ink/10 px-[2px] py-[8px]">
          <Caret />
        </div>
      ) : null}
    </div>
  );
}
