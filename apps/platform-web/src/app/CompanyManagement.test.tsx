import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { App } from "../App.js";
import { PlatformSessionProvider } from "./PlatformSession.js";

interface StubResponse {
  readonly body?: unknown;
  readonly status: number;
}
type Route = StubResponse | ((body: unknown) => StubResponse);

const readOnly = ["platform.access", "platform.companies.read"];
const fullAccess = [...readOnly, "platform.companies.manage", "platform.audit.read"];

function identity(permissions: readonly string[] = fullAccess): object {
  return {
    accountId: "6f1d0d5e-1c1b-4a2f-9f4e-2f9b7a5c1d33",
    username: "platform.admin",
    displayName: "platform.admin",
    kind: "platform_administrator",
    companyId: null,
    permissions,
    roles: ["platform_super_admin"],
  };
}

const companyId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function companyRow(overrides: Record<string, unknown> = {}): object {
  return {
    id: companyId,
    code: "TST-0001",
    nameEn: "Test Delivery",
    subdomain: "tst0001",
    status: "draft",
    environment: "sandbox",
    countryCode: "AE",
    timezone: "Asia/Dubai",
    baseCurrency: "AED",
    defaultLanguage: "en",
    accountingSetupStatus: "ready",
    companyAdminCount: 0,
    readinessState: "incomplete",
    createdAt: "2026-08-09T00:00:00.000Z",
    ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}): object {
  return {
    ...companyRow(),
    nameAr: null,
    contactName: null,
    telephone: null,
    email: null,
    addressEn: null,
    tradeLicenseNumber: null,
    taxRegistrationNumber: null,
    accountingTemplateCode: "UAE_DELIVERY_STANDARD",
    accountingTemplateVersion: 1,
    accountingTemplateSha256: "2d66f8ee57cc17ce732a2ee3158f8e40131b8e815dfa9355ff13551070e06581",
    accountingSetupAppliedAt: "2026-08-09T00:00:00.000Z",
    accountingSetupAppliedBy: "platform.admin",
    statusChangeReason: null,
    version: 1,
    shipmentPrefix: "TST",
    shipmentSerialEnabledAt: null,
    ...overrides,
  };
}

const accountingSetup = {
  status: "ready",
  templateCode: "UAE_DELIVERY_STANDARD",
  templateVersion: 1,
  templateSha256: "2d66f8ee57cc17ce732a2ee3158f8e40131b8e815dfa9355ff13551070e06581",
  appliedAt: "2026-08-09T00:00:00.000Z",
  appliedBy: "platform.admin",
  businessDay: { timezone: "Asia/Dubai", startTime: "08:00" },
  counts: {
    accounts: 27,
    mappings: 31,
    expenseTypes: 5,
    categories: 1,
    allowanceTypes: 2,
    referencePrefixes: 17,
    cashAccounts: 1,
    bankAccounts: 1,
    openingBalanceBatches: 0,
    journals: 0,
    accountingEvents: 0,
  },
};

function readiness(canActivate: boolean): object {
  return {
    status: "draft",
    canActivate,
    blockedBy: canActivate ? [] : ["companyAdmin"],
    nextStep: canActivate ? "Activate Company" : "Create Company Administrator",
    items: [
      {
        key: "accountingSetup",
        label: "Accounting setup",
        required: true,
        state: "complete",
        note: null,
      },
      {
        key: "companyAdmin",
        label: "Company Administrator",
        required: true,
        state: canActivate ? "complete" : "incomplete",
        note: canActivate ? null : "Pending",
      },
      {
        key: "openingBalance",
        label: "Opening balance",
        required: false,
        state: "optional",
        note: "Not entered",
      },
    ],
  };
}

function stubFetch(routes: Record<string, Route>): typeof fetch {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace(/^.*\/api\/v1\//, "").split("?")[0] ?? "";
    const key = `${init?.method ?? "GET"} ${path}`;
    const entry = routes[key];
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const resolved = typeof entry === "function" ? entry(body) : entry;
    if (resolved === undefined) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: "not_stubbed", message: key } }), {
          headers: { "content-type": "application/json" },
          status: 404,
        }),
      );
    }
    return Promise.resolve(
      resolved.status === 204
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(resolved.body ?? {}), {
            headers: { "content-type": "application/json" },
            status: resolved.status,
          }),
    );
  }) as unknown as typeof fetch;
}

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <PlatformSessionProvider>
        <App />
      </PlatformSessionProvider>
    </MemoryRouter>,
  );
}

const baseRoutes = (permissions: readonly string[] = fullAccess): Record<string, Route> => ({
  "GET platform/auth/me": { body: identity(permissions), status: 200 },
  "GET platform/companies": {
    body: { items: [companyRow()], total: 1, page: 1, pageSize: 25 },
    status: 200,
  },
  "GET platform/companies/accounting-templates": {
    body: {
      items: [
        {
          templateCode: "UAE_DELIVERY_STANDARD",
          templateVersion: 1,
          displayName: "UAE Delivery Standard",
        },
        {
          templateCode: "UAE_DELIVERY_STANDARD",
          templateVersion: 2,
          displayName: "UAE Delivery Standard",
        },
      ],
    },
    status: 200,
  },
  [`GET platform/companies/${companyId}`]: { body: detail(), status: 200 },
  [`GET platform/companies/${companyId}/accounting-setup`]: { body: accountingSetup, status: 200 },
  [`GET platform/companies/${companyId}/readiness`]: { body: readiness(false), status: 200 },
  [`GET platform/companies/${companyId}/audit`]: {
    body: {
      items: [
        {
          action: "platform.company.created",
          reason: null,
          before: null,
          after: null,
          occurredAt: "2026-08-09T00:00:00.000Z",
          correlationId: "abc",
          source: "platform_portal",
          actor: "platform.admin",
        },
      ],
    },
    status: 200,
  },
});

describe("Company list", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders Companies with their status and environment", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt("/companies");

    expect(await screen.findByRole("link", { name: "TST-0001" })).toBeInTheDocument();
    // Scoped to the table: the status and environment filters render the same
    // words as <option> values.
    const row = screen.getByRole("link", { name: "TST-0001" }).closest("tr") as HTMLElement;
    expect(within(row).getByText("Test Delivery")).toBeInTheDocument();
    expect(within(row).getByText("draft")).toBeInTheDocument();
    expect(within(row).getByText("sandbox")).toBeInTheDocument();
    expect(within(row).getByText("Pending")).toBeInTheDocument();
    expect(within(row).getByText("Asia/Dubai")).toBeInTheDocument();
  });

  it("sends search and filter values to the server", async () => {
    const fetchStub = stubFetch(baseRoutes());
    vi.stubGlobal("fetch", fetchStub);
    renderAt("/companies");
    await screen.findByRole("link", { name: "TST-0001" });

    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "active" } });

    await waitFor(() => {
      const calls = (fetchStub as unknown as { mock: { calls: [string][] } }).mock.calls.map(
        ([url]) => url,
      );
      expect(calls.some((url) => url.includes("search=acme"))).toBe(true);
      expect(calls.some((url) => url.includes("status=active"))).toBe(true);
    });
  });

  it("offers Create Company only with the manage permission", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt("/companies");
    expect(await screen.findByRole("link", { name: "Create Company" })).toBeInTheDocument();
  });

  it("hides Create Company from a read-only Platform account", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes(readOnly)));
    renderAt("/companies");
    await screen.findByRole("link", { name: "TST-0001" });
    expect(screen.queryByRole("link", { name: "Create Company" })).toBeNull();
  });
});

describe("Create Company", () => {
  afterEach(() => vi.restoreAllMocks());

  const fill = (): void => {
    fireEvent.change(screen.getByLabelText("Company Name"), { target: { value: "Acme Delivery" } });
    fireEvent.change(screen.getByLabelText("Shipment Prefix"), { target: { value: "ACM" } });
  };

  it("omits technical identifiers and suggests an editable subdomain", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt("/companies/new");
    await screen.findByRole("button", { name: "Review" });

    expect(screen.queryByLabelText("Code")).toBeNull();
    expect(screen.queryByLabelText("Company ID")).toBeNull();
    fireEvent.change(screen.getByLabelText("Company Name"), {
      target: { value: "Fast Delivery UAE" },
    });
    expect(screen.getByLabelText("Subdomain")).toHaveValue("fast-delivery-uae");
    fireEvent.change(screen.getByLabelText("Subdomain"), { target: { value: "fast-ops" } });
    expect(screen.getByLabelText("Subdomain")).toHaveValue("fast-ops");
    expect(screen.getByText("United Arab Emirates")).toBeInTheDocument();
    expect(screen.getByText("Dubai (Asia/Dubai)")).toBeInTheDocument();
  });

  it("requires the mandatory fields before review", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt("/companies/new");
    await screen.findByRole("button", { name: "Review" });

    // Native validity blocks the submit; the review step never appears.
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.queryByRole("button", { name: "Create Company" })).toBeNull();
    expect((screen.getByLabelText("Company Name") as HTMLInputElement).checkValidity()).toBe(false);
  });

  it("shows a review step before creating anything", async () => {
    const fetchStub = stubFetch(baseRoutes());
    vi.stubGlobal("fetch", fetchStub);
    renderAt("/companies/new");
    await screen.findByRole("button", { name: "Review" });

    fill();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));

    expect(await screen.findByRole("heading", { name: "Review" })).toBeInTheDocument();
    expect(screen.getByText("Generated automatically")).toBeInTheDocument();
    expect(screen.getByText("acme-delivery")).toBeInTheDocument();
    // v2 is the default the form pre-selects, not v1: v1 left every new
    // Company without a working set of delivery Areas.
    expect(screen.getByText("UAE_DELIVERY_STANDARD@2")).toBeInTheDocument();
    // Nothing has been created yet.
    const calls = (fetchStub as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect(calls.some(([, init]) => init.method === "POST")).toBe(false);
  });

  it("creates the Company and opens its detail page", async () => {
    const routes = baseRoutes();
    routes["POST platform/companies"] = { body: { companyId }, status: 201 };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt("/companies/new");
    await screen.findByRole("button", { name: "Review" });

    fill();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create Company" }));

    expect(await screen.findByRole("heading", { name: "Test Delivery" })).toBeInTheDocument();
  });

  it("sends only business fields, never identifiers or status", async () => {
    const routes = baseRoutes();
    let sent: Record<string, unknown> = {};
    routes["POST platform/companies"] = (body) => {
      sent = body as Record<string, unknown>;
      return { body: { companyId }, status: 201 };
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt("/companies/new");
    await screen.findByRole("button", { name: "Review" });

    fill();
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create Company" }));
    await screen.findByRole("heading", { name: "Test Delivery" });

    expect(Object.keys(sent).sort()).toEqual([
      "accountingTemplateCode",
      "accountingTemplateVersion",
      "defaultLanguage",
      "environment",
      "name",
      "shipmentPrefix",
      "subdomain",
    ]);
    for (const forbidden of ["companyId", "code", "status", "createdBy", "id", "openingBalances"]) {
      expect(sent).not.toHaveProperty(forbidden);
    }
  });

  it("surfaces a reserved-subdomain refusal from the server", async () => {
    const routes = baseRoutes();
    routes["POST platform/companies"] = {
      body: {
        error: {
          code: "subdomain_reserved",
          message: "'platform' is a reserved subdomain and cannot be used by a Company",
        },
      },
      status: 400,
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt("/companies/new");
    await screen.findByRole("button", { name: "Review" });

    fireEvent.change(screen.getByLabelText("Company Name"), { target: { value: "Bad" } });
    fireEvent.change(screen.getByLabelText("Subdomain"), { target: { value: "platform" } });
    fireEvent.change(screen.getByLabelText("Shipment Prefix"), { target: { value: "BAD" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create Company" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("reserved subdomain");
  });
});

describe("Company detail", () => {
  afterEach(() => vi.restoreAllMocks());

  async function selectCompanyTab(name: string): Promise<void> {
    fireEvent.click(await screen.findByRole("tab", { name }));
  }

  it("shows the Accounting setup summary from the server", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt(`/companies/${companyId}`);

    expect(await screen.findByRole("heading", { name: "Test Delivery" })).toBeInTheDocument();
    await selectCompanyTab("Configuration & Accounting");
    const setupHeading = screen.getByRole("heading", { name: "Accounting Setup" });
    expect(setupHeading).toBeInTheDocument();
    expect(screen.getByText("UAE_DELIVERY_STANDARD v1")).toBeInTheDocument();
    expect(screen.getByText("27")).toBeInTheDocument();
    expect(screen.getByText("31")).toBeInTheDocument();
    // Rendered in both Configuration and Accounting Setup.
    expect(screen.getAllByText("08:00 Asia/Dubai").length).toBeGreaterThan(0);
    // The zero-history line is the point of the panel.
    expect(
      screen.getByText(/Opening balances 0 · Journals 0 · Accounting events 0/),
    ).toBeInTheDocument();
  });

  it("shows the generated Company code and read-only Company ID", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt(`/companies/${companyId}`);
    expect(await screen.findByText(companyId)).toBeInTheDocument();
    expect(screen.getAllByText("TST-0001").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Company ID")).toBeNull();
  });

  it("organizes Company management into focused tabs", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt(`/companies/${companyId}`);

    expect(await screen.findByRole("tab", { name: "Company Information" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByRole("heading", { name: "Accounting Setup" })).toBeNull();
    await selectCompanyTab("Configuration & Accounting");
    expect(screen.getByRole("heading", { name: "Accounting Setup" })).toBeInTheDocument();
  });

  it("explains that a closed Company cannot use suspended-Company reactivation", async () => {
    const routes = baseRoutes();
    routes[`GET platform/companies/${companyId}`] = {
      body: detail({ status: "closed", closedAt: "2026-08-09T00:00:00.000Z" }),
      status: 200,
    };
    routes[`GET platform/companies/${companyId}/deletion-eligibility`] = {
      body: {
        eligible: true,
        status: "closed",
        environment: "sandbox",
        closedAt: "2026-08-09T00:00:00.000Z",
        eligibleAt: "2026-08-09T00:00:00.000Z",
        requiresWaitingPeriod: false,
        waitingPeriodHours: 0,
        remainingSeconds: 0,
        blockers: [],
        previewRequired: true,
        backupRequired: true,
      },
      status: 200,
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt(`/companies/${companyId}`);

    await selectCompanyTab("Lifecycle");
    expect(screen.getByText(/Closed is currently a terminal state/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reactivate" })).toBeNull();
  });

  it("shows readiness with Company Administrator pending and opening balance optional", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt(`/companies/${companyId}`);
    await selectCompanyTab("Configuration & Accounting");
    await screen.findByRole("heading", { name: "Onboarding readiness" });

    const adminRow = screen.getByText("Company Administrator").closest("tr");
    expect(within(adminRow as HTMLElement).getByText("Required")).toBeInTheDocument();
    expect(within(adminRow as HTMLElement).getByText("incomplete")).toBeInTheDocument();

    const balanceRow = screen.getByText("Opening balance").closest("tr");
    expect(within(balanceRow as HTMLElement).getByText("Optional")).toBeInTheDocument();
    expect(within(balanceRow as HTMLElement).getByText("Not entered")).toBeInTheDocument();

    expect(screen.getByText("Next step: Create Company Administrator")).toBeInTheDocument();
  });

  it("disables Activate while the server says the Company is not ready", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt(`/companies/${companyId}`);
    await selectCompanyTab("Lifecycle");
    const activate = await screen.findByRole("button", { name: "Activate" });
    expect(activate).toBeDisabled();
    expect(activate).toHaveAttribute("title", "Blocked by: companyAdmin");
  });

  it("enables Activate when the server says it may be activated", async () => {
    const routes = baseRoutes();
    routes[`GET platform/companies/${companyId}/readiness`] = {
      body: readiness(true),
      status: 200,
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt(`/companies/${companyId}`);
    await selectCompanyTab("Lifecycle");
    expect(await screen.findByRole("button", { name: "Activate" })).toBeEnabled();
  });

  it("offers lifecycle actions that match the Company's status", async () => {
    const routes = baseRoutes();
    routes[`GET platform/companies/${companyId}`] = {
      body: detail({ status: "active" }),
      status: 200,
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt(`/companies/${companyId}`);

    await selectCompanyTab("Lifecycle");
    await screen.findByRole("button", { name: "Suspend" });
    expect(screen.queryByRole("button", { name: "Activate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reactivate" })).toBeNull();
  });

  it("requires a reason before suspending", async () => {
    const routes = baseRoutes();
    routes[`GET platform/companies/${companyId}`] = {
      body: detail({ status: "active" }),
      status: 200,
    };
    let suspended = false;
    routes[`POST platform/companies/${companyId}/suspend`] = () => {
      suspended = true;
      return { status: 204 };
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    vi.stubGlobal(
      "prompt",
      vi.fn(() => null),
    );
    renderAt(`/companies/${companyId}`);

    await selectCompanyTab("Lifecycle");
    fireEvent.click(await screen.findByRole("button", { name: "Suspend" }));
    await waitFor(() => expect(globalThis.prompt).toHaveBeenCalled());
    expect(suspended).toBe(false);
  });

  it("suspends with the reason the administrator supplied", async () => {
    const routes = baseRoutes();
    routes[`GET platform/companies/${companyId}`] = {
      body: detail({ status: "active" }),
      status: 200,
    };
    let sentReason: unknown;
    routes[`POST platform/companies/${companyId}/suspend`] = (body) => {
      sentReason = (body as { reason?: string }).reason;
      return { status: 204 };
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    vi.stubGlobal(
      "prompt",
      vi.fn(() => "non-payment"),
    );
    renderAt(`/companies/${companyId}`);

    await selectCompanyTab("Lifecycle");
    fireEvent.click(await screen.findByRole("button", { name: "Suspend" }));
    await waitFor(() => expect(sentReason).toBe("non-payment"));
  });

  it("reactivates a suspended Company", async () => {
    const routes = baseRoutes();
    routes[`GET platform/companies/${companyId}`] = {
      body: detail({ status: "suspended" }),
      status: 200,
    };
    let reactivated = false;
    routes[`POST platform/companies/${companyId}/reactivate`] = () => {
      reactivated = true;
      return { status: 204 };
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt(`/companies/${companyId}`);

    await selectCompanyTab("Lifecycle");
    fireEvent.click(await screen.findByRole("button", { name: "Reactivate" }));
    await waitFor(() => expect(reactivated).toBe(true));
  });

  it("opens a dialog showing Company Name, Code, Environment and Status, with the button disabled", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt(`/companies/${companyId}`);

    await selectCompanyTab("Lifecycle");
    fireEvent.click(await screen.findByRole("button", { name: "Close Company" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Test Delivery")).toBeInTheDocument();
    expect(within(dialog).getByText("TST-0001")).toBeInTheDocument();
    expect(within(dialog).getByText("sandbox")).toBeInTheDocument();
    expect(within(dialog).getByText("draft")).toBeInTheDocument();
    expect(
      within(dialog).getByText("No Company data will be deleted by closing the Company."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Close Company" })).toBeDisabled();
  });

  it("keeps the confirm button disabled until the confirmation text matches exactly", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt(`/companies/${companyId}`);

    await selectCompanyTab("Lifecycle");
    fireEvent.click(await screen.findByRole("button", { name: "Close Company" }));
    const dialog = await screen.findByRole("dialog");
    const confirmButton = within(dialog).getByRole("button", { name: "Close Company" });
    fireEvent.change(within(dialog).getByLabelText(/Reason for closing/), {
      target: { value: "final closure" },
    });
    fireEvent.change(within(dialog).getByLabelText(/Type CLOSE TST-0001/), {
      target: { value: "close tst-0001" },
    });
    expect(confirmButton).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Type CLOSE TST-0001/), {
      target: { value: "CLOSE TST-0001" },
    });
    expect(confirmButton).not.toBeDisabled();
  });

  it("sends the reason and exact confirmation, and refreshes to Closed with no silent failure path", async () => {
    const routes = baseRoutes();
    let sent: Record<string, unknown> = {};
    let closed = false;
    routes[`POST platform/companies/${companyId}/close`] = (body) => {
      sent = body as Record<string, unknown>;
      closed = true;
      return { status: 204 };
    };
    routes[`GET platform/companies/${companyId}`] = () =>
      closed
        ? { body: detail({ status: "closed", closedAt: "2026-08-12T00:00:00.000Z" }), status: 200 }
        : { body: detail({ status: "draft" }), status: 200 };
    routes[`GET platform/companies/${companyId}/deletion-eligibility`] = {
      body: {
        eligible: true,
        status: "closed",
        environment: "sandbox",
        closedAt: "2026-08-12T00:00:00.000Z",
        eligibleAt: "2026-08-12T00:00:00.000Z",
        requiresWaitingPeriod: false,
        waitingPeriodHours: 0,
        remainingSeconds: 0,
        blockers: [],
        previewRequired: true,
        backupRequired: true,
      },
      status: 200,
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt(`/companies/${companyId}`);

    await selectCompanyTab("Lifecycle");
    fireEvent.click(await screen.findByRole("button", { name: "Close Company" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason for closing/), {
      target: { value: "final closure" },
    });
    fireEvent.change(within(dialog).getByLabelText(/Type CLOSE TST-0001/), {
      target: { value: "CLOSE TST-0001" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close Company" }));

    await waitFor(() =>
      expect(sent).toEqual({ reason: "final closure", confirmation: "CLOSE TST-0001" }),
    );
    expect(await screen.findByText("closed", { selector: ".platform-badge" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the server's rejection visibly when the confirmation is wrong, and leaves the Company unchanged", async () => {
    const routes = baseRoutes();
    routes[`POST platform/companies/${companyId}/close`] = () => ({
      body: {
        error: {
          code: "company_close_confirmation_mismatch",
          message: "Type CLOSE TST-0001 exactly",
        },
      },
      status: 409,
    });
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt(`/companies/${companyId}`);

    await selectCompanyTab("Lifecycle");
    fireEvent.click(await screen.findByRole("button", { name: "Close Company" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason for closing/), {
      target: { value: "final closure" },
    });
    fireEvent.change(within(dialog).getByLabelText(/Type CLOSE TST-0001/), {
      target: { value: "CLOSE TST-0001" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close Company" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Type CLOSE TST-0001 exactly",
    );
    expect(dialog).toBeVisible();
    expect(within(dialog).getByText("draft")).toBeInTheDocument();
  });

  it("Cancel closes the dialog without sending any request or changing state", async () => {
    const routes = baseRoutes();
    let called = false;
    routes[`POST platform/companies/${companyId}/close`] = () => {
      called = true;
      return { status: 204 };
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt(`/companies/${companyId}`);

    await selectCompanyTab("Lifecycle");
    fireEvent.click(await screen.findByRole("button", { name: "Close Company" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason for closing/), {
      target: { value: "final closure" },
    });
    fireEvent.change(within(dialog).getByLabelText(/Type CLOSE TST-0001/), {
      target: { value: "CLOSE TST-0001" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(called).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows server eligibility and a non-destructive preview for a closed Company", async () => {
    const permissions = [...fullAccess, "platform.companies.delete"];
    const routes = baseRoutes(permissions);
    routes[`GET platform/companies/${companyId}`] = {
      body: detail({ status: "closed", closedAt: "2026-08-09T00:00:00.000Z" }),
      status: 200,
    };
    routes[`GET platform/companies/${companyId}/deletion-eligibility`] = {
      body: {
        eligible: true,
        status: "closed",
        environment: "sandbox",
        closedAt: "2026-08-09T00:00:00.000Z",
        eligibleAt: "2026-08-09T00:00:00.000Z",
        requiresWaitingPeriod: false,
        waitingPeriodHours: 0,
        remainingSeconds: 0,
        blockers: [],
        previewRequired: true,
        backupRequired: true,
      },
      status: 200,
    };
    routes[`POST platform/companies/${companyId}/deletion-preview`] = {
      body: {
        readyForDelete: false,
        blockers: ["A verified deletion backup has not been attached"],
      },
      status: 200,
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt(`/companies/${companyId}`);

    await selectCompanyTab("Lifecycle");
    expect(await screen.findByText(/Eligible for deletion immediately/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run Deletion Preview" }));
    expect(await screen.findByText("READY FOR DELETE: NO")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /permanently delete company/i })).toBeNull();
  });

  function closedEligibleRoutes(): Record<string, Route> {
    const permissions = [...fullAccess, "platform.companies.delete"];
    const routes = baseRoutes(permissions);
    routes[`GET platform/companies/${companyId}`] = {
      body: detail({ status: "closed", closedAt: "2026-08-09T00:00:00.000Z" }),
      status: 200,
    };
    routes[`GET platform/companies/${companyId}/deletion-eligibility`] = {
      body: {
        eligible: true,
        status: "closed",
        environment: "sandbox",
        closedAt: "2026-08-09T00:00:00.000Z",
        eligibleAt: "2026-08-09T00:00:00.000Z",
        requiresWaitingPeriod: false,
        waitingPeriodHours: 0,
        remainingSeconds: 0,
        blockers: [],
        previewRequired: true,
        backupRequired: true,
      },
      status: 200,
    };
    return routes;
  }

  it("shows the exact unknown-dependency blocker, not just a generic label", async () => {
    const routes = closedEligibleRoutes();
    routes[`POST platform/companies/${companyId}/deletion-preview`] = {
      body: {
        readyForDelete: false,
        blockers: ["UNSAFE / UNKNOWN DEPENDENCY"],
        unknownReferences: ["Unclassified Company table: store_orders"],
      },
      status: 200,
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt(`/companies/${companyId}`);

    await selectCompanyTab("Lifecycle");
    fireEvent.click(await screen.findByRole("button", { name: "Run Deletion Preview" }));
    expect(await screen.findByText("UNSAFE / UNKNOWN DEPENDENCY")).toBeInTheDocument();
    expect(screen.getByText("Unclassified Company table: store_orders")).toBeInTheDocument();
  });

  it("shows a stale-operation preview failure inline, with a Retry button, not the page banner", async () => {
    const routes = closedEligibleRoutes();
    let attempts = 0;
    routes[`POST platform/companies/${companyId}/deletion-preview`] = () => {
      attempts += 1;
      return attempts === 1
        ? {
            body: {
              error: {
                code: "company_deletion_preview_in_progress",
                message:
                  "Another deletion preview for this Company started at the same moment. Retry the preview.",
              },
            },
            status: 409,
          }
        : { body: { readyForDelete: false, blockers: [], unknownReferences: [] }, status: 200 };
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt(`/companies/${companyId}`);

    await selectCompanyTab("Lifecycle");
    fireEvent.click(await screen.findByRole("button", { name: "Run Deletion Preview" }));
    expect(
      await screen.findByText("Existing deletion operation must be refreshed"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Another deletion preview for this Company started at the same moment. Retry the preview.",
      ),
    ).toBeInTheDocument();
    // Not the page-level banner.
    expect(
      screen.queryByText(
        "Another deletion preview for this Company started at the same moment. Retry the preview.",
        { selector: ".platform-login__error" },
      ),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry Deletion Preview" }));
    await waitFor(() => expect(attempts).toBe(2));
    expect(await screen.findByText("READY FOR DELETE: NO")).toBeInTheDocument();
    expect(screen.queryByText("Existing deletion operation must be refreshed")).toBeNull();
  });

  it("shows a permission-denied preview failure explicitly", async () => {
    const routes = closedEligibleRoutes();
    routes[`POST platform/companies/${companyId}/deletion-preview`] = {
      body: {
        error: {
          code: "permission_denied",
          message: "The authenticated account does not have permission for this operation",
        },
      },
      status: 403,
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt(`/companies/${companyId}`);

    await selectCompanyTab("Lifecycle");
    fireEvent.click(await screen.findByRole("button", { name: "Run Deletion Preview" }));
    expect(await screen.findByText("Permission denied")).toBeInTheDocument();
  });

  it("shows a database integrity conflict safely, without a raw stack trace, and enables Backup once preview is clean", async () => {
    const routes = closedEligibleRoutes();
    let attempts = 0;
    routes[`POST platform/companies/${companyId}/deletion-preview`] = () => {
      attempts += 1;
      return attempts === 1
        ? {
            body: {
              error: {
                code: "database_integrity_conflict",
                message: "The operation conflicts with current data integrity rules.",
              },
            },
            status: 409,
          }
        : { body: { readyForDelete: false, blockers: [], unknownReferences: [] }, status: 200 };
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt(`/companies/${companyId}`);

    await selectCompanyTab("Lifecycle");
    fireEvent.click(await screen.findByRole("button", { name: "Run Deletion Preview" }));
    expect(await screen.findByText("Database integrity conflict")).toBeInTheDocument();
    expect(screen.queryByText(/at Object\.|node_modules|\.ts:\d+/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry Deletion Preview" }));
    await screen.findByText("READY FOR DELETE: NO");
    expect(screen.getByRole("button", { name: "Create Verified Backup" })).not.toBeDisabled();
  });

  it("hides every lifecycle control from a read-only Platform account", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes(readOnly)));
    renderAt(`/companies/${companyId}`);

    await screen.findByRole("heading", { name: "Test Delivery" });
    for (const action of ["Activate", "Suspend", "Reactivate", "Close Company"]) {
      expect(screen.queryByRole("button", { name: action })).toBeNull();
    }
    expect(screen.getByText(/read-only Platform access/)).toBeInTheDocument();
  });

  it("never offers a delete control", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt(`/companies/${companyId}`);
    await screen.findByRole("heading", { name: "Test Delivery" });
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
  });
});

describe("Company pages and Platform access", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the sign-in page to a caller the Platform refuses", async () => {
    // A Company user holds a valid cookie, so `me` is reached and refused with
    // 403 by the Platform identity-kind check.
    vi.stubGlobal(
      "fetch",
      stubFetch({
        "GET platform/auth/me": {
          body: { error: { code: "identity_kind_denied", message: "denied" } },
          status: 403,
        },
      }),
    );
    renderAt(`/companies/${companyId}`);

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Test Delivery" })).toBeNull();
  });
});

describe("Company list sorting and onboarding state", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks the server to sort, rather than reordering the current page", async () => {
    const fetchStub = stubFetch(baseRoutes());
    vi.stubGlobal("fetch", fetchStub);
    renderAt("/companies");
    await screen.findByRole("link", { name: "TST-0001" });

    fireEvent.click(screen.getByRole("button", { name: /^Name/ }));

    await waitFor(() => {
      const calls = (fetchStub as unknown as { mock: { calls: [string][] } }).mock.calls.map(
        ([url]) => url,
      );
      expect(calls.some((url) => url.includes("sort=name") && url.includes("direction=asc"))).toBe(
        true,
      );
    });
  });

  it("flips direction when the same column is chosen twice", async () => {
    const fetchStub = stubFetch(baseRoutes());
    vi.stubGlobal("fetch", fetchStub);
    renderAt("/companies");
    await screen.findByRole("link", { name: "TST-0001" });

    fireEvent.click(screen.getByRole("button", { name: /^Name/ }));
    await waitFor(() => {
      const calls = (fetchStub as unknown as { mock: { calls: [string][] } }).mock.calls;
      expect(calls.some(([url]) => url.includes("sort=name"))).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: /^Name/ }));

    await waitFor(() => {
      const calls = (fetchStub as unknown as { mock: { calls: [string][] } }).mock.calls.map(
        ([url]) => url,
      );
      expect(calls.some((url) => url.includes("sort=name") && url.includes("direction=desc"))).toBe(
        true,
      );
    });
  });

  it("shows the server-derived onboarding state", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt("/companies");
    const row = (await screen.findByRole("link", { name: "TST-0001" })).closest(
      "tr",
    ) as HTMLElement;
    expect(within(row).getByText("incomplete")).toBeInTheDocument();
  });

  it("shows ready to activate when the server says so", async () => {
    const routes = baseRoutes();
    routes["GET platform/companies"] = {
      body: {
        items: [companyRow({ readinessState: "ready_to_activate", companyAdminCount: 1 })],
        total: 1,
        page: 1,
        pageSize: 25,
      },
      status: 200,
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt("/companies");
    const row = (await screen.findByRole("link", { name: "TST-0001" })).closest(
      "tr",
    ) as HTMLElement;
    expect(within(row).getByText("ready to activate")).toBeInTheDocument();
    expect(within(row).getByText("Configured")).toBeInTheDocument();
  });
});

describe("Company profile editing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("offers Edit profile only with the manage permission", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes(readOnly)));
    renderAt(`/companies/${companyId}`);
    await screen.findByRole("heading", { name: "Test Delivery" });
    expect(screen.queryByRole("button", { name: "Edit profile" })).toBeNull();
  });

  it("saves an edited profile and reloads", async () => {
    const routes = baseRoutes();
    let sent: Record<string, unknown> = {};
    routes[`PATCH platform/companies/${companyId}`] = (body) => {
      sent = body as Record<string, unknown>;
      return { status: 204 };
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt(`/companies/${companyId}`);

    fireEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    fireEvent.change(screen.getByLabelText("Contact name"), { target: { value: "Ops Lead" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() => expect(sent.contactName).toBe("Ops Lead"));
    expect(sent.name).toBe("Test Delivery");
  });

  /**
   * The form mirrors the API contract. Offering inputs the server would reject
   * would be a UI that teaches the wrong mental model.
   */
  it("offers no input for code, subdomain or environment", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt(`/companies/${companyId}`);
    fireEvent.click(await screen.findByRole("button", { name: "Edit profile" }));

    expect(screen.queryByLabelText("Code")).toBeNull();
    expect(screen.queryByLabelText("Subdomain")).toBeNull();
    expect(screen.queryByLabelText("Environment")).toBeNull();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });

  it("surfaces a server refusal without leaving edit mode silently", async () => {
    const routes = baseRoutes();
    routes[`PATCH platform/companies/${companyId}`] = {
      body: { error: { code: "validation_failed", message: "name must be longer" } },
      status: 400,
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt(`/companies/${companyId}`);

    fireEvent.click(await screen.findByRole("button", { name: "Edit profile" }));
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("name must be longer");
    expect(screen.getByRole("button", { name: "Save profile" })).toBeInTheDocument();
  });
});

describe("Company configuration and audit sections", () => {
  afterEach(() => vi.restoreAllMocks());

  async function selectCompanyTab(name: string): Promise<void> {
    fireEvent.click(await screen.findByRole("tab", { name }));
  }

  it("shows the Configuration section", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt(`/companies/${companyId}`);

    await selectCompanyTab("Configuration & Accounting");

    expect(await screen.findByRole("heading", { name: "Configuration" })).toBeInTheDocument();
    expect(screen.getByText("AED")).toBeInTheDocument();
    expect(screen.getByText("United Arab Emirates (AE)")).toBeInTheDocument();
  });

  it("shows the Platform audit summary", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt(`/companies/${companyId}`);

    await selectCompanyTab("Audit");

    expect(await screen.findByRole("heading", { name: "Audit summary" })).toBeInTheDocument();
    // Scoped to the audit row: the signed-in administrator's name also appears
    // in the page header.
    const auditRow = screen.getByText("created").closest("tr") as HTMLElement;
    expect(within(auditRow).getByText("platform.admin")).toBeInTheDocument();
  });

  it("explains the missing trail rather than failing when audit is not permitted", async () => {
    const routes = baseRoutes();
    routes[`GET platform/companies/${companyId}/audit`] = {
      body: { error: { code: "permission_denied", message: "denied" } },
      status: 403,
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt(`/companies/${companyId}`);

    await selectCompanyTab("Audit");

    await screen.findByRole("heading", { name: "Audit summary" });
    expect(screen.getByText(/platform\.audit\.read/)).toBeInTheDocument();
    // The rest of the page still works.
    expect(screen.getByRole("heading", { name: "Test Delivery" })).toBeInTheDocument();
  });
});

describe("Create Company optional fields", () => {
  afterEach(() => vi.restoreAllMocks());

  it("omits the business-day override when left blank, so the template default applies", async () => {
    const routes = baseRoutes();
    let sent: Record<string, unknown> = {};
    routes["POST platform/companies"] = (body) => {
      sent = body as Record<string, unknown>;
      return { body: { companyId }, status: 201 };
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt("/companies/new");
    await screen.findByRole("button", { name: "Review" });

    fireEvent.change(screen.getByLabelText("Company Name"), { target: { value: "Acme" } });
    fireEvent.change(screen.getByLabelText("Shipment Prefix"), { target: { value: "ACM" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText("08:00")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create Company" }));

    await screen.findByRole("heading", { name: "Test Delivery" });
    expect(sent).not.toHaveProperty("businessDayStart");
  });

  it("sends the business-day override and contact name when supplied", async () => {
    const routes = baseRoutes();
    let sent: Record<string, unknown> = {};
    routes["POST platform/companies"] = (body) => {
      sent = body as Record<string, unknown>;
      return { body: { companyId }, status: 201 };
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt("/companies/new");
    await screen.findByRole("button", { name: "Review" });

    fireEvent.change(screen.getByLabelText("Company Name"), { target: { value: "Acme" } });
    fireEvent.change(screen.getByLabelText("Shipment Prefix"), { target: { value: "ACM" } });
    fireEvent.change(screen.getByLabelText("Business Day Start"), { target: { value: "07:30" } });
    fireEvent.change(screen.getByLabelText("Contact name"), { target: { value: "Ops Lead" } });
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(await screen.findByText("07:30")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create Company" }));

    await screen.findByRole("heading", { name: "Test Delivery" });
    expect(sent.businessDayStart).toBe("07:30");
    expect(sent.contactName).toBe("Ops Lead");
  });
});
