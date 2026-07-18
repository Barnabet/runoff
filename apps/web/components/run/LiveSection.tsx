import type { Block } from "@runoff/core";
import type { SectionRunState } from "@runoff/core";
import { SectionBlocks } from "@/components/doc/SectionBlocks";

/**
 * One section on the page as the run writes it. Queued sections render nothing;
 * a writing section streams its typed text as plain serif paragraphs with a
 * blinking block caret trailing the last one; a done section renders its final
 * block AST through the shared `<SectionBlocks>`.
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
        <TypingBody text={typedText} />
      )}
    </section>
  );
}

/** Split the streamed text on blank lines into paragraphs; the last one carries the caret. */
function TypingBody({ text }: { text: string }) {
  const paragraphs = text.split(/\n{2,}/);
  return (
    <>
      {paragraphs.map((para, i) => (
        <p
          key={i}
          className={`font-serif text-[14.5px] leading-[1.8] text-ink${i === 0 ? "" : " mt-[12px]"}`}
        >
          {para}
          {i === paragraphs.length - 1 ? <Caret /> : null}
        </p>
      ))}
    </>
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
