export interface Citation { sourceId: string; locator: string }
export interface Span { text: string; citation?: Citation }
export type Block =
  | { type: "paragraph"; spans: Span[] }
  | { type: "table"; columns: string[]; rows: { cells: Span[][] }[] };
export interface DocSection { key: string; heading: string; blocks: Block[] }
export interface RunDocument { title: string; eyebrow: string; dateline: string; sections: DocSection[] }

export function blocksToPlainText(blocks: Block[]): string {
  return blocks.map((b) =>
    b.type === "paragraph"
      ? b.spans.map((s) => s.text).join("")
      : b.rows.map((r) => r.cells.map((c) => c.map((s) => s.text).join("")).join(" · ")).join("\n")
  ).join("\n\n");
}

export function countWords(blocks: Block[]): number {
  return blocksToPlainText(blocks).split(/\s+/).filter(Boolean).length;
}
