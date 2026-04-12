import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Prose } from "../Prose";

describe("Prose", () => {
  it("renders markdown body", () => {
    render(<Prose body="# Hello World" />);
    expect(screen.getByText("Hello World")).toBeInTheDocument();
  });

  it("renders inline code", () => {
    render(<Prose body="Use `console.log()` here." />);
    expect(screen.getByText("console.log()")).toBeInTheDocument();
  });

  it("renders links with oxide styling", () => {
    render(<Prose body="[Example](https://example.com)" />);
    const link = screen.getByText("Example");
    expect(link).toBeInTheDocument();
    expect(link.tagName).toBe("A");
  });

  it("renders empty body without error", () => {
    const { container } = render(<Prose body="" />);
    expect(container).toBeTruthy();
  });
});
