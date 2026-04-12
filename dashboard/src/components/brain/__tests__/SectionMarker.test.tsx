import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SectionMarker } from "../SectionMarker";

describe("SectionMarker", () => {
  it("renders the label text", () => {
    render(<SectionMarker label="SOURCES" />);
    expect(screen.getByText("SOURCES")).toBeInTheDocument();
  });

  it("renders the hairline rule", () => {
    const { container } = render(<SectionMarker label="TREE" />);
    const rule = container.querySelector("[class*='flex-1']");
    expect(rule).toBeInTheDocument();
  });
});
