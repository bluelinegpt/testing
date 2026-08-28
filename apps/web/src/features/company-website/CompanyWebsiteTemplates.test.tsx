import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  COMPANY_WEBSITE_TEMPLATES,
  renderCompanyWebsiteTemplate,
  type CompanyWebsiteTemplateKey,
} from "./CompanyWebsiteTemplates.js";

const content = {
  name: "Dana Delivery",
  description: "Delivery across the UAE.",
  phone: "+971500000000",
  email: "hello@dana.test",
  address: "Dubai, UAE",
  logoUrl: null,
  direction: "ltr" as const,
};

describe("Company website template registry", () => {
  it("registers exactly five stable templates", () => {
    expect(Object.keys(COMPANY_WEBSITE_TEMPLATES)).toEqual([
      "corporate",
      "modern",
      "express",
      "local",
      "premium",
    ]);
  });

  it.each(Object.keys(COMPANY_WEBSITE_TEMPLATES) as CompanyWebsiteTemplateKey[])(
    "renders %s with one accessible H1",
    (key) => {
      const { container, unmount } = render(<>{renderCompanyWebsiteTemplate(key, content)}</>);
      expect(screen.getByRole("heading", { level: 1, name: "Dana Delivery" })).toBeInTheDocument();
      expect(container.querySelector(`[data-template="${key}"]`)).not.toBeNull();
      unmount();
    },
  );

  it.each(Object.keys(COMPANY_WEBSITE_TEMPLATES) as CompanyWebsiteTemplateKey[])(
    "places the shared Real-Time Tracking section immediately after the %s hero",
    (key) => {
      const { container, unmount } = render(
        <>
          {renderCompanyWebsiteTemplate(key, {
            ...content,
            trackingSection: <section data-testid="tracking">Real-Time Tracking</section>,
          })}
        </>,
      );
      const hero = container.querySelector(".site-template__hero");
      expect(hero?.nextElementSibling).toHaveAttribute("data-testid", "tracking");
      unmount();
    },
  );

  it("hides missing contact fields instead of inventing them", () => {
    render(
      <>
        {renderCompanyWebsiteTemplate("local", {
          ...content,
          phone: null,
          email: null,
          address: null,
        })}
      </>,
    );
    expect(screen.queryByRole("heading", { name: "Let’s connect" })).not.toBeInTheDocument();
  });

  it.each(Object.keys(COMPANY_WEBSITE_TEMPLATES) as CompanyWebsiteTemplateKey[])(
    "applies shared branding and content to %s",
    (key) => {
      const { container, unmount } = render(
        <>
          {renderCompanyWebsiteTemplate(key, {
            ...content,
            theme: { primary: "#aa0000" },
            services: [{ id: "cod", title: "COD Delivery" }],
            coverage: [{ id: "dubai", emirate: "Dubai" }],
            benefits: [],
            workingHours: [],
            socialLinks: {},
            sections: [],
          })}
        </>,
      );
      expect(
        container
          .querySelector<HTMLElement>(`[data-template="${key}"]`)
          ?.style.getPropertyValue("--site-primary"),
      ).toBe("#aa0000");
      expect(screen.getByText("COD Delivery")).toBeInTheDocument();
      expect(screen.getByText("Dubai")).toBeInTheDocument();
      unmount();
    },
  );

  it("supports RTL and a language switch", () => {
    const { container } = render(
      <>
        {renderCompanyWebsiteTemplate("corporate", {
          ...content,
          name: "دانا",
          direction: "rtl",
          alternateLanguage: { label: "EN", url: "?lang=en" },
        })}
      </>,
    );
    expect(container.querySelector('[dir="rtl"]')).not.toBeNull();
    expect(screen.getByRole("link", { name: "EN" })).toHaveAttribute("href", "?lang=en");
  });
});
