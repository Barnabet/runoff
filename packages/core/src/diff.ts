import type { Block, RunDocument, Span } from "./types/document.js";
import { blocksToPlainText } from "./types/document.js";

/** Strip $, commas and % so a rendered figure can be compared numerically. */
export function parseFigure(text: string): number {
  return parseFloat(text.replace(/[$,%]/g, ""));
}

export interface FigureDelta {
  sectionKey: string;
  sourceId: string;
  locator: string;
  before: number;
  after: number;
}

export type SectionDiffStatus = "new" | "removed" | "changed" | "unchanged";

export interface RunDiff {
  deltas: FigureDelta[];
  sections: Record<string, SectionDiffStatus>;
}

/** First parseable cited-figure value per `${sourceId}|${locator.trim()}` key. */
function citedFigures(blocks: Block[]): Map<string, number> {
  const out = new Map<string, number>();
  const visit = (span: Span): void => {
    if (!span.citation) return;
    const key = `${span.citation.sourceId}|${span.citation.locator.trim()}`;
    if (out.has(key)) return;
    const value = parseFigure(span.text);
    if (Number.isFinite(value)) out.set(key, value);
  };
  for (const block of blocks) {
    if (block.type === "paragraph") block.spans.forEach(visit);
    else for (const row of block.rows) for (const cell of row.cells) cell.forEach(visit);
  }
  return out;
}

/**
 * Deterministic run-over-run diff: sections match by key (`new` / `removed` /
 * `changed` / `unchanged` by plain-text equality); within a matched section,
 * cited figures match by `${sourceId}|${locator.trim()}` and changed values
 * become deltas. Zero-difference and non-numeric pairs are dropped.
 */
export function diffRuns(current: RunDocument, previous: RunDocument): RunDiff {
  const sections: Record<string, SectionDiffStatus> = {};
  const deltas: FigureDelta[] = [];
  const prevByKey = new Map(previous.sections.map((s) => [s.key, s]));

  for (const cur of current.sections) {
    const prev = prevByKey.get(cur.key);
    if (!prev) {
      sections[cur.key] = "new";
      continue;
    }
    sections[cur.key] =
      blocksToPlainText(cur.blocks) === blocksToPlainText(prev.blocks) ? "unchanged" : "changed";

    const before = citedFigures(prev.blocks);
    for (const [key, after] of citedFigures(cur.blocks)) {
      const b = before.get(key);
      if (b === undefined || b === after) continue;
      const sep = key.indexOf("|");
      deltas.push({
        sectionKey: cur.key,
        sourceId: key.slice(0, sep),
        locator: key.slice(sep + 1),
        before: b,
        after,
      });
    }
  }
  for (const prev of previous.sections) {
    if (!current.sections.some((s) => s.key === prev.key)) sections[prev.key] = "removed";
  }
  return { deltas, sections };
}
