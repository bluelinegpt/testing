import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../api/api-client.js";
import type { CompanyBranding, LoginResponse } from "../api/contracts.js";
import { i18nInstance } from "../localization/i18n.js";
import { CompanyAppShell } from "./CompanyAppShell.js";
import { CompanyBrandingProvider } from "./CompanyBrandingContext.js";

function branding(overrides: Partial<CompanyBranding> = {}): CompanyBranding {
  return {
    dataQuality: { nameArMissing: false, subtitleArMissing: false, subtitleEnMissing: false },
    hasLogo: false,
    logoFileId: null,
    nameAr: "شركة أكمي للخدمات اللوجستية",
    nameEn: "Acme Logistics",
    subtitleAr: "خدمات سريعة",
    subtitleEn: "Fast Delivery",
    telephone: "+971 4 000 0000",
    ...overrides,
  };
}

function makeApi(brand: CompanyBranding, textLanguage: "en" | "ar" = "en") {
  return {
    delete: vi.fn(),
    get: vi.fn((path: string) => {
      if (path === "company-profile/branding") return Promise.resolve(brand);
      if (path === "me/preferences") return Promise.resolve({ textLanguage });
      return Promise.reject(new Error(`unexpected get ${path}`));
    }),
    getBinary: vi.fn().mockResolvedValue(new Blob([new Uint8Array([1])])),
    patch: vi.fn().mockResolvedValue({ textLanguage: "ar" }),
    post: vi.fn(),
    postMultipart: vi.fn(),
    put: vi.fn(),
    setAccessToken: vi.fn(),
  };
}

function session(permissions: readonly string[]): LoginResponse {
  return {
    accessToken: "x",
    expiresAt: "2026-07-28T00:00:00.000Z",
    identity: {
      companyId: "c1",
      forcePasswordChange: false,
      id: "a1",
      kind: "company_user",
      permissions,
      username: "admin",
    },
    tokenType: "Bearer",
  };
}

function renderShell(api: ReturnType<typeof makeApi>, permissions: readonly string[]) {
  return render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <CompanyBrandingProvider api={api as unknown as ApiClient}>
        <CompanyAppShell onLogout={vi.fn().mockResolvedValue(undefined)} session={session(permissions)}>
          <div>content</div>
        </CompanyAppShell>
      </CompanyBrandingProvider>
    </MemoryRouter>,
  );
}

const ADMIN = ["users_roles.manage", "company_profile.manage"];

describe("CompanyAppShell branding", () => {
  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
    document.documentElement.dir = "ltr";
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:mock" });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
  });

  it("shows the Company name and subtitle and never the fixed product subtitle", async () => {
    renderShell(makeApi(branding()), ADMIN);
    expect((await screen.findAllByText("Acme Logistics")).length).toBeGreaterThan(0);
    expect(screen.getByText("Fast Delivery")).toBeInTheDocument();
    expect(screen.queryByText("Delivery Management System")).not.toBeInTheDocument();
    // "Powered by BluelineGPT" may remain as a small reference, not the identity.
    expect(screen.getByText("Powered by BluelineGPT")).toBeInTheDocument();
  });

  it("hides the subtitle row when no subtitle is configured", async () => {
    renderShell(makeApi(branding({ subtitleAr: null, subtitleEn: null })), ADMIN);
    await screen.findAllByText("Acme Logistics");
    expect(screen.queryByText("Fast Delivery")).not.toBeInTheDocument();
  });

  it("falls back to Company initials when no logo is present", async () => {
    renderShell(makeApi(branding({ hasLogo: false, logoFileId: null })), ADMIN);
    await screen.findAllByText("Acme Logistics");
    expect(screen.getByText("AL")).toBeInTheDocument();
  });

  it("shows Company Profile in the menu only with the permission", async () => {
    const { unmount } = renderShell(makeApi(branding()), ADMIN);
    await screen.findAllByText("Acme Logistics");
    fireEvent.click(screen.getByRole("button", { name: "Configuration" }));
    expect(screen.getByRole("link", { name: "Company profile" })).toBeInTheDocument();
    unmount();

    renderShell(makeApi(branding()), ["users_roles.manage"]);
    await screen.findAllByText("Acme Logistics");
    fireEvent.click(screen.getByRole("button", { name: "Configuration" }));
    expect(screen.getByRole("link", { name: "General settings" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Company profile" })).not.toBeInTheDocument();
  });

  it("keeps only Driver Collections under Drivers — no duplicate reconciliation entries", async () => {
    renderShell(makeApi(branding()), ADMIN);
    await screen.findAllByText("Acme Logistics");
    fireEvent.click(screen.getByRole("button", { name: "Drivers" }));
    expect(screen.getByRole("link", { name: "Driver Collections" })).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Driver cash reconciliation" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "New driver cash reconciliation" }),
    ).not.toBeInTheDocument();
  });

  it("keeps exactly one Trader Settlements entry under the Traders nav group", async () => {
    renderShell(makeApi(branding()), ADMIN);
    await screen.findAllByText("Acme Logistics");
    fireEvent.click(screen.getByRole("button", { name: "Traders" }));
    const links = screen.getAllByRole("link", { name: "Trader settlements" });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/trader-settlements");
  });

  it("keeps only the UI-language selector in the sidebar (no Text Language, no My Preferences)", async () => {
    renderShell(makeApi(branding()), ADMIN);
    await screen.findAllByText("Acme Logistics");

    // Only the UI-language control remains; the Search-and-Display control now
    // lives in General Settings (My Display Preferences), not the sidebar.
    expect(screen.getByRole("group", { name: "Language" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Text language" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "My Preferences" })).not.toBeInTheDocument();
    // UI language and direction remain English/LTR.
    expect(i18nInstance.language).toBe("en");
    expect(document.documentElement.dir).toBe("ltr");
  });
});
