// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { BlueprintContent } from "@runoff/core";

// `vi.mock` factories are hoisted; the fns they close over come from `vi.hoisted`.
const {
  showToast,
  saveRevision,
  patchBlueprint,
  createRun,
  getBlueprint,
  getCopilotThread,
  push,
} = vi.hoisted(() => ({
  showToast: vi.fn(),
  saveRevision: vi.fn(async () => ({ rev: 2 })),
  patchBlueprint: vi.fn(async () => ({ ok: true })),
  createRun: vi.fn(async () => ({ id: "run_x" })),
  getBlueprint: vi.fn(),
  getCopilotThread: vi.fn(async () => ({ messages: [] })),
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
  getCopilotThread,
}));

import { Builder } from "../components/builder/Builder";
import type { SourceRow } from "../lib/api";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  getCopilotThread.mockResolvedValue({ messages: [] });
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
  { id: "src_a", name: "GA4", kind: "api", storedFilename: "", mime: "", size: 0, uploadedAt: new Date().toISOString() },
  { id: "src_b", name: "spend.csv", kind: "file", storedFilename: "", mime: "", size: 0, uploadedAt: new Date().toISOString() },
];

function renderBuilder(overrides?: { content?: BlueprintContent }) {
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

describe("primary-action failure feedback", () => {
  it("flips the status badge to ACTIVE after a successful publish", async () => {
    const { getByText } = renderBuilder();
    expect(getByText("DRAFT · REV 1")).toBeTruthy();
    fireEvent.click(getByText("Publish"));
    await waitFor(() => expect(patchBlueprint).toHaveBeenCalledWith("bp", { status: "active" }));
    await waitFor(() => expect(getByText("ACTIVE · REV 1")).toBeTruthy());
    expect(showToast).toHaveBeenCalledWith("Published");
  });

  it("surfaces a publish/save failure and keeps the draft dirty", async () => {
    saveRevision.mockRejectedValueOnce(new Error("network"));
    const { getByLabelText, getByText, queryByText } = renderBuilder();
    fireEvent.change(getByLabelText("title"), { target: { value: "Edited" } });
    fireEvent.click(getByText("Publish"));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Publish failed")),
    );
    // Save never succeeded, so status is not patched and the draft stays dirty.
    expect(patchBlueprint).not.toHaveBeenCalled();
    expect(getByText("Save · REV 2")).toBeTruthy();
    expect(queryByText("ACTIVE · REV 1")).toBeNull();
  });
});
