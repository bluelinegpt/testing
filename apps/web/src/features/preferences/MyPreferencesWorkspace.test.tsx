import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import type { CompanyBranding } from "../../api/contracts.js";
import { CompanyBrandingProvider } from "../../app/CompanyBrandingContext.js";
import { i18nInstance } from "../../localization/i18n.js";
import { MyPreferencesWorkspace } from "./MyPreferencesWorkspace.js";

const branding: CompanyBranding = {
  dataQuality: { nameArMissing: false, subtitleArMissing: false, subtitleEnMissing: false },
  hasLogo: false,
  logoFileId: null,
  nameAr: "شركة",
  nameEn: "Company",
  subtitleAr: null,
  subtitleEn: null,
  telephone: null,
};

function makeApi(textLanguage: "en" | "ar" = "en") {
  return {
    delete: vi.fn(),
    get: vi.fn((path: string) => {
      if (path === "company-profile/branding") return Promise.resolve(branding);
      if (path === "me/preferences") return Promise.resolve({ textLanguage });
      return Promise.reject(new Error(`unexpected get ${path}`));
    }),
    getBinary: vi.fn(),
    patch: vi.fn().mockResolvedValue({ textLanguage: "ar" }),
    post: vi.fn(),
    postMultipart: vi.fn(),
    put: vi.fn(),
    setAccessToken: vi.fn(),
  };
}

function renderPage(api: ReturnType<typeof makeApi>) {
  return render(
    <CompanyBrandingProvider api={api as unknown as ApiClient}>
      <MyPreferencesWorkspace />
    </CompanyBrandingProvider>,
  );
}

describe("MyPreferencesWorkspace", () => {
  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
    document.documentElement.dir = "ltr";
  });

  it("lets any authenticated user set Search and Display Text and persists it", async () => {
    const api = makeApi("en");
    renderPage(api);
    // The page needs no company_profile.manage permission — it renders for any
    // signed-in user and shows the Search-and-Display control.
    expect(await screen.findByText("Search and Display Text")).toBeInTheDocument();

    const group = screen.getByRole("group", { name: "Search and Display Text" });
    fireEvent.click(within(group).getByRole("button", { name: "العربية" }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("me/preferences/text-language", {
        textLanguage: "ar",
      }),
    );
    expect(await screen.findByText("Preference saved.")).toBeInTheDocument();
    // Changing it must not alter the UI language or layout direction.
    expect(i18nInstance.language).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("reflects the stored preference on load", async () => {
    renderPage(makeApi("ar"));
    const group = await screen.findByRole("group", { name: "Search and Display Text" });
    expect(within(group).getByRole("button", { name: "العربية" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
