import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import {
  DailyOperationsSummaryReport,
  expenseSourcePath,
  formatOrderIdentifier,
  normalizeReportDateInput,
  orderDetailPath,
} from "./DailyOperationsSummaryReport.js";

/**
 * Daily Operations Summary — Date Mode selector, quick filters and
 * drill-down link-building, stubbed at the API boundary.
 *
 * The claims under test: the Date Mode selector defaults to Business Day
 * and travels with every request this screen makes (the report run, the
 * quick-filter anchor, and the drill-down); Today/Yesterday resolve against
 * the date the server returns for the ACTIVE mode, never the browser's own
 * clock; an expense Reference Number routes to the exact source record by
 * TYPE and ID, not by guessing from its display text; and an Order
 * drill-down row opens the existing Order detail screen by Order Number.
 */

const businessReport = {
  dateMode: "business_day" as const,
  driverSummary: [
    {
      deliveredOrders: 2,
      deliveryIncome: "33.00",
      driverCode: "DRV-001",
      driverId: "driver-1",
      driverName: "D123",
      driverType: "outsourced" as const,
    },
  ],
  expenses: [
    {
      amount: "150.00",
      businessDate: "2026-08-10",
      calendarDate: "2026-08-11",
      description: "Petrol / Fuel",
      payee: "ADNOC",
      reference: "EXP-000003",
      sourceId: "expense-1",
      type: "general_expense",
    },
  ],
  netResult: "-116.99",
  netStatus: "negative" as const,
  totalDeliveryIncome: "33.00",
  totalExpenses: "150.00",
  totalOrders: 2,
  totalTraderPayments: "275.00",
  traderPayments: [
    {
      amount: "275.00",
      businessDate: "2026-08-10",
      calendarDate: "2026-08-11",
      customerName: "Acme Corp",
      orderNumber: "ORD-000050",
      orderSerialNumber: null,
      originalAmountDue: "300.00",
      paymentMethod: "cash" as const,
      previouslyPaid: "25.00",
      reference: "SET-000001",
      referenceNumber: "SET-000001",
      settlementId: "settlement-1",
      settlementNumber: "SET-000001",
      traderName: "Acme Trading",
    },
  ],
};

const calendarReport = { ...businessReport, dateMode: "calendar_day" as const };

const driverOrders = [
  {
    customerName: "Fatima",
    deliveredAt: "2026-08-11T00:09:00.000Z",
    deliveryBusinessDate: "2026-08-10",
    deliveryCalendarDate: "2026-08-11",
    deliveryIncome: "33.00",
    driverName: "D123",
    id: "order-1",
    orderDate: "2026-08-10",
    orderNumber: "ORD-000042",
    referenceNumber: "REF-42",
    serialNumber: null,
    traderName: "Acme Trading",
  },
  {
    customerName: "Sami",
    deliveredAt: "2026-08-11T02:00:00.000Z",
    deliveryBusinessDate: "2026-08-10",
    deliveryCalendarDate: "2026-08-11",
    deliveryIncome: "0.00",
    driverName: "D123",
    id: "order-2",
    orderDate: "2026-08-10",
    orderNumber: "ORD-000043",
    referenceNumber: null,
    serialNumber: "3",
    traderName: "Acme Trading",
  },
];

function setup(todayByMode: Record<string, string> = { business_day: "2026-08-10", calendar_day: "2026-08-11" }) {
  const getCalls: string[] = [];
  const api = {
    get: vi.fn((path: string) => {
      getCalls.push(path);
      if (path.includes("/today")) {
        const mode = path.includes("dateMode=calendar_day") ? "calendar_day" : "business_day";
        return Promise.resolve({ date: todayByMode[mode] });
      }
      if (path.includes("/orders?")) return Promise.resolve(driverOrders);
      const report = path.includes("dateMode=calendar_day") ? calendarReport : businessReport;
      return Promise.resolve(report);
    }),
    getBinary: vi.fn(),
  };
  const navigations: string[] = [];
  render(
    <DailyOperationsSummaryReport
      api={api as unknown as ApiClient}
      onNavigate={(path) => navigations.push(path)}
    />,
  );
  return { api, getCalls, navigations };
}

describe("DailyOperationsSummaryReport", () => {
  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
  });

  it("normalizes localized slash dates before sending report queries", () => {
    expect(normalizeReportDateInput("08/11/2026")).toBe("2026-08-11");
    expect(normalizeReportDateInput("2026-08-11")).toBe("2026-08-11");
  });

  it("defaults to Business Day mode", async () => {
    setup();
    await waitFor(() => expect(screen.getByRole("button", { name: "Today" })).toBeEnabled());
    expect(screen.getByLabelText("Date Mode")).toHaveValue("business_day");
  });

  it("resolves Today/Yesterday against the server-resolved date for the active mode, not the browser clock", async () => {
    setup();
    // Disabled until the server-resolved date arrives.
    expect(screen.getByRole("button", { name: "Today" })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Today" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Yesterday" }));
    expect(screen.getByLabelText("Date From")).toHaveValue("2026-08-09");
    expect(screen.getByLabelText("Date To")).toHaveValue("2026-08-09");

    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByLabelText("Date From")).toHaveValue("2026-08-10");
    expect(screen.getByLabelText("Date To")).toHaveValue("2026-08-10");
  });

  it("re-resolves Today against the Calendar Day date when the mode is switched", async () => {
    setup();
    await waitFor(() => expect(screen.getByRole("button", { name: "Today" })).toBeEnabled());

    fireEvent.change(screen.getByLabelText("Date Mode"), { target: { value: "calendar_day" } });
    // Disabled again while the new mode's "today" resolves.
    expect(screen.getByRole("button", { name: "Today" })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Today" })).toBeEnabled());

    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByLabelText("Date From")).toHaveValue("2026-08-11");
  });

  it("This Week and This Month also anchor off the resolved date", async () => {
    setup(); // 2026-08-10 is a Monday
    await waitFor(() => expect(screen.getByRole("button", { name: "This Week" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "This Week" }));
    // Sunday-start week containing 10 Aug 2026 (a Monday) starts 09 Aug 2026.
    expect(screen.getByLabelText("Date From")).toHaveValue("2026-08-09");
    expect(screen.getByLabelText("Date To")).toHaveValue("2026-08-10");

    fireEvent.click(screen.getByRole("button", { name: "This Month" }));
    expect(screen.getByLabelText("Date From")).toHaveValue("2026-08-01");
  });

  it("sends the active Date Mode with the report request and shows it in the header", async () => {
    const { getCalls } = setup();
    await waitFor(() => expect(screen.getByRole("button", { name: "Today" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run Report" }));
    await screen.findByText("Petrol / Fuel");
    expect(getCalls.some((path) => path.includes("dateMode=business_day"))).toBe(true);
    expect(screen.getByText(/Business Day/, { selector: ".page-header-subtitle" })).toBeInTheDocument();
  });

  it("switching to Calendar Day and running sends calendar_day and updates the header", async () => {
    const { getCalls } = setup();
    await waitFor(() => expect(screen.getByRole("button", { name: "Today" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Date Mode"), { target: { value: "calendar_day" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Today" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run Report" }));
    await screen.findByText("Petrol / Fuel");
    expect(getCalls.some((path) => path.includes("dateMode=calendar_day"))).toBe(true);
    expect(screen.getByText(/Calendar Day/, { selector: ".page-header-subtitle" })).toBeInTheDocument();
  });

  it("clears a displayed report when Date Mode is switched, so a stale report is never shown under the wrong caption", async () => {
    setup();
    await waitFor(() => expect(screen.getByRole("button", { name: "Today" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run Report" }));
    await screen.findByText("Petrol / Fuel");

    fireEvent.change(screen.getByLabelText("Date Mode"), { target: { value: "calendar_day" } });
    expect(screen.queryByText("Petrol / Fuel")).toBeNull();
  });

  it("routes an expense Reference Number to its exact source record by type and id", async () => {
    const { navigations } = setup();
    await waitFor(() => expect(screen.getByRole("button", { name: "Today" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run Report" }));

    const reference = await screen.findByRole("button", { name: "EXP-000003" });
    fireEvent.click(reference);
    expect(navigations).toContain("/accounting/general-expenses/expense-1");
  });

  it("always shows Business Date and Calendar Date for an expense, regardless of active mode", async () => {
    setup();
    await waitFor(() => expect(screen.getByRole("button", { name: "Today" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run Report" }));
    await screen.findByText("Petrol / Fuel");
    expect(screen.getByText("2026-08-10")).toBeInTheDocument();
    expect(screen.getByText("2026-08-11")).toBeInTheDocument();
  });

  it("shows Trader payments only when the header option is enabled", async () => {
    const { navigations } = setup();
    await waitFor(() => expect(screen.getByRole("button", { name: "Today" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run Report" }));
    await screen.findByText("Petrol / Fuel");

    expect(screen.queryByText("Trader Payments")).toBeNull();
    fireEvent.click(screen.getByLabelText("Show Trader payments"));

    expect(await screen.findByText("Trader Payments")).toBeInTheDocument();
    expect(screen.getByText("Acme Trading")).toBeInTheDocument();
    expect(screen.getByText("Total Trader Payments")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "SET-000001" }));
    expect(navigations).toContain("/trader-settlements/settlement-1");
  });

  it("opens a Driver row's contributing Orders, each routing to the exact Order by Order Number, with both dates shown", async () => {
    const { navigations } = setup();
    await waitFor(() => expect(screen.getByRole("button", { name: "Today" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run Report" }));
    fireEvent.click(await screen.findByRole("button", { name: "View Orders" }));

    const legacyRow = await screen.findByRole("button", { name: "10 Aug 2026 / ORD-000042" });
    fireEvent.click(legacyRow);
    expect(navigations).toContain("/orders/ORD-000042");

    // The Serial Number never stands alone -- Serial / Date / Order Number.
    expect(screen.getByRole("button", { name: "3 / 10 Aug 2026 / ORD-000043" })).toBeInTheDocument();
    // The Free delivered Order still appears, with zero income.
    expect(screen.getByText("AED 0.00")).toBeInTheDocument();
    // Both dates appear, explaining the 00:09 Business/Calendar Date split.
    expect(screen.getAllByText("2026-08-10").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2026-08-11").length).toBeGreaterThan(0);
  });
});

describe("expenseSourcePath", () => {
  it("opens the General Expense itself for an EXP reference, not the payment", () => {
    expect(expenseSourcePath("general_expense", "expense-1")).toBe(
      "/accounting/general-expenses/expense-1",
    );
    expect(expenseSourcePath("driver_collection_expense", "reconciliation-1")).toBe(
      "/drivers/collections/reconciliation-1",
    );
  });

  it("opens the Fee Payment for an Outsourced Driver Fee reference", () => {
    expect(expenseSourcePath("outsourced_driver_fee", "payment-1")).toBe(
      "/payroll/driver-fees/payments/payment-1",
    );
  });

  it("opens the Payment for a Payroll reference", () => {
    expect(expenseSourcePath("payroll", "payment-2")).toBe("/payroll/payments/payment-2");
  });

  it("returns undefined for an unrecognized source, so the caller never links to nowhere", () => {
    expect(expenseSourcePath("unknown", "x")).toBeUndefined();
  });
});

describe("orderDetailPath", () => {
  it("routes by Order Number, URL-encoded", () => {
    expect(orderDetailPath("ORD-000042")).toBe("/orders/ORD-000042");
    expect(orderDetailPath("ORD/42")).toBe("/orders/ORD%2F42");
  });
});

describe("formatOrderIdentifier", () => {
  it("shows Serial / Date / Order Number together when a Serial Number exists", () => {
    expect(
      formatOrderIdentifier(
        { orderDate: "2026-08-09", orderNumber: "ORD-000099", serialNumber: "1" },
        "en",
      ),
    ).toBe("1 / 09 Aug 2026 / ORD-000099");
  });

  it("falls back to Date / Order Number for a legacy Order with no Serial Number", () => {
    expect(
      formatOrderIdentifier(
        { orderDate: "2026-08-09", orderNumber: "ORD-000099", serialNumber: null },
        "en",
      ),
    ).toBe("09 Aug 2026 / ORD-000099");
  });
});
