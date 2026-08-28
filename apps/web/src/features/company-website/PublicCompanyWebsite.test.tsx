import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isPublicCompanyWebsiteHost, PublicCompanyWebsite } from "./PublicCompanyWebsite.js";

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState({}, "", "/");
});

describe("public Company website shell", () => {
  it("simulates a public Company host locally without treating an app host as public", () => {
    history.replaceState({}, "", "/?companyWebsiteHost=dana.tawseelhub.com");
    expect(isPublicCompanyWebsiteHost()).toBe(true);
    history.replaceState({}, "", "/?companyWebsiteHost=danaapp.tawseelhub.com");
    expect(isPublicCompanyWebsiteHost()).toBe(false);
  });

  it("renders only real published Company fields", async () => {
    history.replaceState({}, "", "/?companyWebsiteHost=dana.tawseelhub.com");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          availability: "published",
          slug: "dana",
          defaultLocale: "en",
          settings: {
            branding: { primaryColor: "#aa0000" },
            languages: { en: true, ar: false, defaultLocale: "en" },
            presentation: {},
            contact: {
              email: "hello@dana.test",
              whatsappEnabled: false,
              showPhone: false,
              showEmail: true,
              showWhatsapp: false,
              showAddress: false,
              showWorkingHours: false,
              workingHours: [],
            },
            services: [],
            coverage: [],
            benefits: [],
            socialLinks: {},
            sections: [],
          },
          company: {
            nameEn: "Dana Delivery",
            nameAr: null,
            subtitleEn: "Local delivery",
            subtitleAr: null,
            telephone: null,
            email: null,
            addressEn: null,
            addressAr: null,
            hasLogo: false,
          },
        }),
      }),
    );
    render(<PublicCompanyWebsite />);
    expect(await screen.findByRole("heading", { name: "Dana Delivery" })).toBeInTheDocument();
    expect(screen.getByText("hello@dana.test")).toBeInTheDocument();
    expect(screen.queryByText(/phone/i)).not.toBeInTheDocument();
  });

  it("shows the safe unavailable page for disabled websites", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ availability: "disabled" }) }),
    );
    render(<PublicCompanyWebsite />);
    await waitFor(() =>
      expect(screen.getByText("This website is currently unavailable.")).toBeInTheDocument(),
    );
    expect(document.querySelector('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex,nofollow",
    );
  });

  it("tracks from the homepage using only approved public status fields", async () => {
    history.replaceState({}, "", "/?companyWebsiteHost=dana.tawseelhub.com");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          availability: "published",
          slug: "dana",
          settings: {
            branding: {},
            languages: { en: true, ar: false, defaultLocale: "en" },
            presentation: {},
            contact: {
              whatsappEnabled: false,
              showPhone: false,
              showEmail: false,
              showWhatsapp: false,
              showAddress: false,
              showWorkingHours: false,
              workingHours: [],
            },
            services: [],
            coverage: [],
            benefits: [],
            socialLinks: {},
            functions: { trackingEnabled: true, requestDeliveryEnabled: false },
            sections: [],
          },
          company: {
            nameEn: "Dana",
            nameAr: null,
            subtitleEn: null,
            subtitleAr: null,
            telephone: null,
            email: null,
            addressEn: null,
            addressAr: null,
            hasLogo: false,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          reference: "DN-2026-1",
          status: "out_for_delivery",
          deliveredAt: null,
          lastUpdatedAt: "2026-08-28T14:40:00Z",
          company: { nameEn: "Dana", nameAr: null },
          timeline: [
            { status: "order_received", occurredAt: "2026-08-28T10:20:00Z" },
            { status: "out_for_delivery", occurredAt: "2026-08-28T14:40:00Z" },
          ],
          customerName: "Confidential Customer",
          customerMobile: "0500000000",
          customerEmail: "private@example.com",
          customerAddress: "Private address",
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicCompanyWebsite />);
    const input = await screen.findByRole("textbox", { name: "Shipment reference" });
    fireEvent.change(input, { target: { value: "a".repeat(43) } });
    fireEvent.click(screen.getByRole("button", { name: "Track" }));
    expect((await screen.findAllByText(/Out for Delivery/u)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Order Received")).toBeInTheDocument();
    expect(
      screen.queryByText(/Confidential Customer|0500000000|private@example.com|Private address/u),
    ).not.toBeInTheDocument();
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/public/company-website/track");
  });

  it("renders enabled Arabic in RTL and offers only the alternate language", async () => {
    history.replaceState({}, "", "/?companyWebsiteHost=dana.tawseelhub.com&lang=ar");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          availability: "published",
          slug: "dana",
          templateKey: "corporate",
          defaultLocale: "en",
          settings: {
            branding: {},
            languages: { en: true, ar: true, defaultLocale: "en" },
            presentation: { displayName: { en: "Dana", ar: "دانا" } },
            contact: {
              whatsappEnabled: false,
              showPhone: false,
              showEmail: false,
              showWhatsapp: false,
              showAddress: false,
              showWorkingHours: false,
              workingHours: [],
            },
            services: [],
            coverage: [],
            benefits: [],
            socialLinks: {},
            sections: [],
          },
          company: {
            nameEn: "Dana",
            nameAr: "دانا",
            subtitleEn: null,
            subtitleAr: null,
            telephone: null,
            email: null,
            addressEn: null,
            addressAr: null,
            hasLogo: false,
          },
        }),
      }),
    );
    const { container } = render(<PublicCompanyWebsite />);
    expect(await screen.findByRole("heading", { level: 1, name: "دانا" })).toBeInTheDocument();
    expect(container.querySelector('[dir="rtl"]')).not.toBeNull();
    expect(screen.getByRole("heading", { name: "تتبع الشحنة مباشرة" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "EN" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "AR" })).not.toBeInTheDocument();
  });
});
