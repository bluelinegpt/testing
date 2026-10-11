import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type CompanyDetail, platformApi } from "../api/platform-client.js";
import { CompanyDetailPage } from "./CompanyDetailPage.js";

/**
 * Company Data Reset, Prompt 2 -- Parts K / L / M. Company Detail offers ONE
 * Company Data Reset entry point (the plan-based Data Reset page). The legacy
 * whole-Company reset ("Preview Data Reset" / "Reset Company Data") and the
 * legacy "Users Only Reset" are gone, and the page never calls their API.
 */

const permissions = new Set<string>();
vi.mock("../app/PlatformSession.js", () => ({
  usePlatformSession: () => ({ can: (permission: string) => permissions.has(permission) }),
}));

const companyId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function company(environment: CompanyDetail["environment"]): CompanyDetail {
  return {
    accountingSetupAppliedAt: null,
    accountingSetupAppliedBy: null,
    accountingSetupStatus: "applied",
    accountingTemplateCode: null,
    accountingTemplateSha256: null,
    accountingTemplateVersion: null,
    addressEn: null,
    baseCurrency: "AED",
    closedAt: null,
    code: "DEV-ACME",
    contactName: null,
    countryCode: "AE",
    createdAt: "2026-01-01T00:00:00.000Z",
    defaultLanguage: null,
    email: null,
    environment,
    id: companyId,
    mobileCode: "123456",
    nameAr: null,
    nameEn: "Acme",
    shipmentPrefix: null,
    shipmentSerialEnabledAt: null,
    status: "active",
    statusChangeReason: null,
    subdomain: "acme",
    taxRegistrationNumber: null,
    telephone: null,
    timezone: null,
    tradeLicenseNumber: null,
    version: 1,
  };
}

async function renderPage(environment: CompanyDetail["environment"]) {
  vi.spyOn(platformApi, "company").mockResolvedValue(company(environment));
  vi.spyOn(platformApi, "accountingSetup").mockResolvedValue({
    appliedAt: null,
    appliedBy: null,
    businessDay: null,
    counts: {},
    status: "applied",
    templateCode: null,
    templateSha256: null,
    templateVersion: null,
  });
  vi.spyOn(platformApi, "readiness").mockResolvedValue({ blockedBy: [], canActivate: false, items: [], nextStep: "none", status: "active" });
  vi.spyOn(platformApi, "audit").mockResolvedValue([]);
  render(
    <MemoryRouter initialEntries={[`/companies/${companyId}`]}>
      <Routes>
        <Route element={<CompanyDetailPage />} path="/companies/:companyId" />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Company Detail -- one Company Data Reset entry point", () => {
  beforeEach(() => permissions.clear());
  afterEach(() => vi.restoreAllMocks());

  it("shows the Data Reset link to /companies/:id/data-reset and no legacy reset controls; the legacy reset client methods are gone and no retired route is requested", async () => {
    permissions.add("platform.companies.reset");
    permissions.add("platform.companies.manage");
    // Prompt 3: the legacy client methods no longer exist at all.
    for (const legacyMethod of ["companyResetPreview", "resetCompanyData", "eligibleCompanyUsersReset", "previewCompanyUsersReset", "resetCompanyUsers"]) {
      expect(legacyMethod in platformApi, legacyMethod).toBe(false);
    }
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await renderPage("development");
    const links = await screen.findAllByRole("link", { name: /Data Reset/u });
    for (const link of links) expect(link).toHaveAttribute("href", `/companies/${companyId}/data-reset`);
    expect(links.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(screen.getByRole("tab", { name: "Lifecycle" }));
    for (const text of [/Preview Data Reset/u, /Reset Company Data/u, /Users Only Reset/u, /Load Users for Selective Reset/u, /Reset Selected Users/u]) {
      expect(screen.queryByText(text)).toBeNull();
    }
    const maintenance = screen.getByRole("heading", { name: /Training data/u }).closest("section")!;
    expect(within(maintenance).getByRole("link", { name: "Open Data Reset" })).toHaveAttribute("href", `/companies/${companyId}/data-reset`);
    // No request to a retired reset route was made by the page.
    for (const call of fetchSpy.mock.calls) expect(String(call[0])).not.toMatch(/reset-execute|users-reset|reset-preview/u);
  });

  it("without the reset permission there is no Data Reset entry point", async () => {
    permissions.add("platform.companies.manage");
    await renderPage("development");
    fireEvent.click(await screen.findByRole("tab", { name: "Lifecycle" }));
    await screen.findByRole("heading", { name: /Training data/u });
    expect(screen.queryByRole("link", { name: /Data Reset/u })).toBeNull();
  });
});
