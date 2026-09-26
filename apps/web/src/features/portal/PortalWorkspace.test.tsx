import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ApiClient } from "../../api/api-client.js";
import type { LoginResponse } from "../../api/contracts.js";
import { i18nInstance } from "../../localization/i18n.js";

import { PortalWorkspace } from "./PortalWorkspace.js";

/**
 * The Trader portal shell.
 *
 * The claims worth pinning down: a Trader with no Store yet lands on an
 * honest Dashboard rather than an error, "My Store" and "Products" reach the
 * SAME reused Storefront/Product screens the Company side already ships (no
 * second Product engine), the Products tab stays gated until a Store exists,
 * and a Driver session never sees any of the new Commerce navigation.
 */

const traderSession: LoginResponse = {
  accessToken: "token",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  identity: {
    companyId: "company-1",
    displayName: "Dev Trader",
    forcePasswordChange: false,
    id: "account-1",
    kind: "trader",
    permissions: [],
    username: "dev-trader",
  },
  tokenType: "Bearer",
};

const driverSession: LoginResponse = {
  ...traderSession,
  identity: { ...traderSession.identity, kind: "driver" },
};

const profile = {
  code: "TR-01",
  commercialNumber: null,
  contactPerson: null,
  email: "trader@example.test",
  id: "trader-1",
  mobileNumber: "9715XXXXXXX",
  name: "Dev Trader",
  nameAr: null,
  preferredLanguage: "en",
  telephone: null,
};

const dashboardWithStore = {
  commerce: {
    activeProducts: 2,
    deliveryCompanyCount: 1,
    draftProducts: 1,
    hasStore: true,
    storeName: "Dev Commerce Store",
    storeStatus: "published",
    storeUrl: "/store/dev-commerce-store",
    totalProducts: 3,
  },
  orders: { active: 1, cancelled: 0, delivered: 4, newOrders: 2, returned: 0, total: 7 },
  period: { monthCodTotal: "1250.00", monthLabel: "2026-08" },
  recentOrders: [],
};

const dashboardNoStore = {
  ...dashboardWithStore,
  commerce: {
    activeProducts: 0,
    deliveryCompanyCount: 0,
    draftProducts: 0,
    hasStore: false,
    storeName: null,
    storeStatus: null,
    storeUrl: null,
    totalProducts: 0,
  },
};

const orderRow = {
  areaName: "Deira",
  codAmount: "150.00",
  customerAddress: "Deira, Dubai",
  customerAmountDue: "150.00",
  customerMobileNumber: "9715XXXXXXX",
  customerName: "Dev Customer",
  deliveryStatus: "new",
  id: "order-1",
  orderDate: "2026-08-01",
  orderNumber: "ORD-000001",
  referenceNumber: "REF-01",
  serviceFee: "10.00",
};

const orderPage = { filteredCount: 1, items: [orderRow], page: 1, pageSize: 25, totalCount: 1 };
const emptyOrderPage = { filteredCount: 0, items: [], page: 1, pageSize: 25, totalCount: 0 };

function mockApi(overrides: {
  readonly dashboard?: unknown;
  readonly mine?: unknown;
  readonly orderSearch?: unknown;
} = {}) {
  const get = vi.fn((path: string) => {
    if (path === "portal/trader/orders") return Promise.resolve([]);
    if (path === "portal/trader/profile") return Promise.resolve(profile);
    if (path === "portal/trader/areas") return Promise.resolve([]);
    if (path === "portal/trader/dashboard") {
      return Promise.resolve(overrides.dashboard ?? dashboardNoStore);
    }
    if (path === "operations/trader-storefronts/mine") {
      return Promise.resolve(overrides.mine === undefined ? null : overrides.mine);
    }
    if (path.startsWith("portal/trader/orders/search")) {
      return Promise.resolve(overrides.orderSearch ?? emptyOrderPage);
    }
    if (path === "portal/driver/orders") return Promise.resolve([]);
    return Promise.reject(new Error(`unhandled GET ${path}`));
  });
  const patch = vi.fn(() => Promise.resolve(profile));
  const post = vi.fn(() => Promise.resolve({}));
  return { get, patch, post } as unknown as ApiClient;
}

async function renderPortal(
  session: LoginResponse,
  api: ApiClient,
) {
  const result = render(
    <PortalWorkspace api={api} onLogout={() => Promise.resolve()} session={session} />,
  );
  await waitFor(() => {
    expect((api.get as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(
      0,
    );
  });
  return result;
}

beforeEach(async () => {
  await i18nInstance.changeLanguage("en");
});

describe("Trader Dashboard", () => {
  it("lands on the Dashboard by default and offers Store creation when none exists", async () => {
    await renderPortal(traderSession, mockApi());
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("You have not created your Store yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Your Store" })).toBeInTheDocument();
  });

  it("shows real Commerce KPIs once a Store exists", async () => {
    await renderPortal(
      traderSession,
      mockApi({ dashboard: dashboardWithStore, mine: { id: "storefront-1" } }),
    );
    expect(await screen.findByText("Dev Commerce Store")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument(); // total Products
    expect(screen.getByRole("link", { name: "View Store" })).toHaveAttribute(
      "href",
      "/store/dev-commerce-store",
    );
  });

  it("never blends lifetime Order counts with the monthly COD figure", async () => {
    await renderPortal(traderSession, mockApi({ dashboard: dashboardWithStore }));
    // "This month" labels the COD figure specifically, not the Order counts.
    expect(await screen.findByText("This month")).toBeInTheDocument();
    expect(screen.getByText("1250.00 AED")).toBeInTheDocument();
  });
});

describe("My Store / Products navigation", () => {
  it("gates the Products tab until the Trader has a Store", async () => {
    await renderPortal(traderSession, mockApi());
    await screen.findByRole("heading", { name: "Dashboard" });
    expect(screen.getByRole("button", { name: "Products" })).toBeDisabled();
  });

  it("enables Products once a Store exists", async () => {
    await renderPortal(
      traderSession,
      mockApi({ dashboard: dashboardWithStore, mine: { id: "storefront-1" } }),
    );
    await screen.findByRole("heading", { name: "Dashboard" });
    expect(screen.getByRole("button", { name: "Products" })).toBeEnabled();
  });

  it("opens the same reused Storefront workspace My Store points at", async () => {
    await renderPortal(traderSession, mockApi());
    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "My Store" }));
    // The Trader-mode creation form: same component as the Company path,
    // just entered without a pre-existing Storefront.
    expect(await screen.findByRole("heading", { name: "Create Your Store" })).toBeInTheDocument();
  });
});

describe("My Profile", () => {
  it("shows the Store summary read-only, separate from Store editing", async () => {
    await renderPortal(traderSession, mockApi({ dashboard: dashboardWithStore }));
    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "My Profile" }));
    expect(await screen.findByText("Store summary")).toBeInTheDocument();
    expect(screen.getByText("Dev Commerce Store")).toBeInTheDocument();
    // No Store-editing controls (slug, publish) leak into Profile.
    expect(screen.queryByRole("button", { name: /Publish/i })).not.toBeInTheDocument();
  });

  it("saves the editable identity fields", async () => {
    const api = mockApi();
    await renderPortal(traderSession, api);
    await screen.findByRole("heading", { name: "Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "My Profile" }));
    await screen.findByRole("button", { name: "Save" });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith(
        "portal/trader/profile",
        expect.objectContaining({ preferredLanguage: "en" }),
      );
    });
  });
});

describe("Trader Orders workspace", () => {
  it("searches through the server rather than filtering a preloaded list", async () => {
    const api = mockApi({ orderSearch: orderPage });
    await renderPortal(traderSession, api);
    fireEvent.click(await screen.findByRole("button", { name: "Trader orders" }));
    expect(await screen.findByText("ORD-000001")).toBeInTheDocument();

    fireEvent.change(
      screen.getByPlaceholderText(
        "Search by Order No., Serial No., Reference No., Customer Name, or Mobile — press Enter",
      ),
      { target: { value: "REF-01" } },
    );
    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith(
        expect.stringContaining("portal/trader/orders/search"),
      );
      expect(api.get).toHaveBeenCalledWith(expect.stringContaining("search=REF-01"));
    });
  });

  it("never sends another Trader's id — there is no field for one", async () => {
    const api = mockApi({ orderSearch: orderPage });
    await renderPortal(traderSession, api);
    fireEvent.click(await screen.findByRole("button", { name: "Trader orders" }));
    await screen.findByText("ORD-000001");
    for (const call of (api.get as unknown as { mock: { calls: unknown[][] } }).mock.calls) {
      expect(String(call[0])).not.toMatch(/traderId/i);
    }
  });

  it("shows an honest empty state rather than a blank table", async () => {
    await renderPortal(traderSession, mockApi());
    fireEvent.click(await screen.findByRole("button", { name: "Trader orders" }));
    expect(await screen.findByText("No orders are available.")).toBeInTheDocument();
  });

  it("opens Create Order and Create Multiple Orders from the same toolbar", async () => {
    await renderPortal(traderSession, mockApi());
    fireEvent.click(await screen.findByRole("button", { name: "Trader orders" }));
    await screen.findByText("No orders are available.");
    fireEvent.click(screen.getByRole("button", { name: "Create Multiple Orders" }));
    expect(await screen.findByRole("heading", { name: "Create Multiple Orders" })).toBeInTheDocument();
    // The bulk template has no Trader/Company columns for the Trader to fill in.
    const textarea = screen.getByLabelText("CSV rows") as HTMLTextAreaElement;
    expect(textarea.value).not.toMatch(/traderId/i);
    expect(textarea.value).not.toMatch(/driverId/i);
  });

  it("submits the bulk import to the Trader-scoped endpoint, not the Company one", async () => {
    const api = mockApi();
    (api.post as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
      errors: [],
      importNumber: "IMP-1",
      importedRows: 2,
      rows: [],
      totalRows: 2,
    });
    await renderPortal(traderSession, api);
    fireEvent.click(await screen.findByRole("button", { name: "Trader orders" }));
    await screen.findByText("No orders are available.");
    fireEvent.click(screen.getByRole("button", { name: "Create Multiple Orders" }));
    await screen.findByRole("heading", { name: "Create Multiple Orders" });
    fireEvent.click(screen.getByRole("button", { name: "Submit Orders" }));
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(
        "portal/trader/orders/import-csv",
        expect.objectContaining({ csv: expect.any(String) }),
      );
    });
  });
});

describe("Driver session", () => {
  it("shows no Commerce navigation at all", async () => {
    await renderPortal(driverSession, mockApi());
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Driver orders" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Dashboard" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "My Store" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Products" })).not.toBeInTheDocument();
  });
});
