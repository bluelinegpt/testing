import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import type { CompanyBranding } from "../../api/contracts.js";
import { CompanyBrandingProvider } from "../../app/CompanyBrandingContext.js";
import { i18nInstance } from "../../localization/i18n.js";
import { AreaSelector } from "./AreaSelector.js";

const emirates = [{ code: "DXB", id: "e1", nameAr: "دبي", nameEn: "Dubai" }];

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

function makeApi(textLanguage: "en" | "ar") {
  return {
    delete: vi.fn(),
    get: vi.fn((path: string) => {
      if (path === "configuration/emirates") return Promise.resolve(emirates);
      if (path === "company-profile/branding") return Promise.resolve(branding);
      if (path === "me/preferences") return Promise.resolve({ textLanguage });
      return Promise.reject(new Error(`unexpected get ${path}`));
    }),
    getBinary: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
    postMultipart: vi.fn(),
    put: vi.fn(),
    setAccessToken: vi.fn(),
  };
}

describe("AreaSelector Text Language", () => {
  beforeEach(async () => {
    // UI stays English throughout to prove display follows Text Language,
    // not the UI layout language.
    await i18nInstance.changeLanguage("en");
  });

  it("displays Emirate names in the Text Language even when the UI is English", async () => {
    const api = makeApi("ar");
    render(
      <CompanyBrandingProvider api={api as unknown as ApiClient}>
        <AreaSelector api={api as unknown as ApiClient} onChange={vi.fn()} value={undefined} />
      </CompanyBrandingProvider>,
    );
    expect(await screen.findByRole("option", { name: "دبي" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Dubai" })).not.toBeInTheDocument();
  });

  it("displays Emirate names in English when Text Language is English", async () => {
    const api = makeApi("en");
    render(
      <CompanyBrandingProvider api={api as unknown as ApiClient}>
        <AreaSelector api={api as unknown as ApiClient} onChange={vi.fn()} value={undefined} />
      </CompanyBrandingProvider>,
    );
    expect(await screen.findByRole("option", { name: "Dubai" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "دبي" })).not.toBeInTheDocument();
  });
});
