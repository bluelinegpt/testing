// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SeoGuidePublication } from "./SeoGuidePublication.js";

afterEach(cleanup);
const guide = { status: "published", slug: "delivery-management-software-uae", language: "ar" };
describe("SEO Guide publication details", () => {
  it("shows the published status and opens the Arabic page on the public domain", () => {
    render(<SeoGuidePublication guide={guide}/>);
    expect(screen.getByText("Published")).toBeTruthy();
    const link = screen.getByRole("link", { name: /Open published page/ });
    expect(link.getAttribute("href")).toBe("https://tawseelhub.com/ar/delivery-management-software-uae");
    expect(link.getAttribute("target")).toBe("_blank");
  });
  it("uses the English root route rather than an admin-domain or legacy guides URL", () => {
    render(<SeoGuidePublication guide={{...guide,language:"en"}}/>);
    expect(screen.getByRole("link", { name: /Open published page/ }).getAttribute("href"))
      .toBe("https://tawseelhub.com/delivery-management-software-uae");
  });
  it.each(["draft", "unpublished", "archived"])("does not advertise %s content as readable", (status) => {
    render(<SeoGuidePublication guide={{...guide,status}}/>);
    expect(screen.getByText("Planned public URL")).toBeTruthy();
    expect(screen.getByText(/Visitors cannot read/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("keeps a future scheduled page private and exposes a due scheduled page", () => {
    const {rerender}=render(<SeoGuidePublication guide={{...guide,status:"scheduled",scheduled_at:"2099-01-01T00:00:00Z"}}/>);
    expect(screen.getByText("Scheduled")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    rerender(<SeoGuidePublication guide={{...guide,status:"scheduled",scheduled_at:"2000-01-01T00:00:00Z"}}/>);
    expect(screen.getByRole("link",{name:/Open published page/})).toBeTruthy();
  });
});
