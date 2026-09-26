import { render, screen } from "@testing-library/react";

import { CodeText, Money, TraderText } from "./Bidi.js";

/**
 * Bidirectional safety.
 *
 * These assert ATTRIBUTES rather than appearance, because the browser's
 * bidirectional algorithm is what actually does the reordering and jsdom does
 * not run it. What this code controls is the isolation and direction it hands
 * that algorithm, so that is what is worth pinning down: a `<bdi dir="ltr">`
 * around a Product code is the whole fix, and losing it is the whole bug.
 */

describe("CodeText", () => {
  it("isolates an identifier and forces it left-to-right", () => {
    render(<CodeText value="DEV-ABAYA-0001" />);
    const node = screen.getByText("DEV-ABAYA-0001");
    // `bdi` isolates; `dir=ltr` stops an Arabic page flipping the segments.
    expect(node.tagName).toBe("BDI");
    expect(node).toHaveAttribute("dir", "ltr");
  });

  it("does not use dir=auto for codes", () => {
    // `auto` reads the first STRONG character. A code starting with a digit is
    // neutral, so `auto` would inherit RTL from the page and reorder the
    // hyphen-separated groups — showing a code that is not the code.
    render(<CodeText value="0001-ABAYA" />);
    expect(screen.getByText("0001-ABAYA")).toHaveAttribute("dir", "ltr");
  });
});

describe("Money", () => {
  it("keeps currency and amount together, isolated and LTR", () => {
    render(<Money amount="249.00" currency="AED" />);
    const node = screen.getByText("AED 249.00");
    expect(node.tagName).toBe("BDI");
    expect(node).toHaveAttribute("dir", "ltr");
  });
});

describe("TraderText", () => {
  it("detects direction rather than assuming it", () => {
    // A UAE marketplace has Arabic and English shop names in the same list, so
    // the direction has to come from the content, not from the page.
    render(<TraderText value="Dev Embroidered Abaya" />);
    expect(screen.getByText("Dev Embroidered Abaya")).toHaveAttribute("dir", "auto");
  });

  it("renders Trader content verbatim and never translates it", () => {
    render(<TraderText value="Dev Brand" />);
    expect(screen.getByText("Dev Brand")).toBeInTheDocument();
  });

  it("can be rendered as a heading without losing direction handling", () => {
    render(<TraderText as="h1" value="متجر تجريبي" />);
    const heading = screen.getByRole("heading", { name: "متجر تجريبي" });
    expect(heading).toHaveAttribute("dir", "auto");
  });
});
