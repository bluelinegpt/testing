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
        <CompanyAppShell
          onLogout={vi.fn().mockResolvedValue(undefined)}
          session={session(permissions)}
        >
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
    // "Powered by Tawseelhub.com" may remain as a small reference, not the identity.
    expect(screen.getByText("Powered by Tawseelhub.com")).toBeInTheDocument();
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

/**
 * A Driver-only User's navigation.
 *
 * Uses the CORRECT Driver permission shape (Driver Order Status Permission
 * fix): the dedicated `driver_operations` Role's one permission,
 * `orders.driver_self_service` -- never the office `Orders` Role a Driver
 * User was previously (incorrectly) assigned, which carried
 * `orders.assign_driver`/`orders.create`/`orders.edit_before_processing`/
 * `financial_transactions.reverse`/`journals.create_manual` along with it.
 * None of `users_roles.manage`, `reconciliations.*`, `accounting.*`,
 * `settlements.*`, `reports.*` either. Before an earlier fix, `/drivers`
 * (Driver Collections) was reachable because its route gate incorrectly
 * included `orders.assign_driver`/`orders.update_delivery_status` --
 * Order-list permissions that have nothing to do with the Driver
 * Collections API (`operations/cash/*`, gated on
 * `reconciliations.*`/`manage`). Everything else the Driver must not see
 * was already correctly gated.
 */
const DRIVER_ONLY = ["orders.driver_self_service"];

describe("Driver-only navigation", () => {
  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
    document.documentElement.dir = "ltr";
  });

  it("sees Orders", async () => {
    renderShell(makeApi(branding()), DRIVER_ONLY);
    await screen.findAllByText("Acme Logistics");
    expect(screen.getByRole("button", { name: "Orders" })).toBeInTheDocument();
  });

  it("does not see Create order or Import orders under Orders", async () => {
    renderShell(makeApi(branding()), DRIVER_ONLY);
    await screen.findAllByText("Acme Logistics");
    fireEvent.click(screen.getByRole("button", { name: "Orders" }));
    expect(screen.queryByRole("link", { name: "Create order" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Import orders" })).not.toBeInTheDocument();
  });

  it("does not see the Drivers group (Driver Collections)", async () => {
    renderShell(makeApi(branding()), DRIVER_ONLY);
    await screen.findAllByText("Acme Logistics");
    expect(screen.queryByRole("button", { name: "Drivers" })).not.toBeInTheDocument();
  });

  it("does not see Accounting", async () => {
    renderShell(makeApi(branding()), DRIVER_ONLY);
    await screen.findAllByText("Acme Logistics");
    expect(screen.queryByRole("button", { name: "Accounting" })).not.toBeInTheDocument();
  });

  it("does not see Traders", async () => {
    renderShell(makeApi(branding()), DRIVER_ONLY);
    await screen.findAllByText("Acme Logistics");
    expect(screen.queryByRole("button", { name: "Traders" })).not.toBeInTheDocument();
  });

  it("does not see Administration", async () => {
    renderShell(makeApi(branding()), DRIVER_ONLY);
    await screen.findAllByText("Acme Logistics");
    expect(screen.queryByRole("button", { name: "Administration" })).not.toBeInTheDocument();
  });

  it("does not see Dashboard or Reports (both require office-level permissions)", async () => {
    renderShell(makeApi(branding()), DRIVER_ONLY);
    await screen.findAllByText("Acme Logistics");
    expect(screen.queryByRole("link", { name: "Dashboard" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Reports" })).not.toBeInTheDocument();
  });

  /* `/configuration/general` ("General Settings") used to be reachable by
     EVERY authenticated company_user unconditionally, specifically so any
     Role could set its own personal display-language preference without
     needing `users_roles.manage`. That universal carve-out was the second
     leak: an Orders-only identity (this Driver) inherited it too. It now
     only applies to an identity that already has some non-Orders permission
     (any other office Role keeps exactly the access it had); an Orders-only
     identity falls through to `/configuration/general`'s own normal
     `[manage]` gate, same as every other Configuration route. */
  it("does not see Configuration at all", async () => {
    renderShell(makeApi(branding()), DRIVER_ONLY);
    await screen.findAllByText("Acme Logistics");
    expect(screen.queryByRole("button", { name: "Configuration" })).not.toBeInTheDocument();
  });

  it("still exposes General Settings to an office Role that holds no other Configuration permission", async () => {
    // Proves the fix is scoped to Orders-only identities, not "everyone
    // without users_roles.manage" -- an AccountingAdmin-only Role (no
    // `manage`) keeps exactly the personal-preference access it always had.
    renderShell(makeApi(branding()), ["accounting.manage"]);
    await screen.findAllByText("Acme Logistics");
    fireEvent.click(screen.getByRole("button", { name: "Configuration" }));
    expect(screen.getByRole("link", { name: "General settings" })).toBeInTheDocument();
  });
});
