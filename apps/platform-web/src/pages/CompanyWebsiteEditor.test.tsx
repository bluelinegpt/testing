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
