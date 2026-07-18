// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { Block } from "@runoff/core";

import { SectionBlocks } from "../components/doc/SectionBlocks";
import { DocumentPage } from "../components/doc/DocumentPage";
import { CitationChip } from "../components/doc/CitationChip";
import { Greeked } from "../components/doc/Greeked";

afterEach(cleanup);

const paragraph: Block = {
  type: "paragraph",
  spans: [
    { text: "Revenue closed at $2.41M" },
    { text: " down 12.4%", citation: { sourceId: "src_ga4", locator: "rev" } },
    { text: ", a cost problem." },
  ],
};

const table: Block = {
  type: "table",
  columns: ["Metric", "June", "Δ MoM", "Source"],
  rows: [
    {
      cells: [
        [{ text: "Revenue" }],
        [{ text: "$2.41M" }],
        [{ text: "▼ 12.4%" }],
        [{ text: "GA4" }],
      ],
    },
    {
      cells: [
        [{ text: "Pipeline" }],
        [{ text: "$940k" }],
        [{ text: "▲ 6.2%" }],
        [{ text: "CRM" }],
      ],
    },
  ],
};

describe("SectionBlocks", () => {
  it("renders paragraph text", () => {
    const { getByText } = render(<SectionBlocks blocks={[paragraph]} />);
    expect(getByText(/Revenue closed at \$2\.41M/)).toBeTruthy();
    expect(getByText(/a cost problem/)).toBeTruthy();
  });

  it("appends a citation chip with the resolved short label", () => {
    // Explicit map wins for the first source; the second falls back to the tail.
    const { getByText } = render(
      <SectionBlocks
        blocks={[paragraph]}
        sourceLabels={{ src_ga4: "GA4" }}
      />
    );
    const chip = getByText("GA4");
    expect(chip.className).toContain("text-cite");
  });

  it("falls back to the sourceId tail (uppercased) when no label is mapped", () => {
    const cited: Block = {
      type: "paragraph",
      spans: [{ text: "x", citation: { sourceId: "src_crm", locator: "a" } }],
    };
    const { getByText } = render(<SectionBlocks blocks={[cited]} />);
    expect(getByText("CRM")).toBeTruthy();
  });

  it("renders a negative delta cell in red pencil", () => {
    const { container } = render(<SectionBlocks blocks={[table]} />);
    // The pencil class lives on the cell wrapper; only the negative delta has it.
    const pencilCells = Array.from(container.querySelectorAll(".text-pencil"));
    expect(pencilCells.map((el) => el.textContent)).toEqual(["▼ 12.4%"]);
    // The metric (first) column is serif, never pencil.
    const firstCell = container.querySelector(".font-serif") as HTMLElement;
    expect(firstCell.textContent).toBe("Revenue");
  });

  it("wraps a span with the node returned by annotate", () => {
    const { getByTestId } = render(
      <SectionBlocks
        blocks={[paragraph]}
        annotate={(span) =>
          span.text.includes("cost problem") ? (
            <mark data-testid="flag" className="bg-amber-accent/30" />
          ) : null
        }
      />
    );
    const mark = getByTestId("flag");
    expect(mark.tagName).toBe("MARK");
    expect(mark.textContent).toContain("a cost problem");
  });

  it("renders plainly when annotate returns null", () => {
    const { container } = render(
      <SectionBlocks blocks={[paragraph]} annotate={() => null} />
    );
    expect(container.querySelector("mark")).toBeNull();
  });
});

describe("DocumentPage / CitationChip / Greeked", () => {
  it("renders the masthead and children", () => {
    const { getByText } = render(
      <DocumentPage
        eyebrow="prepared for meridian"
        title="Monthly Performance Report"
        dateline="June 1 – June 30, 2026"
      >
        <SectionBlocks blocks={[paragraph]} />
      </DocumentPage>
    );
    expect(getByText("Monthly Performance Report").tagName).toBe("H1");
    expect(getByText("prepared for meridian").className).toContain("uppercase");
    expect(getByText(/Revenue closed at/)).toBeTruthy();
  });

  it("CitationChip shows its label", () => {
    const { getByText } = render(<CitationChip label="CSV" />);
    expect(getByText("CSV").className).toContain("text-cite");
  });

  it("Greeked renders a caption and sizes by lines", () => {
    const { getByText, container } = render(
      <Greeked lines={5} caption="channel tables render here at run time" />
    );
    expect(getByText(/channel tables render here/)).toBeTruthy();
    // The greeked stripe is the only element carrying an inline style.
    const stripe = container.querySelector("div[style]") as HTMLElement;
    expect(stripe.style.height).toBe("100px");
  });
});
