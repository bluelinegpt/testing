import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    render(
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
    render(
      <OrdersModuleWorkspace
        api={api as unknown as ApiClient}
        onNavigate={vi.fn()}
        permissions={["users_roles.manage"]}
      />,
    );

    await screen.findByText("SER-000001");
    // Operators see one unified Status rather than competing Stage and Delivery columns.
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeVisible();
    expect(screen.queryByRole("columnheader", { name: "Stage" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Delivery status" })).not.toBeInTheDocument();
    expect(screen.getAllByText("New").length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole("button", { name: "Order actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Mark item in branch" }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        `operations/orders/${order.id}/status`,
        expect.objectContaining({ status: "in_branch" }),
      ),
    );
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
    render(
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

    fireEvent.click(
      screen.getByRole("button", { name: /Hold.*1 visible Orders.*1 selected/ }),
    );
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
    render(
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
});
