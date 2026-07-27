import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import type { CompanyBranding, CompanySettings } from "../../api/contracts.js";
import { CompanyBrandingProvider } from "../../app/CompanyBrandingContext.js";
import { i18nInstance } from "../../localization/i18n.js";
import { CompanyConfigurationWorkspace } from "./CompanyConfigurationWorkspace.js";

const settings: CompanySettings = {
  baseCurrency: "AED",
  defaultLanguage: "en",
  documentExpiryAlertDays: null,
  orderPendingAlertHours: null,
  timezone: "Asia/Dubai",
  vatEnabled: false,
  vatPriceMode: null,
  vatRate: null,
};

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

function makeApi() {
  return {
    delete: vi.fn(),
    get: vi.fn((path: string) => {
      if (path === "configuration/settings") return Promise.resolve(settings);
      if (path === "company-profile/branding") return Promise.resolve(branding);
      if (path === "me/preferences") return Promise.resolve({ textLanguage: "en" });
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

function renderGeneral(api: ReturnType<typeof makeApi>, permissions: readonly string[]) {
  return render(
    <CompanyBrandingProvider api={api as unknown as ApiClient}>
      <CompanyConfigurationWorkspace
        api={api as unknown as ApiClient}
        permissions={permissions}
        view="general"
      />
    </CompanyBrandingProvider>,
  );
}

describe("CompanyConfigurationWorkspace general view", () => {
  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
    document.documentElement.dir = "ltr";
  });

  it("shows Company settings and My Display Preferences to an administrator", async () => {
    const api = makeApi();
    renderGeneral(api, ["users_roles.manage"]);
    expect(await screen.findByLabelText("Default language")).toBeInTheDocument();
    expect(screen.getByText("My Display Preferences")).toBeInTheDocument();
  });

  it("shows only My Display Preferences to a user without the configuration permission", async () => {
    const api = makeApi();
    renderGeneral(api, ["orders.create"]);
    expect(await screen.findByText("My Display Preferences")).toBeInTheDocument();
    // Admin-only Company settings are hidden and never requested.
    expect(screen.queryByLabelText("Default language")).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalledWith("configuration/settings");
  });

  it("lets a non-admin change only their own Search and Display Text without touching UI/direction", async () => {
    const api = makeApi();
    renderGeneral(api, ["orders.create"]);
    const group = await screen.findByRole("group", { name: "Search and Display Text" });
    fireEvent.click(within(group).getByRole("button", { name: "العربية" }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith("me/preferences/text-language", {
        textLanguage: "ar",
      }),
    );
    expect(i18nInstance.language).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
  });
});
