"use client";

import { useLayoutEffect, useRef } from "react";
import type { BlueprintContent, BlueprintSection, Rule } from "@runoff/core";
import { DocumentPage } from "@/components/doc/DocumentPage";
import { Greeked } from "@/components/doc/Greeked";

/** A borderless textarea that grows to fit its content (no inner scrollbar). */
function AutoTextarea({
  value,
  onChange,
  className,
  placeholder,
  ariaLabel,
  minRows = 2,
}: {
  value: string;
  onChange: (v: string) => void;
  className: string;
  placeholder?: string;
  ariaLabel: string;
  minRows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    // jsdom reports scrollHeight 0; guard so tests don't collapse the field.
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={minRows}
      aria-label={ariaLabel}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full resize-none bg-transparent outline-none ${className}`}
    />
  );
}

const RULE_KINDS: Rule["kind"][] = ["assert", "style", "judgment"];

/** Compact rules list under a section: kind · text · (expression for assert). */
function RulesEditor({
  rules,
  onChange,
}: {
  rules: Rule[];
  onChange: (rules: Rule[]) => void;
}) {
  function update(i: number, patch: Partial<Rule>) {
    onChange(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function remove(i: number) {
    onChange(rules.filter((_, idx) => idx !== i));
  }
  return (
    <div className="mt-[24px]">
      <div className="mb-[8px] font-sans text-[9.5px] font-semibold uppercase tracking-[1.8px] text-ink/50">
        Rules
      </div>
      <div className="flex flex-col gap-[6px]">
        {rules.map((rule, i) => (
          <div key={i} className="flex items-center gap-[8px]">
            <select
              aria-label={`rule ${i + 1} kind`}
              value={rule.kind}
              onChange={(e) => {
                const kind = e.target.value as Rule["kind"];
                update(i, kind === "assert" ? { kind } : { kind, expression: undefined });
              }}
              className="rounded-[3px] border border-ink/20 bg-transparent px-[4px] py-[2px] font-mono text-[10px] text-ink/70"
            >
              {RULE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <input
              aria-label={`rule ${i + 1} text`}
              value={rule.text}
              onChange={(e) => update(i, { text: e.target.value })}
              placeholder="describe the rule…"
              className="flex-1 border-b border-ink/15 bg-transparent py-[2px] font-serif text-[13px] text-ink outline-none placeholder:italic placeholder:text-ink/40"
            />
            {rule.kind === "assert" ? (
              <input
                aria-label={`rule ${i + 1} expression`}
                value={rule.expression ?? ""}
                onChange={(e) => update(i, { expression: e.target.value })}
                placeholder="expression"
                className="w-[140px] border-b border-ink/15 bg-transparent py-[2px] font-mono text-[10.5px] text-ink/70 outline-none placeholder:text-ink/35"
              />
            ) : null}
            <button
              type="button"
              aria-label={`remove rule ${i + 1}`}
              onClick={() => remove(i)}
              className="font-mono text-[12px] text-ink/40"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...rules, { kind: "assert", text: "", expression: "" }])}
        className="mt-[8px] font-serif text-[13px] italic text-ink/50"
      >
        + add a rule…
      </button>
    </div>
  );
}

const MODES: BlueprintSection["mode"][] = ["fixed", "auto", "review"];

/** The fully-editable body for the selected section. */
function SelectedSection({
  section,
  onChange,
  labelFor,
}: {
  section: BlueprintSection;
  onChange: (patch: Partial<BlueprintSection>) => void;
  labelFor: (id: string) => string;
}) {
  const caption =
    section.sourceIds.map(labelFor).join(" · ") || "no sources bound";
  return (
    <div>
      <div className="flex items-baseline gap-[10px]">
        <input
          aria-label="section heading"
          value={section.heading}
          onChange={(e) => onChange({ heading: e.target.value })}
          className="flex-1 bg-transparent font-serif text-[19px] font-medium text-ink outline-none"
        />
        <select
          aria-label="section mode"
          value={section.mode}
          onChange={(e) => {
            const mode = e.target.value as BlueprintSection["mode"];
            onChange(
              mode === "fixed" && section.fixedText === undefined
                ? { mode, fixedText: "" }
                : { mode },
            );
          }}
          className="rounded-[3px] border border-ink/20 bg-transparent px-[5px] py-[2px] font-mono text-[10px] uppercase tracking-[1px] text-ink/60"
        >
          {MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {section.mode === "fixed" ? (
        <div className="mt-[12px]">
          <AutoTextarea
            ariaLabel="fixed text"
            value={section.fixedText ?? ""}
            onChange={(v) => onChange({ fixedText: v })}
            placeholder="Write the fixed copy for this section…"
            minRows={3}
            className="font-serif text-[14.5px] leading-[1.8] text-ink placeholder:italic placeholder:text-ink/40"
          />
        </div>
      ) : (
        <>
          <div className="mt-[12px]">
            <AutoTextarea
              ariaLabel="instruction"
              value={section.instruction}
              onChange={(v) => onChange({ instruction: v })}
              placeholder="Describe what the agent should write here…"
              minRows={2}
              className="font-serif text-[14.5px] italic leading-[1.7] text-ink/65 placeholder:text-ink/40"
            />
          </div>
          <div className="mt-[18px]">
            <Greeked lines={4} caption={caption} />
          </div>
        </>
      )}

      <RulesEditor rules={section.rules} onChange={(rules) => onChange({ rules })} />
    </div>
  );
}

/** A non-selected section: heading + first instruction line + thin greeked stub. */
function CondensedSection({
  section,
  onSelect,
}: {
  section: BlueprintSection;
  onSelect: () => void;
}) {
  const firstLine = (section.instruction || section.fixedText || "").split("\n")[0];
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={`center-section-${section.key}`}
      className="mt-[30px] block w-full text-left"
    >
      <div className="font-serif text-[19px] font-medium text-ink">{section.heading}</div>
      {firstLine ? (
        <div className="mt-[8px] font-serif text-[13.5px] italic leading-[1.7] text-ink/55">
          {firstLine}
        </div>
      ) : null}
      <div
        className="mt-[12px] h-[40px]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(32,26,21,0.07) 0 9px, transparent 9px 20px)",
        }}
      />
    </button>
  );
}

/**
 * The center document page. The masthead (eyebrow · title · dateline) and the
 * selected section edit in place; every other section renders as a condensed,
 * click-to-select stub so the whole document stays visible while you work on one
 * part of it.
 */
export function SectionEditor({
  content,
  selectedKey,
  onChange,
  onSelect,
  labelFor,
}: {
  content: BlueprintContent;
  selectedKey: string;
  onChange: (next: BlueprintContent) => void;
  onSelect: (key: string) => void;
  labelFor: (id: string) => string;
}) {
  function patchContent(patch: Partial<BlueprintContent>) {
    onChange({ ...content, ...patch });
  }
  function patchSection(key: string, patch: Partial<BlueprintSection>) {
    onChange({
      ...content,
      sections: content.sections.map((s) => (s.key === key ? { ...s, ...patch } : s)),
    });
  }

  const eyebrow = (
    <input
      aria-label="eyebrow"
      value={content.eyebrow}
      onChange={(e) => patchContent({ eyebrow: e.target.value })}
      className="w-full bg-transparent font-sans text-[9.5px] font-semibold uppercase tracking-[2.5px] text-ink/50 outline-none"
    />
  );
  const title = (
    <input
      aria-label="title"
      value={content.title}
      onChange={(e) => patchContent({ title: e.target.value })}
      className="w-full bg-transparent font-serif text-[33px] font-medium leading-[1.15] text-ink outline-none"
    />
  );
  const dateline = (
    <input
      aria-label="dateline"
      value={content.dateline}
      onChange={(e) => patchContent({ dateline: e.target.value })}
      className="w-full bg-transparent font-serif text-[14px] italic text-ink/55 outline-none"
    />
  );

  return (
    <DocumentPage eyebrow={eyebrow} title={title} dateline={dateline}>
      {content.sections.map((section) =>
        section.key === selectedKey ? (
          <SelectedSection
            key={section.key}
            section={section}
            labelFor={labelFor}
            onChange={(patch) => patchSection(section.key, patch)}
          />
        ) : (
          <CondensedSection
            key={section.key}
            section={section}
            onSelect={() => onSelect(section.key)}
          />
        ),
      )}
    </DocumentPage>
  );
}
