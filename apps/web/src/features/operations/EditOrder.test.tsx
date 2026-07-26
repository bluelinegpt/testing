import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import type { OperationsOrderDetail } from "../../api/contracts.js";
import { i18nInstance } from "../../localization/i18n.js";
import { OrderDetailsWorkspace } from "./OrdersModuleWorkspace.js";

const detail: OperationsOrderDetail = {
  amountCollected: "0.00",
  areaName: "Dubai - Deira",
  assignedDriverId: null,
  assignedDriverMobile: null,
  assignedDriverName: null,
  attachments: [],
  codAmount: "100.00",
  companyRevenue: "10.00",
  customerAddress: "Deira, Dubai",
  customerAmountDue: "110.00",
  customerMobileNumber: "971501234567",
  customerName: "Aisha",
  deliveryStatus: "in_branch",
  driverReconciliationStatus: "not_applicable",
  events: [],
  history: [],
  id: "10000000-0000-4000-8000-000000000001",
  internationalShipment: null,
  metadata: {
    closedAt: null,
    createdAt: "2026-07-20T09:00:00.000Z",
    createdBy: "sara.ops",
    customerSecondMobileNumber: null,
    driverCost: "5.00",
    notes: null,
    operationalCompletedAt: null,
    orderExpensesTotal: "0.00",
    packageCount: 1,
    paymentCondition: "customer_pays_cod_and_fee",
    returnDriverFee: "0.00",
    traderNetPayable: "100.00",
  },
  orderDate: "2026-07-20",
  orderNumber: "ORD-000001",
  orderProfit: "10.00",
  returnStatus: "not_applicable",
  serviceFee: "10.00",
  totalDeductions: "10.00",
  traderNetPayable: "90.00",
  traderName: "Test Trader",
  traderSettlementStatus: "not_eligible",
  vatAmount: "0.00",
};

describe("Edit order", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("edits a pre-delivery order and PATCHes the changed fields", async () => {
    const api = {
      get: vi.fn().mockResolvedValue(detail),
      patch: vi.fn().mockResolvedValue({}),
    };
    render(
      <OrderDetailsWorkspace
        api={api as unknown as ApiClient}
        onBack={vi.fn()}
        orderNumber="ORD-000001"
      />,
    );

    // An in-branch order is editable, so the header offers Edit order.
    const editButton = await screen.findByRole("button", { name: "Edit order" });
    fireEvent.click(editButton);

    // The dialog prefills from the order detail.
    const nameInput = await screen.findByDisplayValue("Aisha");
    fireEvent.change(nameInput, { target: { value: "Aisha Khan" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith(
        `operations/orders/${detail.id}`,
        expect.objectContaining({ customerName: "Aisha Khan" }),
      ),
    );
  });

  it("hides Edit order once the order is delivered", async () => {
    const delivered = { ...detail, deliveryStatus: "delivered" };
    const api = { get: vi.fn().mockResolvedValue(delivered), patch: vi.fn() };
    render(
      <OrderDetailsWorkspace
        api={api as unknown as ApiClient}
        onBack={vi.fn()}
        orderNumber="ORD-000001"
      />,
    );
    await screen.findByText("ORD-000001");
    expect(screen.queryByRole("button", { name: "Edit order" })).not.toBeInTheDocument();
  });
});
