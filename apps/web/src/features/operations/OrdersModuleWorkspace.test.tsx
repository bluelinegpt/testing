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
import { OrdersModuleWorkspace } from "./OrdersModuleWorkspace.js";

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
            matchingCount: 40,
            page: 1,
            pageSize: 25,
            totalCount: 40,
            tabTotalCount: 40,
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
    expect(screen.getByText("40 Active Orders")).toBeInTheDocument();

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

  it("shows matching and tab-scoped totals when a narrowing filter is applied", async () => {
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/orders?")) {
          const filtered = path.includes("search=Aisha");
          return Promise.resolve({
            filteredCount: filtered ? 6 : 10,
            items: [order],
            matchingCount: filtered ? 6 : 10,
            page: 1,
            pageSize: 25,
            totalCount: 10,
            tabTotalCount: 10,
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

    expect(await screen.findByText("10 Active Orders")).toBeInTheDocument();
    const search = screen.getByRole("textbox", { name: "Search orders" });
    fireEvent.change(search, { target: { value: "Aisha" } });
    fireEvent.keyDown(search, { key: "Enter" });

    expect(await screen.findByText("6 matching of 10 Active Orders")).toBeInTheDocument();
  });

  it("uses the matching total, not the tab total, to enable server pagination", async () => {
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/orders?")) {
          const secondPage = path.includes("page=2");
          return Promise.resolve({
            filteredCount: 30,
            items: [order],
            matchingCount: 30,
            page: secondPage ? 2 : 1,
            pageSize: 25,
            totalCount: 100,
            tabTotalCount: 100,
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

    await screen.findByText("100 Active Orders");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(expect.stringContaining("page=2")),
    );
  });

  it("enables Close order and hides Trader settlements for a delivered Free Order", async () => {
    const freeOrder = {
      ...order,
      accountingRequired: false,
      accountingState: "accounting_event_missing",
      assignedDriverId: "20000000-0000-4000-8000-000000000001",
      assignedDriverMobile: "971501234568",
      assignedDriverName: "Ahmed",
      codAmount: "0.00",
      customerAmountDue: "0.00",
      deliveryStatus: "delivered",
      driverReconciliationStatus: "not_applicable",
      id: "10000000-0000-4000-8000-000000000007",
      orderNumber: "ORD-000007",
      serialNumber: "7",
      serviceFee: "0.00",
      totalDeductions: "0.00",
      traderNetPayable: "0.00",
      traderSettlementStatus: "unsettled",
      workflowGuidance: {
        completionBlockerCode: null,
        isFinanciallyComplete: true,
        nextActionCode: "close_order",
        nextActionParams: {
          openDialog: "change_status",
          orderId: "10000000-0000-4000-8000-000000000007",
          orderNumber: "ORD-000007",
          returnTo: "/orders",
          suggestedStatus: "closed",
        },
        nextActionRoute: "/orders",
        waitingFor: "no_accounting_required",
        workflowState: "no_accounting_required",
      },
    };
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/orders?")) {
          return Promise.resolve({
            filteredCount: 1,
            items: [freeOrder],
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

    await screen.findByText("7");
    fireEvent.click(screen.getByRole("button", { name: "Order actions" }));

    expect(screen.queryByRole("button", { name: "Trader settlements" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close order" })).toBeEnabled();
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

  it("previews bulk driver assignment with a clean selected-order payload", async () => {
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
        if (path.startsWith("operations/drivers")) {
          return Promise.resolve([
            {
              activeOrders: 0,
              code: "DRV-000006",
              deliveredOrders: 0,
              id: "20000000-0000-4000-8000-000000000006",
              mobileNumber: "971501234569",
              name: "Kareem",
              pendingCashOrders: 0,
              status: "active",
              type: "employee",
            },
          ]);
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
        if (path === "operations/orders/bulk-assign/preview") {
          return Promise.resolve({
            eligibleCount: 1,
            ineligible: [],
            selectedAmountToCollect: "110.00",
            selectedCount: 1,
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
    fireEvent.click(screen.getByRole("button", { name: "Assign driver" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Assign driver" }));
    fireEvent.change(dialog.getByLabelText("Driver"), {
      target: { value: "20000000-0000-4000-8000-000000000006" },
    });

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("operations/orders/bulk-assign/preview", {
        driverIdToAssign: "20000000-0000-4000-8000-000000000006",
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
    fireEvent.click(screen.getByRole("button", { name: "Grouping" }));
    fireEvent.click(screen.getByLabelText("Status"));

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

    expect(screen.getByText("SER-000002")).toBeVisible();
    expect(holdGroupSelection).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: /Grouping/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Driver" }));
    expect(screen.getByLabelText("Select visible Orders in Ahmed")).toBeVisible();
    expect(screen.getByLabelText("Select visible Orders in Unassigned")).toBeVisible();
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

  it("reactivates three selected Hold Orders in one editable table", async () => {
    const heldOrders = [heldOrder, {
      ...heldOrder, id: "10000000-0000-4000-8000-000000000003", orderNumber: "ORD-000003", serialNumber: "SER-000003",
    }, {
      ...heldOrder, id: "10000000-0000-4000-8000-000000000004", orderNumber: "ORD-000004", serialNumber: "SER-000004",
    }];
    const api = {
      get: vi.fn((path: string) => {
        if (path === "operations/orders/next-serial-number") return Promise.resolve({ serialNumber: "500" });
        if (path.startsWith("operations/orders?")) return Promise.resolve({
          filteredCount: 3, items: heldOrders, matchingCount: 3, page: 1, pageSize: 25, totalCount: 3, tabTotalCount: 3,
        });
        if (path.startsWith("configuration/areas")) return Promise.resolve({ items: [], page: 1, pageSize: 100, total: 0 });
        return Promise.resolve([]);
      }),
      post: vi.fn().mockResolvedValue({ processedCount: 3 }),
    };
    renderWithRouter(
      <OrdersModuleWorkspace api={api as unknown as ApiClient} onNavigate={vi.fn()} permissions={["users_roles.manage"]} />,
      ["/orders?quickView=hold"],
    );
    await screen.findByText("SER-000004");
    fireEvent.click(screen.getByLabelText("Select all Orders on this page"));
    fireEvent.click(screen.getByRole("button", { name: "Reactivate Hold Orders" }));
    const dialog = screen.getByRole("dialog", { name: "Reactivate Hold Orders" });
    expect(within(dialog).getByText("ORD-000002")).toBeVisible();
    expect(within(dialog).getByText("ORD-000003")).toBeVisible();
    expect(within(dialog).getByText("ORD-000004")).toBeVisible();
    await waitFor(() => expect(within(dialog).getAllByRole("textbox").map(input => (input as HTMLInputElement).value)).toEqual(["500", "501", "502"]));
    fireEvent.change(within(dialog).getAllByRole("textbox")[0]!, { target: { value: "  New   500  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(within(dialog).getByText("Selected Orders: 3")).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm & Update" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("operations/orders/hold-reactivation", {
      orders: expect.arrayContaining([
        expect.objectContaining({ newSerialNumber: "  New   500  ", orderId: heldOrder.id }),
        expect.objectContaining({ newSerialNumber: "501" }),
        expect.objectContaining({ newSerialNumber: "502" }),
      ]),
    }));
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

/**
 * Consolidated "Collect from Driver" -- there is exactly ONE Driver
 * Collection workflow (the Driver Collections screen's own New Collection),
 * and every entry point on the Orders list now navigates into it instead of
 * opening a second, duplicate summary dialog. Orders never decides
 * eligibility itself: it only carries the Driver/Order ids it already knows
 * as context, and the destination screen re-validates against the live
 * backend (§4 in the consolidation report).
 */
/**
 * A Driver User holding only `orders.driver_self_service` (Driver Order
 * Status Permission fix) -- sees exactly the narrow Driver transition set on
 * their own row, never Assign Driver, Cancel, or any office/financial
 * action, matching `OperationsService.changeOrderStatus`'s own
 * `driverTransitions` map exactly.
 */
describe("Driver self-service row actions", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("shows the allowed status action for Assigned to Driver, and hides Assign Driver / Cancel", async () => {
    const assignedOrder = {
      ...order,
      assignedDriverId: "20000000-0000-4000-8000-000000000001",
      assignedDriverMobile: "971501234568",
      assignedDriverName: "D123",
      deliveryStatus: "assigned_to_driver",
    };
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/orders?")) {
          return Promise.resolve({
            filteredCount: 1,
            items: [assignedOrder],
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
        permissions={["orders.driver_self_service"]}
      />,
    );

    await screen.findByText("SER-000001");
    fireEvent.click(screen.getByRole("button", { name: "Order actions" }));
    expect(screen.getByRole("button", { name: "Send out for delivery" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Assign driver" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel order" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move to Hold" })).not.toBeInTheDocument();
  });

  it("shows Hold, Deliver and Return to branch for Out for Delivery, and hides every office/financial action", async () => {
    const outForDeliveryOrder = {
      ...order,
      assignedDriverId: "20000000-0000-4000-8000-000000000001",
      assignedDriverMobile: "971501234568",
      assignedDriverName: "D123",
      deliveryStatus: "out_for_delivery",
    };
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/orders?")) {
          return Promise.resolve({
            filteredCount: 1,
            items: [outForDeliveryOrder],
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
        permissions={["orders.driver_self_service"]}
      />,
    );

    await screen.findByText("SER-000001");
    fireEvent.click(screen.getByRole("button", { name: "Order actions" }));
    expect(screen.getByRole("button", { name: "Mark delivered" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Move to Hold" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Return to branch" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Assign driver" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel order" })).not.toBeInTheDocument();
  });

  it("does not offer any status action for an unassigned New Order (no office permission)", async () => {
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
      post: vi.fn().mockResolvedValue({}),
    };
    renderWithRouter(
      <OrdersModuleWorkspace
        api={api as unknown as ApiClient}
        onNavigate={vi.fn()}
        permissions={["orders.driver_self_service"]}
      />,
    );

    await screen.findByText("SER-000001");
    fireEvent.click(screen.getByRole("button", { name: "Order actions" }));
    expect(screen.queryByRole("button", { name: "Mark item in branch" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Assign driver" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel order" })).not.toBeInTheDocument();
  });
});

describe("Collect from Driver — consolidated into one workflow", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  const collectableOrder = {
    ...order,
    assignedDriverId: "20000000-0000-4000-8000-000000000006",
    assignedDriverMobile: "971501234569",
    assignedDriverName: "Kareem",
    deliveryStatus: "delivered",
    driverReconciliationStatus: "pending",
    id: "10000000-0000-4000-8000-000000000010",
    orderNumber: "ORD-000010",
    serialNumber: "SER-000010",
  };
  const secondCollectableOrder = {
    ...collectableOrder,
    id: "10000000-0000-4000-8000-000000000011",
    orderNumber: "ORD-000011",
    serialNumber: "SER-000011",
  };

  function setup(orders: readonly (typeof collectableOrder)[]) {
    const onNavigate = vi.fn();
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
        onNavigate={onNavigate}
        permissions={["users_roles.manage"]}
      />,
    );
    return { api, onNavigate };
  }

  it("bulk 'Collect money from driver' navigates straight to New Collection with the Driver and selected Orders, opening no dialog here", async () => {
    const { onNavigate } = setup([collectableOrder, secondCollectableOrder]);

    fireEvent.click(await screen.findByLabelText("Select Order SER-000010"));
    fireEvent.click(screen.getByLabelText("Select Order SER-000011"));
    fireEvent.click(screen.getByRole("button", { name: "Collect money from driver" }));

    expect(onNavigate).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/drivers\?openDialog=collect_money&returnTo=%2Forders&driverId=20000000-0000-4000-8000-000000000006&orderIds=10000000-0000-4000-8000-000000000010%2C10000000-0000-4000-8000-000000000011$/,
      ),
    );
    // Nothing opened here -- the old duplicate summary dialog is gone.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the per-row 'Collect from Driver' action navigates with just that one Order, opening no dialog here", async () => {
    const { onNavigate } = setup([collectableOrder]);

    await screen.findByText("SER-000010");
    fireEvent.click(screen.getByRole("button", { name: "Order actions" }));
    expect(screen.queryByRole("button", { name: "Close order" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Collect money from driver" }));

    expect(onNavigate).toHaveBeenCalledWith(
      "/drivers?openDialog=collect_money&returnTo=%2Forders&driverId=20000000-0000-4000-8000-000000000006&orderIds=10000000-0000-4000-8000-000000000010",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("never renders the old duplicate Collect Money summary dialog from any entry point", async () => {
    setup([collectableOrder]);
    await screen.findByText("SER-000010");
    fireEvent.click(screen.getByLabelText("Select Order SER-000010"));

    // Neither entry point's fields (Traders Represented, Net Expected, ...)
    // exist anywhere in this screen any more.
    expect(screen.queryByText("Traders Represented")).not.toBeInTheDocument();
    expect(screen.queryByText("Net Expected")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Actual Amount Received")).not.toBeInTheDocument();
  });
});
