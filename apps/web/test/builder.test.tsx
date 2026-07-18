// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { BlueprintContent } from "@runoff/core";

// `vi.mock` factories are hoisted; the fns they close over come from `vi.hoisted`.
const {
  showToast,
  saveRevision,
  patchBlueprint,
  createRun,
  getBlueprint,
  acceptNote,
  getNotes,
  postNote,
  resolveNote,
  push,
} = vi.hoisted(() => ({
  showToast: vi.fn(),
  saveRevision: vi.fn(async () => ({ rev: 2 })),
  patchBlueprint: vi.fn(async () => ({ ok: true })),
  createRun: vi.fn(async () => ({ id: "run_x" })),
  getBlueprint: vi.fn(),
  acceptNote: vi.fn(async () => ({ rev: 3 })),
  getNotes: vi.fn(async () => ({ notes: [] })),
  postNote: vi.fn(async () => ({ agentNote: { id: "a1", author: "agent", body: "Done.", proposedEdit: null, status: "open", createdAt: new Date().toISOString() } })),
  resolveNote: vi.fn(async () => ({ ok: true })),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: React.ReactNode }) => (
    <a href={typeof href === "string" ? href : "#"} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/Toast", () => ({ showToast, Toast: () => null }));
vi.mock("@/lib/api", () => ({
  saveRevision,
  patchBlueprint,
  createRun,
  getBlueprint,
  acceptNote,
  getNotes,
  postNote,
  resolveNote,
}));

import { Builder } from "../components/builder/Builder";
import type { SourceRow, NoteRow } from "../lib/api";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  getNotes.mockResolvedValue({ notes: [] });
});

const baseContent: BlueprintContent = {
  title: "Monthly Performance Report",
  clientName: "Meridian Retail",
  eyebrow: "PREPARED FOR MERIDIAN",
  dateline: "June 2026",
  sections: [
    { key: "s1", number: 1, heading: "Overview", mode: "fixed", fixedText: "Fixed copy.", instruction: "", sourceIds: [], rules: [] },
    { key: "s2", number: 2, heading: "Executive summary", mode: "review", instruction: "Summarize the month.", sourceIds: ["src_a"], rules: [] },
    { key: "s3", number: 3, heading: "Channels", mode: "auto", instruction: "Channel breakdown.", sourceIds: ["src_a", "src_b"], rules: [] },
  ],
  globalRules: [],
  delivery: { recipient: "x@y.com", autoDeliverOnClear: false },
};

const sources: SourceRow[] = [
  { id: "src_a", name: "GA4", kind: "api", storedFilename: "", mime: "", size: 0, uploadedAt: new Date().toISOString(), refreshedAt: null },
  { id: "src_b", name: "spend.csv", kind: "file", storedFilename: "", mime: "", size: 0, uploadedAt: new Date().toISOString(), refreshedAt: null },
];

function renderBuilder(overrides?: { initialNotes?: NoteRow[]; content?: BlueprintContent }) {
  const content = overrides?.content ?? baseContent;
  return render(
    <Builder
      blueprintId="bp"
      name="Monthly Performance Report"
      clientName="Meridian Retail"
      initialStatus="draft"
      initialRev={1}
      initialContent={content}
      allSources={sources}
      initialBoundIds={["src_a"]}
      initialSectionKey="s1"
      initialNotes={overrides?.initialNotes ?? []}
    />,
  );
}

describe("ContentsRail", () => {
  it("derives the badge from each section's mode/sources and marks the selected row", () => {
    const { getByText, getByTestId } = renderBuilder();
    expect(getByText("FIXED")).toBeTruthy();
    expect(getByText("REVIEW")).toBeTruthy();
    expect(getByText("2 SRC")).toBeTruthy();
    // s1 is selected on load; its row carries the wash + spine.
    expect(getByTestId("toc-row-s1").getAttribute("aria-current")).toBe("true");
    expect(getByTestId("toc-row-s1").className).toContain("bg-wash");
  });

  it("selects a section on click and swaps the center editor to it", () => {
    const { getByTestId, getByLabelText } = renderBuilder();
    fireEvent.click(getByTestId("toc-row-s2"));
    expect(getByTestId("toc-row-s2").getAttribute("aria-current")).toBe("true");
    expect((getByLabelText("instruction") as HTMLTextAreaElement).value).toBe("Summarize the month.");
  });
});

describe("add section", () => {
  it("appends a default auto section, selects it, and marks the draft dirty", () => {
    const { getByText, getByLabelText } = renderBuilder();
    fireEvent.click(getByText("+ add a section…"));
    // New section becomes the selected one (its heading edits in place).
    expect((getByLabelText("section heading") as HTMLInputElement).value).toBe("New section");
    // Numbered next (04) and the save pill (rev 1 → 2) now shows.
    expect(getByText("Save · REV 2")).toBeTruthy();
  });
});

describe("save flow", () => {
  it("saves the edited content as a new revision and toasts", async () => {
    const { getByLabelText, getByText } = renderBuilder();
    fireEvent.change(getByLabelText("title"), { target: { value: "Q2 Report" } });
    fireEvent.click(getByText("Save · REV 2"));
    await waitFor(() =>
      expect(saveRevision).toHaveBeenCalledWith("bp", expect.objectContaining({ title: "Q2 Report" })),
    );
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Saved as REV 2"));
  });

  it("saves before previewing a run and pushes to the new run", async () => {
    const { getByLabelText, getByText } = renderBuilder();
    fireEvent.change(getByLabelText("title"), { target: { value: "Edited" } });
    fireEvent.click(getByText("Preview run"));
    await waitFor(() => expect(saveRevision).toHaveBeenCalled());
    await waitFor(() => expect(createRun).toHaveBeenCalledWith("bp"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/runs/run_x"));
  });
});

describe("MarginNotes", () => {
  const editNote: NoteRow = {
    id: "n1",
    author: "agent",
    body: "Accept the rewrite?",
    proposedEdit: { field: "instruction", edits: [{ find: "broadly in line", replace: "down 12.4%" }] },
    status: "open",
    createdAt: new Date().toISOString(),
  };

  it("renders a proposed edit as strike/underline and Accept applies it", async () => {
    getBlueprint.mockResolvedValue({
      blueprint: { id: "bp", name: "n", clientName: "c", status: "draft", currentRev: 3, createdAt: "" },
      content: baseContent,
      sources: [],
    });
    const { getByText } = renderBuilder({ initialNotes: [editNote] });
    expect(getByText("broadly in line").className).toContain("line-through");
    expect(getByText("down 12.4%").className).toContain("border-b-2");

    fireEvent.click(getByText("Accept"));
    await waitFor(() => expect(acceptNote).toHaveBeenCalledWith("n1"));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Edit applied — REV 3"));
    await waitFor(() => expect(getBlueprint).toHaveBeenCalledWith("bp"));
  });

  it("posts a note optimistically then shows the agent reply", async () => {
    const d = (() => {
      let resolve!: (v: { agentNote: NoteRow }) => void;
      const promise = new Promise<{ agentNote: NoteRow }>((r) => (resolve = r));
      return { promise, resolve };
    })();
    postNote.mockReturnValueOnce(d.promise);

    const { getByLabelText, getByText, queryByText } = renderBuilder();
    fireEvent.change(getByLabelText("note to the agent"), { target: { value: "Tighten the intro" } });
    fireEvent.keyDown(getByLabelText("note to the agent"), { key: "Enter" });

    // Optimistic user card + annotating line appear before the agent replies.
    expect(getByText("Tighten the intro")).toBeTruthy();
    expect(getByText("Agent is annotating…")).toBeTruthy();
    expect(postNote).toHaveBeenCalledWith("bp", { sectionKey: "s1", body: "Tighten the intro" });

    await act(async () => {
      d.resolve({ agentNote: { id: "a9", author: "agent", body: "Done — folded in.", proposedEdit: null, status: "open", createdAt: new Date().toISOString() } });
    });
    expect(getByText("Done — folded in.")).toBeTruthy();
    expect(queryByText("Agent is annotating…")).toBeNull();
  });

  it("toasts when sending an empty note", () => {
    const { getByText } = renderBuilder();
    fireEvent.click(getByText("Send"));
    expect(showToast).toHaveBeenCalledWith("Type a note first.");
  });
});
