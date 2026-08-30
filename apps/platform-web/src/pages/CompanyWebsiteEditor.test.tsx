import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { platformApi, type CompanyWebsiteSettings } from "../api/platform-client.js";
import { CompanyWebsiteEditor } from "./CompanyWebsiteEditor.js";

const settings: CompanyWebsiteSettings = {
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
  marketing: { steps: [], industries: [], statistics: [], testimonials: [] },
  socialLinks: {},
  sections: [],
  knowledge: {
    audiences: [],
    packageTypes: [],
    cod: { supported: false },
    pricing: { mode: "request_confirmation" },
    faqs: [],
    instructions: {},
    tawseelhubAttribution: true,
  },
  agent: {
    enabled: false,
    suggestedActions: ["services", "coverage", "contact"],
    capabilities: {
      companyInformation: true,
      tracking: true,
      deliveryRequest: true,
      quoteGuidance: true,
      whatsappHandoff: true,
      contactHandoff: true,
      faqAnswers: true,
      socialLinks: true,
    },
    tone: "friendly_professional",
    unknownBehavior: "safe_response",
  },
};

describe("CompanyWebsiteEditor", () => {
  it("saves branding and content as a versioned draft", async () => {
    const save = vi.spyOn(platformApi, "configureCompanyWebsite").mockResolvedValue({
      status: "published",
      slug: "dana",
      templateKey: "modern",
      version: 8,
      settings,
    });
    render(
      <CompanyWebsiteEditor
        companyId="company-a"
        website={{ status: "published", slug: "dana", templateKey: "modern", version: 7, settings }}
        onFailure={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("primary color"), { target: { value: "#aa0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        "company-a",
        expect.objectContaining({
          expectedVersion: 7,
          settings: expect.objectContaining({ branding: { primaryColor: "#aa0000" } }),
        }),
      ),
    );
  });

  it("uploads the Website logo to Cloudflare instead of embedding it as base64", async () => {
    const upload = vi.spyOn(platformApi, "uploadCompanyWebsiteMedia").mockResolvedValue({
      url: "/api/v1/public/company-website/media/company-a/11111111-1111-1111-1111-111111111111.png",
    });
    render(
      <CompanyWebsiteEditor
        companyId="company-a"
        website={{ status: "published", slug: "dana", templateKey: "modern", version: 7, settings }}
        onFailure={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "logo.png", {
      type: "image/png",
    });
    fireEvent.change(
      screen.getByLabelText(/Website logo — separate from the Company Portal logo/u),
      { target: { files: [file] } },
    );
    await waitFor(() => expect(upload).toHaveBeenCalledWith("company-a", file));
    expect(await screen.findByAltText("Website logo preview")).toHaveAttribute(
      "src",
      "/api/v1/public/company-website/media/company-a/11111111-1111-1111-1111-111111111111.png",
    );
  });

  it("uploads a Homepage banner to Cloudflare instead of embedding it as base64", async () => {
    const upload = vi.spyOn(platformApi, "uploadCompanyWebsiteMedia").mockResolvedValue({
      url: "/api/v1/public/company-website/media/company-a/22222222-2222-2222-2222-222222222222.webp",
    });
    render(
      <CompanyWebsiteEditor
        companyId="company-a"
        website={{ status: "published", slug: "dana", templateKey: "modern", version: 7, settings }}
        onFailure={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const file = new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], "banner.webp", {
      type: "image/webp",
    });
    fireEvent.change(screen.getByLabelText(/Add Homepage banners — 0\/3 uploaded/u), {
      target: { files: [file] },
    });
    await waitFor(() => expect(upload).toHaveBeenCalledWith("company-a", file));
    expect(await screen.findByAltText("Homepage banner 1 preview")).toHaveAttribute(
      "src",
      "/api/v1/public/company-website/media/company-a/22222222-2222-2222-2222-222222222222.webp",
    );
  });

  it("shows a visible field-specific error and does not call the API for oversized About text", async () => {
    const save = vi.spyOn(platformApi, "configureCompanyWebsite");
    save.mockClear();
    render(
      <CompanyWebsiteEditor
        companyId="company-a"
        website={{
          status: "draft",
          slug: "dana",
          templateKey: "modern",
          version: 7,
          settings: {
            ...settings,
            presentation: { about: { en: "x".repeat(2001) } },
          },
        }}
        onFailure={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save Draft" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "About the company (EN) exceeds 2000 characters",
    );
    expect(save).not.toHaveBeenCalled();
  });
});
