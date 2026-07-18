import type { ProposedEdit } from "@runoff/engine";

/**
 * Renders an agent's proposed find/replace edit as red-pencil markup: the
 * removed text struck through, the inserted text underlined. Mirrors the
 * document's inline-edit treatment so a margin note reads the same as the page.
 */
export function PencilEdit({ edit }: { edit: ProposedEdit }) {
  return (
    <div className="mt-[9px] font-serif text-[13px] leading-[1.6]">
      {edit.edits.map((pair, i) => (
        <p key={i} className={i === 0 ? "" : "mt-[6px]"}>
          {pair.find ? (
            <span className="line-through text-pencil/75">{pair.find}</span>
          ) : null}
          {pair.find && pair.replace ? " " : null}
          {pair.replace ? (
            <span className="border-b-2 border-pencil text-ink">{pair.replace}</span>
          ) : null}
        </p>
      ))}
    </div>
  );
}
