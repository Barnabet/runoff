import type { Block } from "@runoff/core";
import type { SectionRunState } from "@runoff/core";
import { parseSectionText } from "@runoff/core/src/dialect.js";
import { SectionBlocks } from "@/components/doc/SectionBlocks";

/**
 * One section on the page as the run writes it. Queued sections render nothing;
 * a writing section parses its streamed text through the shared dialect parser
 * on every delta, so tables and citation chips render progressively instead of
 * as raw markers — a blinking block caret trails the writing edge; a done
 * section renders its final block AST the same way.
 *
 * Presentational only — no hooks; safe to render inside the client run tree.
 */
export function LiveSection({
  heading,
  state,
  blocks,
  typedText,
  sourceLabels,
}: {
  heading: string;
  state: SectionRunState;
  blocks: Block[];
  typedText: string;
  sourceLabels: Record<string, string>;
}) {
  if (state === "queued") return null;

  return (
    <section className="mt-[28px] first:mt-0">
      <h2 className="mb-[10px] font-serif text-[19px] font-medium text-ink">{heading}</h2>
      {state === "done" ? (
        <SectionBlocks blocks={blocks} sourceLabels={sourceLabels} />
      ) : (
        <SectionBlocks
          blocks={parseSectionText(streamVisible(typedText))}
          sourceLabels={sourceLabels}
          caret
        />
      )}
    </section>
  );
}

/**
 * The streamed prefix that is safe to render: hold back an unterminated
 * [[citation marker and an in-progress table line (rows appear whole, and a
 * lone header line never flashes as raw pipes) so dialect syntax never
 * reaches the page.
 */
function streamVisible(text: string): string {
  let t = text;
  const open = t.lastIndexOf("[[");
  if (open > t.lastIndexOf("]]")) t = t.slice(0, open);
  const nl = t.lastIndexOf("\n");
  if (t.slice(nl + 1).trimStart().startsWith("|")) t = nl === -1 ? "" : t.slice(0, nl);
  return t;
}
