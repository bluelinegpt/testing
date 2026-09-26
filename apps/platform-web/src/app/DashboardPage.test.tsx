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

function identity(permissions: readonly string[] = readOnly): object {
  return {
    accountId: "6f1d0d5e-1c1b-4a2f-9f4e-2f9b7a5c1d33",
    companyId: null,
    displayName: "platform.admin",
    kind: "platform_administrator",
    permissions,
    roles: ["platform_super_admin"],
    username: "platform.admin",
  };
}

const companyId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function summary(overrides: Record<string, unknown> = {}): object {
  return {
    companies: {
      active: 6,
      activePercent: 60,
      closed: 1,
      closedPercent: 10,
      disabled: 0,
      draft: 1,
      newThisMonth: 2,
      suspended: 2,
      suspendedPercent: 20,
      total: 10,
    },
    customers: { new: 3, total: 40 },
    drivers: { new: 1, total: 12 },
    employees: { new: 0, total: 5 },
    filters: { companyId: null, from: "2026-07-14", to: "2026-08-12" },
    metadata: {
      codBasis: "delivered_orders_only",
      customerCountingNote: "note",
      deliveryRateDefinition: "delivered / created",
      previousPeriod: { from: "2026-06-14", to: "2026-07-13" },
      serviceFeeBasis: "delivered_orders_only",
      timezone: "Asia/Dubai",
    },
    orders: {
      cod: 15000,
      codChange: { label: "+10.0%", percent: 10 },
      delivered: 80,
      deliveryRate: 80,
      serviceFees: 900,
      serviceFeesChange: { label: "+5.0%", percent: 5 },
      total: 100,
      totalChange: { label: "+20.0%", percent: 20 },
    },
    traders: { active: 18, new: 2, total: 20 },
    ...overrides,
  };
}

const emptyDistribution = { items: [], total: 0 };
const emptyTrend = { filters: { groupBy: "daily" }, series: [] };
const emptyOverview = { items: [], page: 1, pageSize: 10, total: 0 };
const emptyAttention = { categories: [], generatedAt: "2026-08-12T00:00:00.000Z" };

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

function renderAt(path = "/"): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <PlatformSessionProvider>
        <App />
      </PlatformSessionProvider>
    </MemoryRouter>,
  );
}

const baseRoutes = (permissions: readonly string[] = readOnly): Record<string, Route> => ({
  "GET platform/auth/me": { body: identity(permissions), status: 200 },
  "GET platform/companies": {
    body: { items: [{ id: companyId, nameEn: "Test Delivery" }], page: 1, pageSize: 100, total: 1 },
    status: 200,
  },
  "GET platform/dashboard/companies-by-environment": { body: emptyDistribution, status: 200 },
  "GET platform/dashboard/companies-by-status": { body: emptyDistribution, status: 200 },
  "GET platform/dashboard/company-overview": { body: emptyOverview, status: 200 },
  "GET platform/dashboard/company-ranking": { body: { items: [] }, status: 200 },
  "GET platform/dashboard/needs-attention": { body: emptyAttention, status: 200 },
  "GET platform/dashboard/order-status": { body: emptyDistribution, status: 200 },
  "GET platform/dashboard/orders-by-emirate": { body: emptyDistribution, status: 200 },
  "GET platform/dashboard/orders-trend": { body: emptyTrend, status: 200 },
  "GET platform/dashboard/summary": { body: summary(), status: 200 },
});

describe("Platform Dashboard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows a loading state before the KPI summary arrives", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt("/");
    await screen.findByText("Platform Dashboard");
    expect(screen.getAllByText("Loading…").length).toBeGreaterThan(0);
  });

  it("renders the KPI cards from the summary response", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt("/");

    expect(await screen.findByText("Overview of all Companies and Platform activity")).toBeInTheDocument();
    expect(await screen.findByText("10")).toBeInTheDocument(); // Total Companies
    expect(screen.getByText("100")).toBeInTheDocument(); // Total Orders
    expect(screen.getByText("80")).toBeInTheDocument(); // Delivered Orders
    expect(screen.getByText(/AED 15,000/)).toBeInTheDocument(); // Delivered COD
    expect(screen.getByText(/AED 900/)).toBeInTheDocument(); // Service Fees
    expect(screen.getByText("+20.0% vs previous period")).toBeInTheDocument();
  });

  it("shows an empty-period message rather than a misleading chart when there is no data", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt("/");
    await screen.findByText("10");
    expect(await screen.findAllByText("No Orders in this period.")).not.toHaveLength(0);
  });

  it("sends the selected date range to every period-scoped endpoint when the preset changes", async () => {
    const fetchStub = stubFetch(baseRoutes());
    vi.stubGlobal("fetch", fetchStub);
    renderAt("/");
    await screen.findByText("10");

    fireEvent.change(screen.getByLabelText("Date Range"), { target: { value: "last7" } });

    await waitFor(() => {
      const calls = (fetchStub as unknown as { mock: { calls: [string][] } }).mock.calls.map(([url]) => url);
      expect(calls.some((url) => url.includes("platform/dashboard/summary") && url.includes("from="))).toBe(
        true,
      );
    });
  });

  it("reveals From/To inputs only for a Custom range and rejects an inverted range", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt("/");
    await screen.findByText("10");

    expect(screen.queryByLabelText("From Date")).toBeNull();
    fireEvent.change(screen.getByLabelText("Date Range"), { target: { value: "custom" } });
    expect(screen.getByLabelText("From Date")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("From Date"), { target: { value: "2026-08-10" } });
    fireEvent.change(screen.getByLabelText("To Date"), { target: { value: "2026-08-01" } });
    expect(screen.getByText("The start date must not be after the end date.")).toBeInTheDocument();
  });

  it("scopes to one Company and hides Company-comparison charts that stop being meaningful", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes()));
    renderAt("/");
    await screen.findByText("10");

    expect(screen.getByText("Top Companies by Orders")).toBeInTheDocument();
    expect(screen.getByText("Companies by Status")).toBeInTheDocument();

    fireEvent.change(await screen.findByLabelText("Company"), { target: { value: companyId } });

    await waitFor(() => expect(screen.queryByText("Top Companies by Orders")).toBeNull());
    expect(screen.queryByText("Companies by Status")).toBeNull();
    expect(screen.queryByText("Companies by Environment")).toBeNull();
    // Orders by Emirate and Order Status remain meaningful for one Company.
    expect(screen.getByText("Orders by Emirate")).toBeInTheDocument();
  });

  it("shows a section-level error with Retry rather than blanking the whole Dashboard", async () => {
    const routes = baseRoutes();
    let attempts = 0;
    routes["GET platform/dashboard/summary"] = () => {
      attempts += 1;
      return attempts === 1
        ? { body: { error: { code: "database_integrity_conflict", message: "Try again." } }, status: 409 }
        : { body: summary(), status: 200 };
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt("/");

    expect(await screen.findByText("Try again.")).toBeInTheDocument();
    // The rest of the Dashboard still rendered.
    expect(screen.getByText("Needs Attention")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0] as HTMLElement);
    expect(await screen.findByText("10")).toBeInTheDocument();
  });

  it("shows the Needs Attention categories from real data", async () => {
    const routes = baseRoutes();
    routes["GET platform/dashboard/needs-attention"] = {
      body: {
        categories: [
          {
            companies: [{ code: "TST-0001", id: companyId, name: "Test Delivery" }],
            count: 1,
            key: "no_recent_orders",
            label: "No Orders in the last 30 days",
            severity: "warning",
          },
        ],
        generatedAt: "2026-08-12T00:00:00.000Z",
      },
      status: 200,
    };
    vi.stubGlobal("fetch", stubFetch(routes));
    renderAt("/");

    expect(await screen.findByText("No Orders in the last 30 days")).toBeInTheDocument();
    const card = screen.getByText("No Orders in the last 30 days").closest(".platform-attention-card") as HTMLElement;
    expect(within(card).getByText("Test Delivery")).toBeInTheDocument();
  });

  it("renders and paginates the Company Overview table, sorting on the server", async () => {
    const routes = baseRoutes();
    const overviewRow = {
      cod: 500,
      customers: 3,
      delivered: 4,
      drivers: 2,
      environment: "production",
      id: companyId,
      code: "TST-0001",
      lastOrderAt: "2026-08-12T10:32:00.000Z",
      name: "Test Delivery",
      orders: 5,
      status: "active",
      traders: 1,
    };
    const fetchStub = stubFetch(routes);
    routes["GET platform/dashboard/company-overview"] = {
      body: { items: [overviewRow], page: 1, pageSize: 10, total: 1 },
      status: 200,
    };
    vi.stubGlobal("fetch", fetchStub);
    renderAt("/");

    expect(await screen.findByRole("cell", { name: "Test Delivery" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      `/companies/${companyId}`,
    );

    fireEvent.click(screen.getByRole("button", { name: /Delivered/ }));
    await waitFor(() => {
      const calls = (fetchStub as unknown as { mock: { calls: [string][] } }).mock.calls.map(([url]) => url);
      expect(calls.some((url) => url.includes("company-overview") && url.includes("sort=delivered"))).toBe(
        true,
      );
    });
  });

  it("Refresh re-queries every section without a page reload", async () => {
    const fetchStub = stubFetch(baseRoutes());
    vi.stubGlobal("fetch", fetchStub);
    renderAt("/");
    await screen.findByText("10");
    const callsBefore = (fetchStub as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => {
      const callsAfter = (fetchStub as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  it("shows a permission notice instead of Dashboard data without platform.companies.read", async () => {
    vi.stubGlobal("fetch", stubFetch(baseRoutes(["platform.access"])));
    renderAt("/");

    expect(await screen.findByText("You do not have permission to view Platform metrics.")).toBeInTheDocument();
  });
});
