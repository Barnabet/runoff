import Link from "next/link";
import type { RunProjection } from "@runoff/core";
import type { GetRunResponse } from "@/lib/api";
import { Topbar } from "@/components/Topbar";
import { DocumentPage } from "@/components/doc/DocumentPage";
import { SectionBlocks } from "@/components/doc/SectionBlocks";

/**
 * Placeholder Reader for a finished run. Renders the final document from the
 * projection through the shared `<SectionBlocks>` so the Live Run → Reader
 * handoff point exists; Task 20 replaces this with the real Reader (status
 * banner, flag cards, run report, delivery).
 */
export function ReaderShell({
  payload,
  projection,
}: {
  payload: GetRunResponse;
  projection: RunProjection;
}) {
  const { blueprint, sourceLabels, content } = payload;
  const doc = projection.document;
  const eyebrow = doc?.eyebrow ?? content.eyebrow;
  const title = doc?.title ?? content.title;
  const dateline = doc?.dateline ?? content.dateline;

  const center = (
    <div className="flex items-center gap-[16px]">
      <Link href="/" className="font-sans text-[13px] text-ink/60">
        ← Blueprints
      </Link>
      <span className="font-serif text-[14px] font-semibold text-ink">{title}</span>
    </div>
  );

  return (
    <>
      <Topbar center={center} />
      <main className="mx-auto flex w-full max-w-[1360px] flex-col items-center px-[40px] py-[28px]">
        <DocumentPage eyebrow={eyebrow} title={title} dateline={dateline}>
          {doc?.sections.map((s) => (
            <section key={s.key} className="mt-[28px] first:mt-0">
              <h2 className="mb-[10px] font-serif text-[19px] font-medium text-ink">{s.heading}</h2>
              <SectionBlocks blocks={s.blocks} sourceLabels={sourceLabels} />
            </section>
          ))}
        </DocumentPage>
        <p className="mt-[20px] font-mono text-[10.5px] tracking-[1px] text-ink/45">
          Reader arrives in the next task — {blueprint.name}
        </p>
      </main>
    </>
  );
}
