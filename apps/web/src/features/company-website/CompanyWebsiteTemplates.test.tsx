import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
  it("registers exactly twenty stable templates", () => {
    expect(Object.keys(COMPANY_WEBSITE_TEMPLATES)).toEqual([
      "corporate",
      "modern",
      "express",
      "local",
      "premium",
      "skyline",
      "minimal",
      "bold",
      "elegant",
      "urban",
      "swift",
      "horizon",
      "nexus",
      "oasis",
      "fleet",
      "commerce",
      "courier",
      "executive",
      "vibrant",
      "classic",
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

  it.each(Object.keys(COMPANY_WEBSITE_TEMPLATES) as CompanyWebsiteTemplateKey[])(
    "carries site-template--has-banner alongside the %s template class when a banner image is set, for every template -- not just the ones without their own hero sizing",
    (key) => {
      // Several named templates style `.site-template__hero` for the
      // text-only, no-banner case (e.g. `--premium`'s large `min-height`) at
      // the SAME selector specificity as the shared banner-compaction rule
      // in company-website-banner.css. Both classes landing on the same
      // element is what lets that shared rule's `!important` win regardless
      // of which template a Company picked -- this locks in that contract
      // so a future template can't silently drop the class and reintroduce
      // an oversized, cropped banner.
      const { container, unmount } = render(
        <>{renderCompanyWebsiteTemplate(key, { ...content, bannerUrls: ["data:image/png;base64,AA=="] })}</>,
      );
      const hero = container.querySelector(`[data-template="${key}"]`);
      expect(hero).not.toBeNull();
      expect(hero?.className).toContain("site-template--has-banner");
      expect(hero?.className).toContain(`site-template--${key}`);
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
          language: "ar",
          coverage: [{ id: "uae", emirate: "الإمارات" }],
          alternateLanguage: { label: "EN", url: "?lang=en" },
        })}
      </>,
    );
    expect(container.querySelector('[dir="rtl"]')).not.toBeNull();
    expect(screen.getByRole("link", { name: "EN" })).toHaveAttribute("href", "?lang=en");
    expect(screen.getByRole("heading", { name: "مناطق التغطية" })).toBeInTheDocument();
  });

  it("renders shared marketing sections with Arabic headings", () => {
    render(
      <>
        {renderCompanyWebsiteTemplate("modern", {
          ...content,
          direction: "rtl",
          language: "ar",
          marketing: {
            steps: [{ id: "collect", title: "نستلم الطلب" }],
            industries: [{ id: "retail", title: "التجزئة" }],
            statistics: [{ id: "daily", title: "+٤٠٠٠", description: "توصيل يومي" }],
            testimonials: [{ id: "review", title: "عميل دانا", description: "خدمة موثوقة" }],
          },
          coverage: [{ id: "uae", emirate: "الإمارات" }],
        })}
      </>,
    );
    expect(screen.getByRole("heading", { name: "كيف تعمل الخدمة" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "القطاعات التي نخدمها" })).toBeInTheDocument();
    expect(screen.getByText("خدمة موثوقة")).toBeInTheDocument();
  });

  it.each(Object.keys(COMPANY_WEBSITE_TEMPLATES) as CompanyWebsiteTemplateKey[])(
    "renders the shared three-banner gallery in %s",
    (key) => {
      const { container, unmount } = render(
        <>
          {renderCompanyWebsiteTemplate(key, {
            ...content,
            bannerUrls: [
              "data:image/png;base64,AA==",
              "data:image/png;base64,AQ==",
              "data:image/png;base64,Ag==",
            ],
            bannerTransition: "slide",
            bannerIntervalSeconds: 4,
          })}
        </>,
      );
      expect(container.querySelector(".site-template__banner--slide img")).toHaveAttribute(
        "src",
        "data:image/png;base64,AA==",
      );
      fireEvent.click(screen.getByRole("button", { name: "Next banner" }));
      expect(container.querySelector(".site-template__banner--slide img")).toHaveAttribute(
        "src",
        "data:image/png;base64,AQ==",
      );
      expect(screen.getByRole("button", { name: "Show banner 2" })).toHaveAttribute(
        "aria-current",
        "true",
      );
      unmount();
    },
  );

  it("rotates banners automatically at the configured interval", () => {
    vi.useFakeTimers();
    const { container, unmount } = render(
      <>
        {renderCompanyWebsiteTemplate("corporate", {
          ...content,
          bannerUrls: ["data:image/png;base64,AA==", "data:image/png;base64,AQ=="],
          bannerTransition: "fade",
          bannerIntervalSeconds: 4,
        })}
      </>,
    );
    act(() => vi.advanceTimersByTime(4_000));
    expect(container.querySelector(".site-template__banner--fade img")).toHaveAttribute(
      "src",
      "data:image/png;base64,AQ==",
    );
    unmount();
    vi.useRealTimers();
  });
});
