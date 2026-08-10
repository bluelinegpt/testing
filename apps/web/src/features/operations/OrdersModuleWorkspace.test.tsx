import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";

/**
 * The workspaces under test now read their list state from the URL via
 * `useListState` -> `useSearchParams`, which requires a Router in context.
 *
 * A real `MemoryRouter` is used rather than mocking the hooks: mocking would
 * hide the very behaviour the URL-state migration introduced, and these suites
 * would stop proving that the screens mount at all. The default entry is "/",
 * which carries no search parameters, so every existing assumption about
 * starting filters, page and sort is unchanged.
 */
function renderWithRouter(ui: ReactElement, initialEntries: readonly string[] = ["/"]) {
  return render(<MemoryRouter initialEntries={[...initialEntries]}>{ui}</MemoryRouter>);
}

import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { formatCurrency } from "../../localization/formatters.js";
import { OrdersModuleWorkspace } from "./OrdersModuleWorkspace.js";

const aed = (value: string) => formatCurrency(value, "AED", "en");

const order = {
  amountCollected: "0.00",
  areaName: "Dubai",
  assignedDriverId: null,
  assignedDriverMobile: null,
  assignedDriverName: null,
  codAmount: "100.00",
  companyRevenue: "10.00",
  customerAddress: "Dubai",
  customerAmountDue: "110.00",
  customerMobileNumber: "971501234567",
  customerName: "Aisha",
  deliveryStatus: "new",
  driverReconciliationStatus: "not_applicable",
  id: "10000000-0000-4000-8000-000000000001",
  orderDate: "2026-07-15",
  orderNumber: "ORD-000001",
  orderProfit: "10.00",
  referenceNumber: "REF-000001",
  returnStatus: "not_applicable",
  serialNumber: "SER-000001",
  serviceFee: "10.00",
  totalDeductions: "10.00",
  traderNetPayable: "90.00",
  traderName: "Test Trader",
  traderSettlementStatus: "unsettled",
  vatAmount: "0.00",
};

const heldOrder = {
  ...order,
  assignedDriverId: "20000000-0000-4000-8000-000000000001",
  assignedDriverMobile: "971501234568",
  assignedDriverName: "Ahmed",
  deliveryStatus: "hold",
  id: "10000000-0000-4000-8000-000000000002",
  orderNumber: "ORD-000002",
  referenceNumber: null,
  serialNumber: "SER-000002",
};

describe("OrdersModuleWorkspace", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("uses Active Orders server paging and supports selection across matching results", async () => {
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/orders?")) {
          return Promise.resolve({
            filteredCount: 40,
            items: [order],
            page: 1,
            pageSize: 25,
            totalCount: 50,
          });
        }
        // Areas are paginated; every other collection is still a plain array.
        if (path.startsWith("configuration/areas")) {
          return Promise.resolve({ items: [], page: 1, pageSize: 100, total: 0 });
        }
        return Promise.resolve([]);
      }),
      post: vi.fn().mockResolvedValue({
        eligibleCount: 40,
        ineligible: [],
        selectedAmountToCollect: "4400.00",
        selectedCount: 40,
      }),
    };
    const onNavigate = vi.fn();
    renderWithRouter(
      <OrdersModuleWorkspace
        api={api as unknown as ApiClient}
        onNavigate={onNavigate}
        permissions={["users_roles.manage"]}
      />,
    );

    await screen.findByText("SER-000001");
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining("quickView=active"));
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining("pageSize=25"));

    fireEvent.click(screen.getByLabelText("Select all Orders on this page"));
    fireEvent.click(screen.getByRole("button", { name: "Select all 40 matching Orders" }));
    await waitFor(() =>
      expect(api.post).toHaveBeenLastCalledWith(
        "operations/orders/selection-summary",
        expect.objectContaining({ selectionMode: "filter" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "SER-000001" }));
    expect(onNavigate).toHaveBeenCalledWith("/orders/ORD-000001");
  });

  it("prints the Driver Shipment Manifest with a clean selected-order payload", async () => {
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/orders?")) {
          return Promise.resolve({
            filteredCount: 1,
            items: [heldOrder],
            page: 1,
            pageSize: 25,
            totalCount: 1,
          });
        }
        if (path.startsWith("configuration/areas")) {
          return Promise.resolve({ items: [], page: 1, pageSize: 100, total: 0 });
        }
        return Promise.resolve([]);
      }),
      post: vi.fn((path: string) => {
        if (path === "operations/orders/selection-summary") {
          return Promise.resolve({
            eligibleCount: 1,
            ineligible: [],
            selectedAmountToCollect: "110.00",
            selectedCount: 1,
          });
        }
        if (path === "operations/cash/driver-shipment-manifest/data") {
          return Promise.resolve({
            header: { driverMobile: "971501234568", driverName: "Ahmed", orderCount: 1 },
            summary: { totalCod: "100.00", totalOrders: 1, totalPackages: 1 },
          });
        }
        return Promise.resolve({});
      }),
    };
    renderWithRouter(
      <OrdersModuleWorkspace
        api={api as unknown as ApiClient}
        onNavigate={vi.fn()}
        permissions={["users_roles.manage"]}
      />,
    );

    fireEvent.click(await screen.findByLabelText("Select Order SER-000002"));
    fireEvent.click(screen.getByRole("button", { name: "Print Driver Shipment Manifest" }));

    await screen.findByRole("dialog", { name: "Print Driver Shipment Manifest" });
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("operations/cash/driver-shipment-manifest/data", {
        orderIds: [heldOrder.id],
        selectionMode: "ids",
      }),
    );
  });

  it("drives a new order to Item in branch from the per-row action menu", async () => {
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/orders?")) {
          return Promise.resolve({
            filteredCount: 1,
            items: [order],
            page: 1,
            pageSize: 25,
            totalCount: 1,
          });
        }
        if (path.startsWith("configuration/areas")) {
          return Promise.resolve({ items: [], page: 1, pageSize: 100, total: 0 });
        }
        return Promise.resolve([]);
      }),
      patch: vi.fn().mockResolvedValue({}),
      post: vi.fn().mockResolvedValue({}),
    };
    renderWithRouter(
      <OrdersModuleWorkspace
        api={api as unknown as ApiClient}
        onNavigate={vi.fn()}
        permissions={["users_roles.manage"]}
      />,
    );

    await screen.findByText("SER-000001");
    // Delivery Status and Financial Status (Driver Collection / Trader Settlement)
    // are separate columns — never merged into one general "Status" (§3).
    expect(screen.getByRole("columnheader", { name: "Delivery status" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Collection / Settlement" })).toBeVisible();
    expect(screen.queryByRole("columnheader", { name: "Stage" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Status" })).not.toBeInTheDocument();
    expect(screen.getAllByText("New").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole("button", { name: "Order actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark item in branch" }));

    // The transition now CONFIRMS before it writes. It used to PATCH straight
    // from the menu, which left a smart next action nothing to open and no safe
    // way to suggest a status.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
    // The menu's choice arrives as the suggested value.
    expect((within(dialog).getByRole("combobox") as HTMLSelectElement).value).toBe("in_branch");

    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        `operations/orders/${order.id}/status`,
        expect.objectContaining({ status: "in_branch" }),
      ),
    );
  });

  it("opens Change Status directly from a smart next-action deep link", async () => {
    // The screenshot case, end to end: the popover's primary action lands here
    // and the dialog opens on the right Order with `delivered` suggested.
    const delivered = { ...order, deliveryStatus: "out_for_delivery" };
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/orders?")) {
          return Promise.resolve({
            filteredCount: 1,
            items: [delivered],
            page: 1,
            pageSize: 25,
            totalCount: 1,
          });
        }
        if (path.startsWith("configuration/areas")) {
          return Promise.resolve({ items: [], page: 1, pageSize: 100, total: 0 });
        }
        return Promise.resolve([]);
      }),
      patch: vi.fn().mockResolvedValue({}),
      post: vi.fn().mockResolvedValue({}),
    };
    globalThis.history.replaceState(
      {},
      "",
      `/orders?orderId=${order.id}&suggestedStatus=delivered&openDialog=change_status&returnTo=%2Forders`,
    );
    renderWithRouter(
      <OrdersModuleWorkspace
        api={api as unknown as ApiClient}
        onNavigate={vi.fn()}
        permissions={["users_roles.manage"]}
      />,
    );

    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByRole("combobox") as HTMLSelectElement).value).toBe("delivered");
    // Nothing is written by arriving.
    expect(api.patch).not.toHaveBeenCalled();
    // And the instruction is gone, so a refresh cannot reopen it.
    expect(globalThis.location.search).not.toContain("openDialog");
    expect(globalThis.location.search).toContain("returnTo");
  });

  it("does not reopen Change Status with the next transition after confirming one", async () => {
    /* The reported defect. Arriving from "Change Status to Out for Delivery"
       opened the dialog correctly; confirming it wrote the status, reloaded the
       list, and then opened the dialog a SECOND time offering "Mark delivered"
       -- as if a further change had been requested. Nobody asked for it, and on
       a screen full of money that reads like the first change failed.

       The cause was the deep-link request being rebuilt on every render while
       the guard meant to retire it (`consumedDeepLink`) was never set, so the
       effect refired on the reload it had itself caused. */
    const assigned = {
      ...order,
      assignedDriverId: "20000000-0000-4000-8000-000000000001",
      assignedDriverName: "Driver 2",
      deliveryStatus: "assigned_to_driver",
    };
    // The list reflects the write, exactly as the real reload does -- which is
    // what made the replayed dialog offer the following status rather than the
    // same one.
    let status = "assigned_to_driver";
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/orders?")) {
          return Promise.resolve({
            filteredCount: 1,
            items: [{ ...assigned, deliveryStatus: status }],
            page: 1,
            pageSize: 25,
            totalCount: 1,
          });
        }
        if (path.startsWith("configuration/areas")) {
          return Promise.resolve({ items: [], page: 1, pageSize: 100, total: 0 });
        }
        return Promise.resolve([]);
      }),
      patch: vi.fn().mockImplementation(() => {
        status = "out_for_delivery";
        return Promise.resolve({});
      }),
      post: vi.fn().mockResolvedValue({}),
    };
    globalThis.history.replaceState(
      {},
      "",
      `/orders?orderId=${order.id}&suggestedStatus=out_for_delivery&openDialog=change_status`,
    );
    renderWithRouter(
      <OrdersModuleWorkspace
        api={api as unknown as ApiClient}
        onNavigate={vi.fn()}
        permissions={["users_roles.manage"]}
      />,
    );

    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByRole("combobox") as HTMLSelectElement).value).toBe(
      "out_for_delivery",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        `operations/orders/${order.id}/status`,
        expect.objectContaining({ status: "out_for_delivery" }),
      ),
    );

    /* The reload has happened and the row now reads out_for_delivery. Matched
       against the row's status badge specifically: the phrase also appears as a
       Delivery Status filter option, which is present from first paint and would
       make this pass without any reload at all. */
    await waitFor(() =>
      expect(
        within(screen.getByRole("table")).getAllByText("Out for delivery").length,
      ).toBeGreaterThan(0),
    );
    /* ...and no second dialog came with it. Given time to appear first: the
       replay happens in an effect after the reload commits, so asserting the
       instant the row text changes can beat the bug to the DOM. */
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("dialog")).toBeNull();
    // Only the one transition was ever written.
    expect(api.patch).toHaveBeenCalledTimes(1);
  });

  it("opens the existing ReasonDialog for a return deep link", async () => {
    // Return and Cancel REQUIRE a reason, so they route to ReasonDialog rather
    // than to the plain status confirmation.
    const outForDelivery = { ...order, deliveryStatus: "out_for_delivery" };
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/orders?")) {
          return Promise.resolve({
            filteredCount: 1,
            items: [outForDelivery],
            page: 1,
            pageSize: 25,
            totalCount: 1,
          });
        }
        if (path.startsWith("configuration/areas")) {
          return Promise.resolve({ items: [], page: 1, pageSize: 100, total: 0 });
        }
        return Promise.resolve([]);
      }),
      patch: vi.fn().mockResolvedValue({}),
      post: vi.fn().mockResolvedValue({}),
    };
    globalThis.history.replaceState(
      {},
      "",
      `/orders?orderId=${order.id}&suggestedStatus=returned_to_branch&openDialog=change_status&returnTo=%2Forders`,
    );
    renderWithRouter(
      <OrdersModuleWorkspace
        api={api as unknown as ApiClient}
        onNavigate={vi.fn()}
        permissions={["users_roles.manage"]}
      />,
    );

    const dialog = await screen.findByRole("dialog");
    // A reason prompt, not the status dropdown.
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    // Nothing is written by arriving.
    expect(api.patch).not.toHaveBeenCalled();
    expect(globalThis.location.search).not.toContain("openDialog");
  });

  it("does not force an action the Order is no longer eligible for", async () => {
    // A delivered Order cannot be returned to branch; the row menu would not
    // offer it, so the deep link must not either.
    const delivered = { ...order, deliveryStatus: "delivered" };
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/orders?")) {
          return Promise.resolve({
            filteredCount: 1,
            items: [delivered],
            page: 1,
            pageSize: 25,
            totalCount: 1,
          });
        }
        if (path.startsWith("configuration/areas")) {
          return Promise.resolve({ items: [], page: 1, pageSize: 100, total: 0 });
        }
        return Promise.resolve([]);
      }),
      patch: vi.fn().mockResolvedValue({}),
      post: vi.fn().mockResolvedValue({}),
    };
    globalThis.history.replaceState(
      {},
      "",
      `/orders?orderId=${order.id}&suggestedStatus=returned_to_branch&openDialog=change_status`,
    );
    renderWithRouter(
      <OrdersModuleWorkspace
        api={api as unknown as ApiClient}
        onNavigate={vi.fn()}
        permissions={["users_roles.manage"]}
      />,
    );

    expect(await screen.findByText(/no longer eligible for this action/i)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("groups the visible page and selects only within one group", async () => {
    const api = {
      get: vi.fn((path: string) => {
        if (path.includes("quickView=hold")) {
          return Promise.resolve({
            filteredCount: 1,
            items: [heldOrder],
            page: 1,
            pageSize: 25,
            totalCount: 2,
          });
        }
        if (path.startsWith("operations/orders?")) {
          return Promise.resolve({
            filteredCount: 2,
            items: [order, heldOrder],
            page: 1,
            pageSize: 25,
            totalCount: 2,
          });
        }
        if (path.startsWith("configuration/areas")) {
          return Promise.resolve({ items: [], page: 1, pageSize: 100, total: 0 });
        }
        return Promise.resolve([]);
      }),
      post: vi.fn().mockResolvedValue({
        eligibleCount: 1,
        ineligible: [],
        selectedAmountToCollect: "110.00",
        selectedCount: 1,
      }),
    };
    renderWithRouter(
      <OrdersModuleWorkspace
        api={api as unknown as ApiClient}
        onNavigate={vi.fn()}
        permissions={["users_roles.manage"]}
      />,
    );

    await screen.findByText("SER-000001");
    fireEvent.change(screen.getByLabelText("Grouping"), { target: { value: "status" } });

    const holdGroupSelection = screen.getByLabelText("Select visible Orders in Hold");
    fireEvent.click(holdGroupSelection);
    expect(screen.getByLabelText("Select Order SER-000002")).toBeChecked();
    expect(screen.getByLabelText("Select Order SER-000001")).not.toBeChecked();
    expect(screen.queryByLabelText("Select all Orders on this page")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "operations/orders/selection-summary",
        expect.objectContaining({
          orderIds: [heldOrder.id],
          selectionMode: "ids",
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /Hold.*1 visible Orders.*1 selected/ }));
    expect(screen.queryByText("SER-000002")).not.toBeInTheDocument();
    expect(holdGroupSelection).toBeChecked();

    fireEvent.change(screen.getByLabelText("Grouping"), { target: { value: "driver" } });
    expect(
      screen.getByRole("button", { name: /Ahmed.*1 visible Orders.*1 selected/ }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /Unassigned.*1 visible Orders/ })).toBeVisible();
  });

  it("shows the Hold tab count and intentionally absent Reference Numbers", async () => {
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/orders?")) {
          return Promise.resolve({
            filteredCount: 1,
            items: [heldOrder],
            page: 1,
            pageSize: 25,
            totalCount: 1,
          });
        }
        if (path.startsWith("configuration/areas")) {
          return Promise.resolve({ items: [], page: 1, pageSize: 100, total: 0 });
        }
        return Promise.resolve([]);
      }),
      post: vi.fn().mockResolvedValue({}),
    };
    renderWithRouter(
      <OrdersModuleWorkspace
        api={api as unknown as ApiClient}
        onNavigate={vi.fn()}
        permissions={["users_roles.manage"]}
      />,
    );

    await screen.findByText("SER-000002");
    expect(screen.getByRole("tab", { name: /Hold.*1/ })).toBeVisible();
    expect(screen.getByText("Not provided")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Order actions" }));
    expect(screen.getByRole("button", { name: "Send out for delivery" })).toBeVisible();
  });

  it("uses a searchable Emirate-aware Area filter without internal Area codes", async () => {
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/orders?")) {
          return Promise.resolve({
            filteredCount: 1,
            items: [order],
            page: 1,
            pageSize: 25,
            totalCount: 1,
          });
        }
        if (path === "configuration/emirates") {
          return Promise.resolve([{ code: "DXB", id: "e1", nameAr: "دبي", nameEn: "Dubai" }]);
        }
        if (path.startsWith("configuration/areas/search")) {
          return Promise.resolve({
            hasMore: false,
            items: [
              {
                code: "AREA-000068",
                emirateCode: "DXB",
                emirateId: "e1",
                emirateNameAr: "دبي",
                emirateNameEn: "Dubai",
                id: "a1",
                isActive: true,
                nameAr: "البطين",
                nameEn: "Al Bateen",
                notes: null,
                updatedAt: "2026-07-19T10:00:00.000Z",
              },
            ],
            total: 1,
          });
        }
        return Promise.resolve([]);
      }),
      post: vi.fn().mockResolvedValue({}),
    };
    renderWithRouter(
      <OrdersModuleWorkspace
        api={api as unknown as ApiClient}
        onNavigate={vi.fn()}
        permissions={["users_roles.manage"]}
      />,
    );
    await screen.findByText("SER-000001");

    // The Area filter is the shared Emirate-aware control, not a plain dropdown.
    const emirate = screen.getByLabelText("Emirate");
    fireEvent.change(emirate, { target: { value: "e1" } });
    expect(await screen.findByPlaceholderText("Search by Area name or code")).toBeInTheDocument();

    // Internal Area codes (AREA-xxxxxx) are never shown to operational users.
    expect(screen.queryByText(/AREA-\d+/)).not.toBeInTheDocument();
  });
});

describe("CollectMoneyDialog financial formulas", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  const driver = {
    activeOrders: 1,
    code: "DRV-000001",
    deliveredOrders: 1,
    id: "20000000-0000-4000-8000-000000000001",
    mobileNumber: "971501234568",
    name: "Shoala",
    pendingCashOrders: 1,
    status: "active",
    type: "employee",
  };

  // Customer Amount to Collect = 200, Company Fees = 25, Amount Due to Trader = 175
  // — the exact figures from the reported defect.
  const deliveredOrder = {
    ...order,
    assignedDriverId: driver.id,
    assignedDriverMobile: driver.mobileNumber,
    assignedDriverName: driver.name,
    codAmount: "200.00",
    customerAmountDue: "200.00",
    deliveryStatus: "delivered",
    driverReconciliationStatus: "pending",
    id: "10000000-0000-4000-8000-000000000010",
    orderNumber: "ORD-000010",
    serialNumber: "SER-000010",
    totalDeductions: "25.00",
    traderNetPayable: "175.00",
  };

  const secondDeliveredOrder = {
    ...deliveredOrder,
    codAmount: "150.00",
    customerAmountDue: "150.00",
    id: "10000000-0000-4000-8000-000000000011",
    orderNumber: "ORD-000011",
    serialNumber: "SER-000011",
    totalDeductions: "25.00",
    traderNetPayable: "125.00",
  };

  interface CollectPreviewBody {
    readonly expenses?: readonly unknown[];
  }

  function setup(
    orders: readonly (typeof deliveredOrder)[],
    previewByBody: (body: CollectPreviewBody) => unknown,
  ) {
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/orders?")) {
          return Promise.resolve({
            filteredCount: orders.length,
            items: orders,
            page: 1,
            pageSize: 25,
            totalCount: orders.length,
          });
        }
        if (path.startsWith("operations/drivers")) {
          return Promise.resolve([driver]);
        }
        if (path.startsWith("operations/cash/expense-types")) {
          return Promise.resolve([{ id: "expense-fuel", name: "Fuel" }]);
        }
        if (path.startsWith("configuration/areas")) {
          return Promise.resolve({ items: [], page: 1, pageSize: 100, total: 0 });
        }
        return Promise.resolve([]);
      }),
      post: vi.fn((path: string, body?: unknown) => {
        if (path === "operations/orders/selection-summary") {
          return Promise.resolve({
            eligibleCount: orders.length,
            ineligible: [],
            selectedAmountToCollect: "0.00",
            selectedCount: orders.length,
          });
        }
        if (path === "operations/cash/reconciliations/preview") {
          return Promise.resolve(previewByBody(body as CollectPreviewBody));
        }
        return Promise.resolve({});
      }),
    };
    renderWithRouter(
      <OrdersModuleWorkspace
        api={api as unknown as ApiClient}
        onNavigate={vi.fn()}
        permissions={["users_roles.manage"]}
      />,
    );
    return { api };
  }

  async function openDialogWithAllOrders(orders: readonly (typeof deliveredOrder)[]) {
    for (const item of orders) {
      fireEvent.click(
        await screen.findByRole("checkbox", { name: `Select Order ${item.serialNumber}` }),
      );
    }
    fireEvent.click(await screen.findByRole("button", { name: "Collect money from driver" }));
    const dialog = within(await screen.findByRole("dialog"));
    // The dialog first renders a loading state while the preview request is in
    // flight (debounced); wait for the resolved content before returning.
    await dialog.findByLabelText("Actual Amount Received");
    return dialog;
  }

  it("binds Gross Collections, Company Fees, Amount Due to Trader and Net Expected from the server preview — one Order", async () => {
    setup([deliveredOrder], () =>
      Promise.resolve({
        companyFees: "25.00",
        difference: "-200.00",
        driverId: driver.id,
        expenseTotal: "0.00",
        grossCollections: "200.00",
        netAmountExpected: "200.00",
        orderCount: 1,
        paymentTotal: "0.00",
        traderCount: 1,
        traderPayable: "175.00",
        warnings: [],
      }),
    );
    const dialog = await openDialogWithAllOrders([deliveredOrder]);

    expect(
      (await dialog.findByText("Gross Customer Collections")).nextElementSibling?.textContent,
    ).toBe(aed("200.00"));
    expect(dialog.getByText("Company fees").nextElementSibling?.textContent).toBe(aed("25.00"));
    expect(dialog.getByText("Amount due to Trader").nextElementSibling?.textContent).toBe(
      aed("175.00"),
    );
    expect(dialog.getAllByText("Driver-level expenses")[0]?.nextElementSibling?.textContent).toBe(
      aed("0.00"),
    );
    expect(dialog.getByText("Net Expected from Driver").nextElementSibling?.textContent).toBe(
      aed("200.00"),
    );
  });

  it("sums Gross Collections, Company Fees and Amount Due to Trader across multiple Orders", async () => {
    setup([deliveredOrder, secondDeliveredOrder], () =>
      Promise.resolve({
        companyFees: "50.00",
        difference: "-350.00",
        driverId: driver.id,
        expenseTotal: "0.00",
        grossCollections: "350.00",
        netAmountExpected: "350.00",
        orderCount: 2,
        paymentTotal: "0.00",
        traderCount: 1,
        traderPayable: "300.00",
        warnings: [],
      }),
    );
    const dialog = await openDialogWithAllOrders([deliveredOrder, secondDeliveredOrder]);

    expect(
      (await dialog.findByText("Gross Customer Collections")).nextElementSibling?.textContent,
    ).toBe(aed("350.00"));
    expect(dialog.getByText("Company fees").nextElementSibling?.textContent).toBe(aed("50.00"));
    expect(dialog.getByText("Amount due to Trader").nextElementSibling?.textContent).toBe(
      aed("300.00"),
    );
    expect(dialog.getByText("Net Expected from Driver").nextElementSibling?.textContent).toBe(
      aed("350.00"),
    );
  });

  it("shows a negative Difference before Actual Amount Received is entered, and blocks confirmation", async () => {
    setup([deliveredOrder], () =>
      Promise.resolve({
        companyFees: "25.00",
        difference: "-200.00",
        driverId: driver.id,
        expenseTotal: "0.00",
        grossCollections: "200.00",
        netAmountExpected: "200.00",
        orderCount: 1,
        paymentTotal: "0.00",
        traderCount: 1,
        traderPayable: "175.00",
        warnings: [],
      }),
    );
    const dialog = await openDialogWithAllOrders([deliveredOrder]);

    // Actual Amount Received is never pre-filled from Net Expected (§ formula fix).
    const actualReceived = dialog.getByLabelText("Actual Amount Received") as HTMLInputElement;
    expect(actualReceived.value).toBe("");
    expect(dialog.getByText("Difference").nextElementSibling?.textContent).toBe(aed("-200.00"));
    expect(dialog.getByRole("button", { name: "Collect money from driver" })).toBeDisabled();
  });

  it("shows a zero Difference and enables confirmation once the exact amount is entered", async () => {
    setup([deliveredOrder], () =>
      Promise.resolve({
        companyFees: "25.00",
        difference: "-200.00",
        driverId: driver.id,
        expenseTotal: "0.00",
        grossCollections: "200.00",
        netAmountExpected: "200.00",
        orderCount: 1,
        paymentTotal: "0.00",
        traderCount: 1,
        traderPayable: "175.00",
        warnings: [],
      }),
    );
    const dialog = await openDialogWithAllOrders([deliveredOrder]);

    fireEvent.change(dialog.getByLabelText("Actual Amount Received"), {
      target: { value: "200" },
    });
    await waitFor(() =>
      expect(dialog.getByText("Difference").nextElementSibling?.textContent).toBe(aed("0.00")),
    );
    expect(dialog.getByRole("button", { name: "Collect money from driver" })).toBeEnabled();
  });

  it("blocks confirmation when Actual Amount Received leaves a non-zero Difference", async () => {
    setup([deliveredOrder], () =>
      Promise.resolve({
        companyFees: "25.00",
        difference: "-200.00",
        driverId: driver.id,
        expenseTotal: "0.00",
        grossCollections: "200.00",
        netAmountExpected: "200.00",
        orderCount: 1,
        paymentTotal: "0.00",
        traderCount: 1,
        traderPayable: "175.00",
        warnings: [],
      }),
    );
    const dialog = await openDialogWithAllOrders([deliveredOrder]);

    fireEvent.change(dialog.getByLabelText("Actual Amount Received"), {
      target: { value: "50" },
    });
    await waitFor(() =>
      expect(dialog.getByText("Difference").nextElementSibling?.textContent).toBe(aed("-150.00")),
    );
    expect(dialog.getByRole("button", { name: "Collect money from driver" })).toBeDisabled();
  });

  it("reduces Net Expected by Driver Expenses only — Company Fees and Trader payable are unaffected", async () => {
    const { api } = setup([deliveredOrder], (body: { expenses?: readonly unknown[] }) =>
      Promise.resolve(
        (body.expenses?.length ?? 0) > 0
          ? {
              // A 20.00 Driver Expense reduces Net Expected from 200 to 180; Company Fees
              // and Amount Due to Trader are computed straight from the Orders and never
              // move because of expenses (§ formula fix).
              companyFees: "25.00",
              difference: "-180.00",
              driverId: driver.id,
              expenseTotal: "20.00",
              grossCollections: "200.00",
              netAmountExpected: "180.00",
              orderCount: 1,
              paymentTotal: "0.00",
              traderCount: 1,
              traderPayable: "175.00",
              warnings: [],
            }
          : {
              companyFees: "25.00",
              difference: "-200.00",
              driverId: driver.id,
              expenseTotal: "0.00",
              grossCollections: "200.00",
              netAmountExpected: "200.00",
              orderCount: 1,
              paymentTotal: "0.00",
              traderCount: 1,
              traderPayable: "175.00",
              warnings: [],
            },
      ),
    );
    const dialog = await openDialogWithAllOrders([deliveredOrder]);
    void api;

    fireEvent.click(dialog.getByRole("button", { name: "Add expense" }));
    const comboboxes = dialog.getAllByRole("combobox");
    const typeSelect = comboboxes[comboboxes.length - 1];
    if (typeSelect === undefined) throw new Error("Expected an expense type <select>");
    fireEvent.change(typeSelect, { target: { value: "expense-fuel" } });
    const amountInput = dialog.getByPlaceholderText("0.00");
    fireEvent.change(amountInput, { target: { value: "20" } });
    const reasonInput = dialog.getByPlaceholderText(/reason/i);
    fireEvent.change(reasonInput, { target: { value: "Fuel" } });

    await waitFor(() =>
      expect(dialog.getByText("Net Expected from Driver").nextElementSibling?.textContent).toBe(
        aed("180.00"),
      ),
    );
    // Company Fees and Amount Due to Trader never move because of Driver Expenses.
    expect(dialog.getByText("Company fees").nextElementSibling?.textContent).toBe(aed("25.00"));
    expect(dialog.getByText("Amount due to Trader").nextElementSibling?.textContent).toBe(
      aed("175.00"),
    );
  });
});
