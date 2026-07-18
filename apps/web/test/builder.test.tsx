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
import type { FamilySummary } from "../lib/api";

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
    { key: "s1", number: 1, heading: "Overview", mode: "fixed", fixedText: "Fixed copy.", instruction: "", familyIds: [], rules: [] },
    { key: "s2", number: 2, heading: "Executive summary", mode: "review", instruction: "Summarize the month.", familyIds: ["src_a"], rules: [] },
    { key: "s3", number: 3, heading: "Channels", mode: "auto", instruction: "Channel breakdown.", familyIds: ["src_a", "src_b"], rules: [] },
  ],
  globalRules: [],
  delivery: { recipient: "x@y.com", autoDeliverOnClear: false },
};

function fam(
  id: string,
  key: string,
  label: string,
  kind: "periodic" | "constant",
  granularity: FamilySummary["granularity"],
): FamilySummary {
  return { id, key, label, kind, granularity, filedPeriods: [], filedEntries: [], liveFile: null };
}

const families: FamilySummary[] = [
  fam("fam_q", "trade", "Trade data", "periodic", "quarter"),
  fam("fam_m", "ga4", "GA4", "periodic", "month"),
  fam("fam_c", "brand", "Brand", "constant", null),
];

function renderBuilder(overrides?: { content?: BlueprintContent; boundIds?: string[] }) {
  const content = overrides?.content ?? baseContent;
  return render(
    <Builder
      blueprintId="bp"
      name="Monthly Performance Report"
      clientName="Meridian Retail"
      projectId="proj_1"
      projectName="Meridian Retail"
      initialStatus="draft"
      initialRev={1}
      initialContent={content}
      families={families}
      initialBoundIds={overrides?.boundIds ?? []}
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

describe("ContentsRail source binding", () => {
  it("shows the discoverable + bind sources… affordance when nothing is bound and opens edit mode", () => {
    const { getByText, getByLabelText } = renderBuilder();
    fireEvent.click(getByText("+ bind sources…"));
    // Edit mode: a checkbox per project family (labelled by key).
    expect(getByLabelText("trade")).toBeTruthy();
    expect(getByLabelText("ga4")).toBeTruthy();
    expect(getByLabelText("brand")).toBeTruthy();
    expect(getByText("done")).toBeTruthy();
  });

  it("locks out mismatched-granularity periodic families once one is ticked", () => {
    const { getByText, getByLabelText } = renderBuilder();
    fireEvent.click(getByText("+ bind sources…"));
    fireEvent.click(getByLabelText("trade")); // tick the quarter family
    // The month family is now disabled with the granularity hint; the constant
    // family stays free.
    expect((getByLabelText("ga4") as HTMLInputElement).disabled).toBe(true);
    expect(getByText("— granularity differs")).toBeTruthy();
    expect((getByLabelText("brand") as HTMLInputElement).disabled).toBe(false);
  });

  it("PATCHes { familyIds } when a family is toggled", async () => {
    const { getByText, getByLabelText } = renderBuilder();
    fireEvent.click(getByText("+ bind sources…"));
    fireEvent.click(getByLabelText("brand"));
    await waitFor(() =>
      expect(patchBlueprint).toHaveBeenCalledWith("bp", { familyIds: ["fam_c"] }),
    );
  });

  it("lists bound families with an edit-bindings affordance", () => {
    const { getByText } = renderBuilder({ boundIds: ["fam_q"] });
    expect(getByText("edit bindings…")).toBeTruthy();
    // The bound family surfaces its mono key + granularity tag.
    expect(getByText("quarter")).toBeTruthy();
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
