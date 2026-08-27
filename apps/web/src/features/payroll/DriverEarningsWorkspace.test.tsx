import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { i18nInstance } from "../../localization/i18n.js";
import { DriverEarningsWorkspace } from "./DriverEarningsWorkspace.js";

const driver = {
  driverCode: "DRV-5",
  driverId: "ahmad",
  driverName: "Ahmad",
  driverType: "employee",
  employeeId: "e1",
};
const sources = ["ORD-000028", "ORD-000029", "ORD-000034"].map((orderNumber, index) => ({
  amount: "2.00",
  customer: `Customer ${index + 1}`,
  deliveryDate: "2026-08-08",
  driver: "Ahmad",
  id: `earning-${index}`,
  orderId: `order-${index}`,
  orderNumber,
  rate: "2.00",
  referenceNumber: null,
  serialDate: "2026-08-08",
  serialNumber: String(index + 1),
  trader: "Noon",
}));
const collectionSources = Array.from({ length: 5 }, (_, index) => ({
  amount: "1.00",
  area: "Dubai",
  closeDate: "2026-08-08",
  customer: `Collection Customer ${index + 1}`,
  id: `collection-earning-${index}`,
  orderId: `collection-order-${index}`,
  orderNumber: `COL-${String(index + 1).padStart(6, "0")}`,
  rate: "1.00",
  referenceNumber: null,
  serialDate: "2026-08-08",
  serialNumber: String(index + 101),
}));
const locked = {
  id: "period-1",
  dateFrom: "2026-08-01",
  dateTo: "2026-08-12",
  deliveredOrders: 3,
  collectedOrders: 5,
  deliveryEarnings: "6.00",
  collectionEarnings: "5.00",
  collectionRate: "1.00",
  totalEarnings: "11.00",
  interimPaid: "0.00",
  payrollPaid: "0.00",
  outstanding: "11.00",
  status: "unpaid",
  deliverySources: sources.map(({ amount, ...source }) => ({ ...source, earned: amount })),
};
const monthlyItem = {
  advanceOutstanding: "489.00", advancePaid: "500.00", advanceRecovery: "11.00",
  allowances: "0.00", basicSalary: "3000.00", collectionEarnings: "5.00", deductions: [],
  deliveryEarnings: "6.00", driverCode: "DRV-5", driverEarningPayments: [],
  driverEarnings: "11.00", driverEarningsOutstanding: "0.00", driverEarningsPaid: "11.00",
  driverId: "ahmad", driverName: "Ahmad", employeeId: "e1", grossEarned: "3011.00",
  netSalary: "3000.00", otherDeductions: "0.00", otherEarnings: "0.00",
  salaryAdvances: [], salaryOutstanding: "0.00", salaryPaid: "3000.00", salaryPayments: [],
  totalCashPaid: "3511.00", totalDeductions: "11.00",
};

describe("DriverEarningsWorkspace period confirmation", () => {
  beforeEach(async () => i18nInstance.changeLanguage("en"));

  it("shows the selected month's collapsed Driver payment overview and report", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("monthly-payments")) return { items: [monthlyItem], month: "2026-08", totals: {
        advancePaid: "500.00", driverEarningsPaid: "11.00", salaryPaid: "3000.00", totalCashPaid: "3511.00",
      } };
      if (path.includes("cash-accounts")) return [];
      if (path.includes("/periods?")) return { items: [], nextAvailableStart: null };
      return { items: [driver] };
    });
    render(<DriverEarningsWorkspace api={{ get, post: vi.fn() } as never} canPay />);

    const driverRow = await screen.findByRole("button", { name: /DRV-5 — Ahmad/ });
    expect(screen.queryByText("Basic salary")).not.toBeInTheDocument();
    fireEvent.click(driverRow);
    expect(screen.getByText("Basic salary")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Driver payment report" }));
    expect(screen.getByText("Monthly Driver Payment Report")).toBeInTheDocument();
  });

  it("restores the available Employee Driver on entry", async () => {
    const get = vi.fn(async (path: string) =>
      path.includes("cash-accounts")
        ? []
        : path.includes("/periods?")
          ? { items: [], nextAvailableStart: null }
          : { items: [driver] },
    );
    render(<DriverEarningsWorkspace api={{ get, post: vi.fn() } as never} canPay />);

    expect(await screen.findByRole("combobox", { name: "Driver" })).toHaveValue("ahmad");
    expect(screen.getByRole("button", { name: "Calculate Now" })).toBeEnabled();
  });

  it("does not calculate a date range that overlaps a confirmed period", async () => {
    const post = vi.fn();
    const get = vi.fn(async (path: string) =>
      path.includes("cash-accounts")
        ? []
        : path.includes("/periods?")
          ? { items: [locked], nextAvailableStart: "2026-08-13" }
          : { items: [driver] },
    );
    render(<DriverEarningsWorkspace api={{ get, post } as never} canPay />);
    await screen.findByText("Period History");
    fireEvent.change(await screen.findByLabelText("Date From"), {
      target: { value: "2026-08-10" },
    });
    fireEvent.change(screen.getByLabelText("Date To"), { target: { value: "2026-08-15" } });
    fireEvent.click(screen.getByRole("button", { name: "Calculate Now" }));

    expect(await screen.findByText(/overlaps the confirmed earning period/)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalledWith(
      expect.stringContaining("periods/preview"),
      expect.anything(),
    );
  });

  it("keeps payment hidden before earnings are confirmed", async () => {
    const get = vi.fn(async (path: string) =>
      path.includes("cash-accounts")
        ? [{ id: "cash", name: "Cash" }]
        : path.includes("/periods?")
          ? { items: [], nextAvailableStart: null }
          : { items: [driver] },
    );
    render(<DriverEarningsWorkspace api={{ get, post: vi.fn() } as never} canPay />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Driver" }), {
      target: { value: "ahmad" },
    });
    expect(screen.queryByRole("button", { name: "Confirm payment" })).not.toBeInTheDocument();
  });

  it("confirms earnings without payment fields and reloads locked history", async () => {
    let confirmed = false;
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const get = vi.fn(async (path: string) =>
      path.includes("cash-accounts")
        ? [{ id: "cash", name: "Cash" }]
        : path.includes("/periods?")
          ? {
              items: confirmed ? [locked] : [],
              nextAvailableStart: confirmed ? "2026-08-13" : null,
            }
          : { items: [driver] },
    );
    const post = vi.fn(async (path: string) => {
      if (path.endsWith("/preview"))
        return {
          collectedOrders: 5,
          collectionEarnings: "5.00",
          collectionRate: "1.00",
          collectionSources,
          deliveredOrders: 3,
          deliveryEarnings: "6.00",
          deliverySources: sources,
          totalEarnings: "11.00",
        };
      confirmed = true;
      return { ...locked, periodId: locked.id };
    });
    render(<DriverEarningsWorkspace api={{ get, post } as never} canPay />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Driver" }), {
      target: { value: "ahmad" },
    });
    expect(screen.queryByLabelText("Number of Collected Orders")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Calculate Now" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm & Lock Earnings" }));
    expect(await screen.findByText("Earning Period Confirmed")).toBeInTheDocument();
    expect(post).toHaveBeenLastCalledWith("operations/payroll/driver-earnings/periods", {
      dateFrom: expect.any(String),
      dateTo: expect.any(String),
      driverId: "ahmad",
    });
    expect(screen.getByText("Period History")).toBeInTheDocument();
    expect(screen.getByText(/Period Outstanding/)).toHaveTextContent(/AED\s*11\.00/);
    expect(screen.getByLabelText("Date From")).toHaveValue("2026-08-13");
    expect(post).not.toHaveBeenCalledWith(
      expect.stringContaining("employee/payments"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("restores candidate source traceability and reconciles the Ahmad preview", async () => {
    const get = vi.fn(async (path: string) =>
      path.includes("cash-accounts")
        ? []
        : path.includes("/periods?")
          ? { items: [], nextAvailableStart: null }
          : { items: [driver] },
    );
    const post = vi.fn(async () => ({
      collectedOrders: 5,
      collectionEarnings: "5.00",
      collectionRate: "1.00",
      collectionSources,
      deliveredOrders: 3,
      deliveryEarnings: "6.00",
      deliverySources: sources,
      totalEarnings: "11.00",
    }));
    render(<DriverEarningsWorkspace api={{ get, post } as never} canPay />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Driver" }), {
      target: { value: "ahmad" },
    });
    expect(screen.queryByLabelText("Number of Collected Orders")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Calculate Now" }));
    expect(await screen.findByText("Delivery Transactions to Include")).toBeInTheDocument();
    for (const order of ["ORD-000028", "ORD-000029", "ORD-000034"])
      expect(screen.getByRole("link", { name: order })).toHaveAttribute("href", `/orders/${order}`);
    expect(screen.getByText("Collection Earning Detail")).toBeInTheDocument();
    expect(screen.getByText((_, element) =>
      element?.tagName === "P" && element.textContent?.replace(/\s+/g, " ") === "Number of Collected Orders: 5",
    )).toBeInTheDocument();
    expect(screen.getByText((_, element) =>
      element?.tagName === "P" && /Collection Rate:.*AED\s*1\.00/.test(element.textContent ?? ""),
    )).toBeInTheDocument();
    expect(screen.getByText("COL-000001")).toBeInTheDocument();
    expect(screen.getAllByText(/AED\s*6\.00/).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/driverEarnings\./)).not.toBeInTheDocument();
  });

  it("blocks confirmation when delivery details do not reconcile", async () => {
    const get = vi.fn(async (path: string) =>
      path.includes("cash-accounts")
        ? []
        : path.includes("/periods?")
          ? { items: [], nextAvailableStart: null }
          : { items: [driver] },
    );
    const post = vi.fn(async () => ({
      collectedOrders: 5,
      collectionEarnings: "5.00",
      collectionRate: "1.00",
      collectionSources,
      deliveredOrders: 3,
      deliveryEarnings: "6.00",
      deliverySources: sources.slice(0, 2),
      totalEarnings: "11.00",
    }));
    render(<DriverEarningsWorkspace api={{ get, post } as never} canPay />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Driver" }), {
      target: { value: "ahmad" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Calculate Now" }));
    expect(
      await screen.findByRole("button", { name: "Confirm & Lock Earnings" }),
    ).toBeDisabled();
    expect(screen.getByText(/details do not match/)).toBeInTheDocument();
  });

  it("loads a persisted locked period after selecting the Driver", async () => {
    const get = vi.fn(async (path: string) =>
      path.includes("cash-accounts")
        ? [{ id: "cash", name: "Cash" }]
        : path.includes("/periods?")
          ? { items: [locked], nextAvailableStart: "2026-08-13" }
          : { items: [driver] },
    );
    render(<DriverEarningsWorkspace api={{ get, post: vi.fn() } as never} canPay />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Driver" }), {
      target: { value: "ahmad" },
    });
    await waitFor(() => expect(screen.getByText("Period History")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Confirm payment" })).toBeEnabled();
    expect(screen.queryByText(/Delivery Earnings.*AED 6\.00/)).not.toBeInTheDocument();
  });

  it("renders Arabic captions without raw keys", async () => {
    await i18nInstance.changeLanguage("ar");
    const get = vi.fn(async (path: string) =>
      path.includes("cash-accounts")
        ? []
        : path.includes("/periods?")
          ? { items: [], nextAvailableStart: null }
          : { items: [driver] },
    );
    const { container } = render(
      <DriverEarningsWorkspace api={{ get, post: vi.fn() } as never} canPay />,
    );
    fireEvent.change(await screen.findByRole("combobox", { name: "المندوب" }), {
      target: { value: "ahmad" },
    });
    expect(await screen.findByText("احسب الآن")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/driverEarnings\./);
  });
});
