import { render, screen, within } from "@testing-library/react";

import type { OperationsDriverReconciliationDetail } from "../../api/contracts.js";
import { i18nInstance } from "../../localization/i18n.js";

import { ReconciliationPrintDocument } from "./ReconciliationPrintReport.js";

const detail: OperationsDriverReconciliationDetail = {
  audit: [
    {
      action: "driver_reconciliation.confirm",
      actor: "aisha.admin",
      occurredAt: "2026-07-19 14:54",
    },
  ],
  expenses: [
    {
      amount: "10.50",
      description: null,
      expenseType: "Petrol",
      id: "e1",
      recordedAt: "2026-07-19",
      recordedBy: "aisha.admin",
      reference: null,
    },
    {
      amount: "4.25",
      description: "Ferry toll receipt 4471",
      expenseType: "Other",
      id: "e2",
      recordedAt: "2026-07-19",
      recordedBy: "aisha.admin",
      reference: null,
    },
  ],
  orders: [
    {
      amountCollected: "47.50",
      cashStatus: "reconciled",
      cashStatusLabel: "Money Received from Driver",
      customerName: "DEV-DEMO Customer",
      driverPayableDeduction: "0.00",
      id: "o1",
      orderNumber: "ORD-000031",
    },
    {
      amountCollected: "54.75",
      cashStatus: "reconciled",
      cashStatusLabel: "Money Received from Driver",
      customerName: "DEV-DEMO Customer",
      driverPayableDeduction: "0.00",
      id: "o2",
      orderNumber: "ORD-000032",
    },
  ],
  overview: {
    businessDate: "2026-07-19",
    confirmedAt: "2026-07-19 14:54",
    confirmedBy: "aisha.admin",
    driverName: "DEV-DEMO Driver",
    driverType: "outsourced",
    expenseTotal: "14.75",
    grossCollections: "102.25",
    id: "r1",
    netAmountReceived: "87.50",
    orderCount: 2,
    paymentTotal: "87.50",
    reconciliationNumber: "REC-000001",
    status: "confirmed",
    statusLabel: "Confirmed",
  },
  payments: [
    {
      amount: "50.00",
      bankAccountName: null,
      bankName: null,
      bankReference: null,
      id: "p1",
      paymentAt: "2026-07-19",
      paymentMethod: "cash",
      paymentMethodLabel: "Cash",
      recordedBy: "aisha.admin",
    },
    {
      amount: "37.50",
      bankAccountName: "DEV-DEMO Collections Account",
      bankName: "DEV-DEMO Bank",
      bankReference: "DEV-DEMO-TRF-0001",
      id: "p2",
      paymentAt: "2026-07-19",
      paymentMethod: "bank_transfer",
      paymentMethodLabel: "Bank Transfer",
      recordedBy: "aisha.admin",
    },
  ],
};

const value = (container: HTMLElement, name: string) =>
  container.querySelector(`[data-print="${name}"]`)?.textContent?.trim();

describe("ReconciliationPrintDocument", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("renders every field the printed report must contain", () => {
    const { container } = render(
      <ReconciliationPrintDocument companyName="Blueline Demo Company" detail={detail} />,
    );

    // Company identity and document header.
    expect(value(container, "company")).toBe("Blueline Demo Company");
    expect(value(container, "reference")).toBe("REC-000001");
    expect(value(container, "status")).toBe("Confirmed");
    expect(value(container, "business-date")).toBe("2026-07-19");
    expect(value(container, "confirmed-by")).toContain("aisha.admin");
    expect(value(container, "driver")).toBe("DEV-DEMO Driver (outsourced)");

    // Financial summary, including the deduction fixed at zero.
    expect(value(container, "collections")).toBe("102.25");
    expect(value(container, "deduction")).toBe("0.00");
    expect(value(container, "expenses")).toBe("14.75");
    expect(value(container, "net")).toBe("87.50");
    expect(value(container, "paid")).toBe("87.50");
    expect(value(container, "difference")).toBe("0.00");
  });

  it("renders Orders, payments, expenses and audit as tables with headers", () => {
    const { container } = render(
      <ReconciliationPrintDocument companyName="Blueline Demo Company" detail={detail} />,
    );

    const orders = container.querySelector('[data-print="orders"]') as HTMLElement;
    expect(within(orders).getByText("ORD-000031")).toBeInTheDocument();
    expect(within(orders).getByText("ORD-000032")).toBeInTheDocument();
    // Repeating headers rely on a real thead.
    expect(orders.querySelector("thead")).not.toBeNull();

    const payments = container.querySelector('[data-print="payments"]') as HTMLElement;
    expect(within(payments).getByText("Cash")).toBeInTheDocument();
    expect(within(payments).getByText("Bank Transfer")).toBeInTheDocument();
    // Bank reference is preserved verbatim.
    expect(within(payments).getByText("DEV-DEMO-TRF-0001")).toBeInTheDocument();
    expect(
      within(payments).getByText("DEV-DEMO Bank — DEV-DEMO Collections Account"),
    ).toBeInTheDocument();

    const expenses = container.querySelector('[data-print="expense-lines"]') as HTMLElement;
    expect(within(expenses).getByText("Petrol")).toBeInTheDocument();
    expect(within(expenses).getByText("Ferry toll receipt 4471")).toBeInTheDocument();

    const audit = container.querySelector('[data-print="audit"]') as HTMLElement;
    expect(within(audit).getByText("driver_reconciliation.confirm")).toBeInTheDocument();
  });

  it("keeps the totals block marked so it cannot split across pages", () => {
    const { container } = render(
      <ReconciliationPrintDocument companyName="Blueline Demo Company" detail={detail} />,
    );
    expect(container.querySelector(".print-totals")).not.toBeNull();
    expect(container.querySelector(".print-total-row")).not.toBeNull();
    expect(container.querySelector(".print-document")).not.toBeNull();
  });

  it("translates labels into Arabic but never the technical identifiers", async () => {
    await i18nInstance.changeLanguage("ar");
    const { container } = render(
      <ReconciliationPrintDocument companyName="Blueline Demo Company" detail={detail} />,
    );
    // Heading is translated.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("تقرير مطابقة نقدية المندوب");
    // References, Order numbers and bank references are untouched.
    expect(value(container, "reference")).toBe("REC-000001");
    expect(container.textContent).toContain("ORD-000031");
    expect(container.textContent).toContain("DEV-DEMO-TRF-0001");
    await i18nInstance.changeLanguage("en");
  });
});
