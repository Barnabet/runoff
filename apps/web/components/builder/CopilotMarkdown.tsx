"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Copilot replies arrive as markdown; render them in the Manuscript idiom.
 * Copilot-authored bodies only — user messages render as plain text.
 */
export function CopilotMarkdown({ children }: { children: string }) {
  return (
    <div className="mt-1 font-serif text-[13.5px] leading-[1.55] text-ink [&>*+*]:mt-2">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          strong: (p) => <strong className="font-semibold">{p.children}</strong>,
          em: (p) => <em className="italic">{p.children}</em>,
          a: (p) => (
            <a href={p.href} className="underline decoration-ink/40 underline-offset-2" target="_blank" rel="noreferrer">
              {p.children}
            </a>
          ),
          ul: (p) => <ul className="list-disc pl-[18px] [&>li+li]:mt-1">{p.children}</ul>,
          ol: (p) => <ol className="list-decimal pl-[18px] [&>li+li]:mt-1">{p.children}</ol>,
          h1: (p) => <div className="font-semibold">{p.children}</div>,
          h2: (p) => <div className="font-semibold">{p.children}</div>,
          h3: (p) => <div className="font-semibold">{p.children}</div>,
          h4: (p) => <div className="font-semibold">{p.children}</div>,
          blockquote: (p) => <blockquote className="border-l border-ink/20 pl-2 italic text-ink/70">{p.children}</blockquote>,
          code: (p) => <code className="rounded-sm bg-ink/5 px-1 font-mono text-[11px]">{p.children}</code>,
          pre: (p) => <pre className="overflow-x-auto rounded-sm bg-ink/5 p-2 [&_code]:bg-transparent [&_code]:px-0">{p.children}</pre>,
          table: (p) => (
            <div className="overflow-x-auto">
              <table className="font-mono text-[10.5px] [&_td]:border [&_td]:border-ink/15 [&_td]:px-2 [&_td]:py-0.5 [&_th]:border [&_th]:border-ink/15 [&_th]:px-2 [&_th]:py-0.5 [&_th]:text-left">
                {p.children}
              </table>
            </div>
          ),
          hr: () => <hr className="border-ink/12" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
