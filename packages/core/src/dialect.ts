import type { Block, Span } from "./types/document.js";

const CITE = /\[\[([^\]|]+)\|([^\]|]+)\|([^\]]+)\]\]/g;

export function spansFromInline(text: string): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(CITE)) {
    if (m.index! > last) spans.push({ text: text.slice(last, m.index) });
    spans.push({ text: m[1], citation: { sourceId: m[2].trim(), locator: m[3].trim() } });
    last = m.index! + m[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans.length ? spans : [{ text }];
}

function isTableLine(l: string) { return l.trim().startsWith("|"); }
function splitRow(l: string): string[] {
  const inner = l.trim().replace(/^\||\|$/g, "");
  const cells: string[] = [];
  let buf = "";
  let inCite = false;
  for (let i = 0; i < inner.length; i++) {
    if (!inCite && inner[i] === "[" && inner[i + 1] === "[") { inCite = true; buf += "[["; i++; continue; }
    if (inCite && inner[i] === "]" && inner[i + 1] === "]") { inCite = false; buf += "]]"; i++; continue; }
    if (inner[i] === "|" && !inCite) { cells.push(buf.trim()); buf = ""; continue; }
    buf += inner[i];
  }
  cells.push(buf.trim());
  return cells;
}

export function parseSectionText(raw: string): Block[] {
  const blocks: Block[] = [];
  const chunks = raw.replaceAll("\r\n", "\n").split(/\n{2,}/).map((c) => c.trim()).filter(Boolean);
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    if (lines.length >= 2 && isTableLine(lines[0]) && /^\|?[\s|:-]+\|?$/.test(lines[1])) {
      const columns = splitRow(lines[0]);
      const rows = lines.slice(2).filter(isTableLine).map((l) => ({ cells: splitRow(l).map(spansFromInline) }));
      blocks.push({ type: "table", columns, rows });
    } else {
      blocks.push({ type: "paragraph", spans: spansFromInline(lines.join(" ")) });
    }
  }
  return blocks;
}
