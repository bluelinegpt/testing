import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type CompanyDetail, type ReadinessSummary, platformApi } from "../api/platform-client.js";
import { CompanyDetailPage } from "./CompanyDetailPage.js";

/**
 * 2026-10-05 -- a draft Company created with setup template "None" could not
 * be activated, and the page only said why in a hover tooltip. It now shows the
 * blocking reason under Activate and offers "Apply setup template".
 */

const permissions = new Set<string>();
vi.mock("../app/PlatformSession.js", () => ({
  usePlatformSession: () => ({ can: (permission: string) => permissions.has(permission) }),
}));

const companyId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function company(setupStatus: string): CompanyDetail {
  return {
    accountingSetupAppliedAt: null,
    accountingSetupAppliedBy: null,
    accountingSetupStatus: setupStatus,
    accountingTemplateCode: null,
    accountingTemplateSha256: null,
    accountingTemplateVersion: null,
    addressEn: null,
    baseCurrency: "AED",
    closedAt: null,
    code: "CMP-000044",
    contactName: null,
    countryCode: "AE",
    createdAt: "2026-01-01T00:00:00.000Z",
    defaultLanguage: null,
    email: null,
    environment: "development",
    id: companyId,
    mobileCode: "123456",
    nameAr: null,
    nameEn: "Standard Roles Test",
    shipmentPrefix: null,
    shipmentSerialEnabledAt: null,
    status: "draft",
    statusChangeReason: null,
    subdomain: "srtest",
    taxRegistrationNumber: null,
    telephone: null,
    timezone: null,
    tradeLicenseNumber: null,
    version: 1,
  };
}

const blocked: ReadinessSummary = {
  blockedBy: ["accountingSetup"],
  canActivate: false,
  items: [
    {
      key: "accountingSetup",
      label: "Accounting setup",
      note: "No setup template applied - apply one under Configuration & Accounting",
      required: true,
      state: "incomplete",
    },
  ],
  nextStep: "Apply a setup template",
  status: "draft",
} as unknown as ReadinessSummary;

function mock(setupStatus: string, readiness: ReadinessSummary) {
  vi.spyOn(platformApi, "company").mockResolvedValue(company(setupStatus));
  vi.spyOn(platformApi, "accountingSetup").mockResolvedValue({
    appliedAt: null,
    appliedBy: null,
    businessDay: null,
    counts: {},
    status: setupStatus,
    templateCode: null,
    templateSha256: null,
    templateVersion: null,
  });
  vi.spyOn(platformApi, "readiness").mockResolvedValue(readiness);
  vi.spyOn(platformApi, "audit").mockResolvedValue([]);
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={[`/companies/${companyId}`]}>
      <Routes>
        <Route element={<CompanyDetailPage />} path="/companies/:companyId" />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Company Detail -- setup template after creation", () => {
  beforeEach(() => {
    permissions.clear();
    permissions.add("platform.companies.manage");
  });
  afterEach(() => vi.restoreAllMocks());

  it("Lifecycle says why Activate is disabled instead of hiding it in a tooltip", async () => {
    mock("not_configured", blocked);
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Lifecycle" }));
    expect(screen.getByRole("button", { name: "Activate" })).toBeDisabled();
    expect(screen.getByTestId("activate-blocked").textContent).toMatch(
      /Blocked by: Accounting setup\. Next step: Apply a setup template\./u,
    );
  });

  it("offers the approved templates and applies the chosen one, then reloads", async () => {
    mock("not_configured", blocked);
    vi.spyOn(platformApi, "approvedTemplates").mockResolvedValue([
      { displayName: "UAE Delivery Standard", templateCode: "UAE_DELIVERY_STANDARD", templateVersion: 3 },
    ]);
    const apply = vi.spyOn(platformApi, "applySetupTemplate").mockResolvedValue(undefined);
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Configuration & Accounting" }));
    const panel = await screen.findByTestId("apply-setup-template");
    await waitFor(() => expect(screen.getByLabelText("Setup template")).toHaveValue("UAE_DELIVERY_STANDARD@3"));
    expect(panel.textContent).toMatch(/GL Accounting stays OFF/u);
    fireEvent.click(screen.getByRole("button", { name: "Apply setup template" }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith(companyId, "UAE_DELIVERY_STANDARD", 3));
    await waitFor(() => expect(platformApi.readiness).toHaveBeenCalledTimes(2));
  });

  it("shows nothing to apply once the setup is ready, or without the manage permission", async () => {
    mock("ready", { ...blocked, blockedBy: [], canActivate: true, items: [], nextStep: "Activate Company" } as ReadinessSummary);
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "Configuration & Accounting" }));
    expect(screen.queryByTestId("apply-setup-template")).toBeNull();
    vi.restoreAllMocks();

    permissions.clear();
    mock("not_configured", blocked);
    renderPage();
    fireEvent.click((await screen.findAllByRole("tab", { name: "Configuration & Accounting" }))[0]!);
    expect(screen.queryByTestId("apply-setup-template")).toBeNull();
  });
});
