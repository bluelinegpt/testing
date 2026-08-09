import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, vi } from "vitest";

vi.mock("../configuration/environment.js", () => ({
  webConfiguration: { apiBaseUrl: "https://api.blueline.test/api/v1" },
}));

import { i18nInstance } from "../localization/i18n.js";
import { localeStorageKey } from "../localization/locale.js";
import { App } from "./App.js";

describe("App", () => {
  beforeEach(async () => {
    localStorage.clear();
    await i18nInstance.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders Company sign-in and switches to Arabic RTL", async () => {
    vi.stubGlobal("fetch", createFetchMock());
    renderApp();

    // The app asks the server whether a session exists before deciding what to
    // render, so Sign in appears once that answer arrives — never before.
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "العربية" }));

    expect(await screen.findByRole("heading", { name: "تسجيل الدخول" })).toBeInTheDocument();
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("ar");
    expect(localStorage.getItem(localeStorageKey)).toBe("ar");
  });

  it("signs in, renders the shared shell, and navigates to a separate Orders route", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const router = renderApp();

    await signIn();
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("navigation")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Orders" }));
    const ordersLink = screen.getByRole("link", { name: "All orders" });
    expect(ordersLink).toBeInTheDocument();
    fireEvent.click(ordersLink);

    expect(await screen.findByRole("heading", { level: 1, name: "Orders" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/orders");
    expect(screen.getByRole("tablist", { name: "Order quick views" })).toBeInTheDocument();
    expect(ordersLink).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Create order" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create trader" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/operations/orders"),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: `Bearer ${"t".repeat(43)}` }),
        }),
      ),
    );
  });

  it("returns to the requested authorized route after login", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    // A deep link that survives the login round trip: when a reload destroys
    // the in-memory session, signing back in resumes the path the User asked
    // for rather than dumping them on the default workspace. `landingPath`
    // still runs the requested path through `canAccessCompanyPath`, so this
    // only holds for a route the User is authorized to open.
    const router = renderApp("/configuration/areas");

    await signIn();

    // Both halves matter: the router actually moved there, and the screen for
    // that route rendered. Asserting only the pathname would pass even if the
    // page failed to mount.
    expect(router.state.location.pathname).toBe("/configuration/areas");
    expect(await screen.findByRole("heading", { level: 1, name: "Areas" })).toBeInTheDocument();
    expect(localStorage.getItem("accessToken")).toBeNull();
  });

  it("shows a controlled no-access page when no workspace is permitted", async () => {
    vi.stubGlobal("fetch", createFetchMock([]));
    renderApp("/orders");

    await signIn();

    expect(
      await screen.findByRole("heading", { name: "No accessible workspace" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "All orders" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Orders" })).not.toBeInTheDocument();
  });

  it("lands an orders.create-only User on Create Order and hides administration", async () => {
    const fetchMock = createFetchMock(["orders.create"]);
    vi.stubGlobal("fetch", fetchMock);
    const router = renderApp("/configuration/users");

    await signIn();

    await waitFor(() => expect(router.state.location.pathname).toBe("/orders/create"));
    expect(await screen.findByRole("heading", { name: "Create order" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument();
    // General Settings is reachable by everyone for their personal display
    // preference, so the Configuration group shows — but only its General
    // settings item, never the admin-only items (Users, etc.).
    expect(screen.getByRole("button", { name: "Configuration" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/users"))).toBe(false);

    await router.navigate("/configuration/users");
    expect(await screen.findByRole("heading", { name: "Access denied" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/users"))).toBe(false);
  });

  it("expands one translated submenu at a time and exposes mobile navigation controls", async () => {
    vi.stubGlobal("fetch", createFetchMock());
    renderApp();
    await signIn();
    await screen.findByRole("heading", { name: "Dashboard" });

    const orders = screen.getByRole("button", { name: "Orders" });
    const configuration = screen.getByRole("button", { name: "Configuration" });
    fireEvent.click(orders);
    expect(orders).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(configuration);
    expect(configuration).toHaveAttribute("aria-expanded", "true");
    expect(orders).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getAllByRole("button", { name: "Close navigation" })).toHaveLength(2);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryAllByRole("button", { name: "Close navigation" })).toHaveLength(0),
    );
  });

  it("collapses the desktop sidebar and translates authenticated navigation to Arabic", async () => {
    vi.stubGlobal("fetch", createFetchMock());
    renderApp();
    await signIn();
    await screen.findByRole("heading", { name: "Dashboard" });

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(document.querySelector(".company-shell")).toHaveClass("company-shell-collapsed");
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "العربية" }));
    expect(await screen.findByRole("button", { name: "الطلبات" })).toBeInTheDocument();
    expect(document.documentElement.dir).toBe("rtl");
  });

  it("redirects the old combined Configuration route to General settings", async () => {
    vi.stubGlobal("fetch", createFetchMock());
    const router = renderApp("/configuration");
    await signIn();

    expect(
      await screen.findByRole("heading", { level: 1, name: "General settings" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/configuration/general");
    expect(await screen.findByLabelText("Default language")).toBeInTheDocument();
    expect(screen.queryByLabelText("VAT rate")).not.toBeInTheDocument();
  });

  it("redirects both retired Driver-reconciliation routes to Driver Collections", async () => {
    vi.stubGlobal("fetch", createFetchMock());
    const router = renderApp("/driver-cash-reconciliation");
    await signIn();

    expect(
      await screen.findByRole("heading", { level: 1, name: "Driver Collections" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/drivers");
  });

  it("redirects the retired New driver reconciliation route to Driver Collections", async () => {
    vi.stubGlobal("fetch", createFetchMock());
    const router = renderApp("/operations/driver-reconciliations/new");
    await signIn();

    expect(
      await screen.findByRole("heading", { level: 1, name: "Driver Collections" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/drivers");
  });

  it("redirects the retired /traders route to the Trader Settlements workspace", async () => {
    vi.stubGlobal("fetch", createFetchMock());
    const router = renderApp("/traders");
    await signIn();

    expect(
      await screen.findByRole("heading", { level: 1, name: "Trader Settlements" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/trader-settlements");
  });
});

function renderApp(path = "/") {
  const router = createMemoryRouter([{ element: <App />, path: "*" }], {
    initialEntries: [path],
  });
  render(<RouterProvider router={router} />);
  return router;
}

async function signIn() {
  fireEvent.change(await screen.findByLabelText("Username, Email, or Mobile Number"), {
    target: { value: "administrator" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "secure-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

function createFetchMock(permissions: readonly string[] = ["users_roles.manage"]) {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    });

  // No session exists until a sign-in happens in the test, which is what the
  // browser sees on a first visit. The app now asks `auth/me` on load, so a
  // stub that always answered would render the workspace before any login.
  let signedIn = false;

  return vi.fn().mockImplementation((url: string) => {
    if (url.endsWith("/auth/login")) {
      signedIn = true;
      return Promise.resolve(
        json({
          accessToken: "t".repeat(43),
          expiresAt: "2026-07-14T12:00:00.000Z",
          identity: {
            companyId: "10000000-0000-4000-8000-000000000001",
            id: "20000000-0000-4000-8000-000000000001",
            kind: "company_user",
            permissions,
            username: "administrator",
            forcePasswordChange: false,
          },
          tokenType: "Bearer",
        }),
      );
    }
    if (url.endsWith("/auth/me")) {
      if (!signedIn) {
        return Promise.resolve(
          json({ error: { code: "authentication_required", message: "No session" } }, 401),
        );
      }
      return Promise.resolve(
        json({
          companyId: "10000000-0000-4000-8000-000000000001",
          forcePasswordChange: false,
          identityId: "20000000-0000-4000-8000-000000000001",
          kind: "company_user",
          permissions,
          sessionId: "30000000-0000-4000-8000-000000000001",
        }),
      );
    }
    if (url.includes("/operations/overview")) {
      return Promise.resolve(
        json({
          counts: {
            activeDrivers: 0,
            activeTraders: 0,
            orders: 0,
            pendingCashOrders: 0,
            unsettledTraderOrders: 0,
          },
          deliveryStatuses: [],
          financials: {
            codAmount: "0",
            companyRevenue: "0",
            customerAmountDue: "0",
            orderProfit: "0",
            traderNetPayable: "0",
            vatAmount: "0",
          },
        }),
      );
    }
    if (url.endsWith("/operations/billing/summary")) {
      return Promise.resolve(
        json({
          billableOrders: 0,
          commercialStatus: "Commercial setup pending",
          currentPeriodStart: "2026-07-01",
          lastUsageAt: null,
          planName: "Manual agreement",
        }),
      );
    }
    if (url.endsWith("/configuration/settings")) {
      return Promise.resolve(
        json({
          baseCurrency: "AED",
          defaultLanguage: "en",
          documentExpiryAlertDays: null,
          orderPendingAlertHours: null,
          timezone: "Asia/Dubai",
          vatEnabled: true,
          vatPriceMode: "exclusive",
          vatRate: "5",
        }),
      );
    }
    if (url.endsWith("/operations/orders") || url.includes("/operations/orders?")) {
      return Promise.resolve(
        json({ filteredCount: 0, items: [], page: 1, pageSize: 25, totalCount: 0 }),
      );
    }
    if (
      [
        "/configuration/areas",
        "/configuration/bank-accounts",
        "/operations/traders",
        "/operations/drivers",
        "/operations/cash/pending",
        "/operations/cash/reconciliations",
        "/operations/settlements/pending",
        "/operations/settlements",
        "/users",
        "/roles/permissions",
        "/roles",
        "/support/cases",
      ].some((path) => url.endsWith(path))
    ) {
      return Promise.resolve(json([]));
    }
    return Promise.resolve(json({}, 404));
  });
}
