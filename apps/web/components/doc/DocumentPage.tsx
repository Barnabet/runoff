import type { ReactNode } from "react";

/**
 * The on-paper document page: a fixed 648px `bg-card` sheet with the editorial
 * masthead (eyebrow · title · italic dateline · rule) and the section body as
 * `children`. Shared by Builder preview, Live Run, and Reader.
 *
 * Server-safe: pure presentational, no hooks / no "use client".
 */
export function DocumentPage({
  eyebrow,
  title,
  dateline,
  children,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  dateline: ReactNode;
  children?: ReactNode;
}) {
  return (
    <article className="doc-page box-border w-[648px] border border-ink/15 bg-card px-[58px] pb-[46px] pt-[54px] shadow-[0_3px_18px_rgba(32,26,21,0.09)]">
      <p className="font-sans text-[9.5px] font-semibold uppercase tracking-[2.5px] text-ink/50">
        {eyebrow}
      </p>
      <h1 className="mb-[6px] mt-[10px] font-serif text-[33px] font-medium leading-[1.15] text-ink">
        {title}
      </h1>
      <p className="font-serif text-[14px] italic text-ink/55">{dateline}</p>
      <div className="mb-[24px] mt-[22px] h-px bg-ink/25" />
      {children}
    </article>
  );
}
