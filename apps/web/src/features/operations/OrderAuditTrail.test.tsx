import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import type { OperationsOrderDetail } from "../../api/contracts.js";
import { i18nInstance } from "../../localization/i18n.js";
import { OrderDetailsWorkspace } from "./OrdersModuleWorkspace.js";

const detail: OperationsOrderDetail = {
  amountCollected: "0.00",
  areaName: "Dubai - Deira",
  assignedDriverId: "20000000-0000-4000-8000-000000000010",
  assignedDriverMobile: "971500000000",
  assignedDriverName: "Ahmed Ali",
  attachments: [],
  codAmount: "100.00",
  companyRevenue: "10.00",
  customerAddress: "Deira, Dubai",
  customerAmountDue: "110.00",
  customerMobileNumber: "971501234567",
  customerName: "Aisha",
  deliveryStatus: "in_branch",
  driverReconciliationStatus: "not_applicable",
  events: [
    {
      actor: "sara.ops",
      actorRole: "Operations",
      category: "status_change",
      correlationId: "corr-1",
      eventType: "order.in_branch",
      fieldName: "delivery_status",
      id: "e1",
      newValue: "in_branch",
      occurredAt: "2026-07-20T09:30:00.000Z",
      previousValue: "new",
      reason: null,
      source: "web_portal",
    },
    {
      actor: "sara.ops",
      actorRole: "Operations",
      category: "driver_assignment",
      correlationId: "corr-2",
      eventType: "order.driver_assigned",
      fieldName: "assigned_driver_id",
      id: "e2",
      newValue: { driverId: "d1", driverName: "Ahmed Ali" },
      occurredAt: "2026-07-20T09:40:00.000Z",
      previousValue: null,
      reason: null,
      source: "web_portal",
    },
  ],
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
  outsourcedDriverFeeAmount: "0.00",
  outsourcedDriverFeeOutstanding: "0.00",
  outsourcedDriverFeePaid: "0.00",
  outsourcedDriverFeePaymentNumbers: "",
  outsourcedDriverFeeStatus: "not_applicable",
  returnStatus: "not_applicable",
  serviceFee: "10.00",
  totalDeductions: "10.00",
  traderNetPayable: "90.00",
  traderName: "Test Trader",
  traderSettlementStatus: "not_eligible",
  vatAmount: "0.00",
};

describe("OrderDetailsWorkspace audit trail", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("shows who changed what, with readable old and new values", async () => {
    const api = { get: vi.fn().mockResolvedValue(detail) };
    render(
      <OrderDetailsWorkspace
        api={api as unknown as ApiClient}
        companyId="00000000-0000-4000-8000-000000000001"
        onBack={vi.fn()}
        orderNumber="ORD-000001"
      />,
    );

    // The current Order status is prominent while history retains each underlying change.
    await screen.findByText("ORD-000001");
    expect(screen.getByText("Current Order Status")).toBeVisible();
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getAllByText("Item in branch").length).toBeGreaterThanOrEqual(1);
    // The raw event code is not shown to the user.
    expect(screen.queryByText("order.in_branch")).not.toBeInTheDocument();

    // Driver assignment shows the driver name for the new value and the acting username.
    expect(screen.getAllByText("Assigned driver").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Ahmed Ali").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/sara\.ops/).length).toBeGreaterThanOrEqual(1);
  });
});
