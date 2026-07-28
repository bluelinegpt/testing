import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { TraderSettlementsWorkspace } from "./TraderSettlementsWorkspace.js";

const summary = {
  eligibleOrders: 5,
  eligibleTraderPayable: "500.00",
  moneyReceivedAmount: "100.00",
  moneySentAmount: "300.00",
  partiallySettledAmount: "60.00",
  remainingOutstanding: "200.00",
  reversedPayments: 1,
  tradersWithOutstandingBalance: 2,
  unsettledAmount: "200.00",
};

const settlementRow = {
  confirmedBy: "ops.user",
  createdBy: "ops.user",
  isReversed: false,
  moneyReceivedAt: null,
  moneyReceivedConfirmed: false,
  moneySentAt: "2026-07-27T11:00:00.000Z",
  orderCount: 2,
  paymentAmount: "160.00",
  paymentDate: "2026-07-27",
  paymentMethod: "cash" as const,
  paymentReference: null,
  previouslyPaid: "0.00",
  remainingOutstanding: "0.00",
  settlementId: "settlement-1",
  settlementNumber: "SET-000123",
  status: "confirmed" as const,
  traderName: "Test Trader",
};

const trader = {
  code: "TRD-001",
  id: "trader-1",
  mobileNumber: "971501234567",
  name: "Test Trader",
  openOrders: 2,
  status: "active",
  totalOrders: 10,
  unsettledNetPayable: "200.00",
};

const eligibleOrder = {
  additionalFees: "0.00",
  areaName: "Deira",
  codAmount: "110.00",
  customerName: "Test Customer",
  deliveryDate: "2026-07-20",
  emirateName: "Dubai",
  id: "order-1",
  originalAmountDueToTrader: "100.00",
  outstandingBalance: "100.00",
  previouslyPaid: "0.00",
  referenceNumber: "REF-1",
  serialNumber: "SER-1",
  settlementStatus: "unsettled",
  totalDeductions: "10.00",
  vatAmount: "0.00",
};

const companyBank = {
  accountName: "Company Account",
  accountNumberMasked: "******7890",
  bankName: "Company Bank",
  currency: "AED",
  iban: "AE1234567890",
  id: "bank-company-1",
  isActive: true,
  swiftCode: "COMPAEXX",
};

const inactiveCompanyBank = { ...companyBank, id: "bank-company-2", isActive: false };

const traderBank = {
  accountName: "Trader Account",
  accountNumber: "5551234567",
  bankName: "Trader Bank",
  iban: "AE9876543210",
  id: "bank-trader-1",
  isActive: true,
  isDefault: true,
};

const inactiveTraderBank = { ...traderBank, id: "bank-trader-2", isActive: false, isDefault: false };

const proposal = {
  allocations: [
    {
      allocatedAmount: "100.00",
      orderId: "order-1",
      orderNumber: "ORD-1",
      outstandingAfter: "0.00",
      outstandingBefore: "100.00",
      serialNumber: "SER-1",
    },
  ],
  requestedAmount: "100.00",
  totalAllocated: "100.00",
  traderId: "trader-1",
  unallocatedAmount: "0.00",
};

const detail = {
  beneficiaryBank: null,
  confirmedBy: "ops.user",
  createdBy: "ops.creator",
  moneyReceivedBy: null,
  moneyReceivedDate: null,
  moneyReceivedNotes: null,
  moneyReceivedReference: null,
  moneySentAt: "2026-07-27T11:00:00.000Z",
  notes: null,
  orders: [
    {
      additionalFees: "0.00",
      amountPaidNow: "100.00",
      areaName: "Deira",
      codAmount: "110.00",
      customerName: "Test Customer",
      deliveryDate: "2026-07-20",
      emirateName: "Dubai",
      orderSettlementStatus: "money_sent_to_trader",
      originalTraderPayable: "100.00",
      previouslyPaid: "0.00",
      referenceNumber: "REF-1",
      remainingOutstanding: "0.00",
      serialNumber: "SER-1",
      serviceFee: "10.00",
      totalDeductions: "10.00",
      vatAmount: "0.00",
    },
  ],
  paymentDate: "2026-07-27",
  paymentMethod: "cash" as const,
  paymentReference: null,
  reversalOfSettlementNumber: null,
  reversalReason: null,
  reversedBySettlementNumber: null,
  settlementId: "settlement-1",
  settlementNumber: "SET-000123",
  sourceBank: null,
  status: "confirmed" as const,
  summary: {
    amountPaidNow: "100.00",
    orderCount: 1,
    previouslyPaid: "0.00",
    remainingOutstanding: "0.00",
    totalAdditionalFees: "0.00",
    totalCod: "110.00",
    totalDeductions: "10.00",
    totalOriginalTraderPayable: "100.00",
    totalServiceFees: "10.00",
    totalVat: "0.00",
  },
  traderName: "Test Trader",
};

function setup(overrides: { readonly getExtra?: (path: string) => unknown; readonly permissions?: readonly string[] } = {}) {
  const getCalls: string[] = [];
  const postCalls: { body: unknown; path: string }[] = [];
  const api = {
    get: vi.fn((path: string) => {
      getCalls.push(path);
      const extraFirst = overrides.getExtra?.(path);
      if (extraFirst !== undefined) return Promise.resolve(extraFirst);
      if (path.startsWith("operations/settlements/payments/summary")) {
        return Promise.resolve(summary);
      }
      if (path.startsWith("operations/settlements/payments/list")) {
        return Promise.resolve({ items: [settlementRow], page: 1, pageSize: 25, total: 1 });
      }
      if (path.startsWith("operations/settlements/payments/eligible-orders")) {
        return Promise.resolve({ items: [eligibleOrder], page: 1, pageSize: 200, total: 1 });
      }
      if (path === "operations/settlements/payments/settlement-1") {
        return Promise.resolve(detail);
      }
      if (path === "operations/traders") {
        return Promise.resolve([trader]);
      }
      if (path === "configuration/bank-accounts") {
        return Promise.resolve([companyBank, inactiveCompanyBank]);
      }
      if (path === "configuration/traders/trader-1/bank-accounts") {
        return Promise.resolve([traderBank, inactiveTraderBank]);
      }
      return Promise.resolve({ items: [], page: 1, pageSize: 25, total: 0 });
    }),
    getBinary: vi.fn(() => Promise.resolve(new Blob(["%PDF-fake"], { type: "application/pdf" }))),
    post: vi.fn((path: string, body?: unknown) => {
      postCalls.push({ body, path });
      if (path === "operations/settlements/payments/propose-allocation") {
        return Promise.resolve(proposal);
      }
      if (path === "operations/settlements/payments") {
        return Promise.resolve({
          amount: "100.00",
          orderCount: 1,
          paymentMethod: "cash",
          settlementId: "settlement-new",
          settlementNumber: "SET-000200",
          traderId: "trader-1",
          traderName: "Test Trader",
        });
      }
      if (path.endsWith("/confirm-receipt")) {
        return Promise.resolve({ orderCount: 1, settlementId: "settlement-1" });
      }
      if (path.endsWith("/reverse")) {
        return Promise.resolve({
          orderCount: 1,
          reversalSettlementId: "settlement-reversal",
          reversalSettlementNumber: "SET-000300",
          settlementId: "settlement-1",
        });
      }
      return Promise.resolve({});
    }),
  };
  render(
    <TraderSettlementsWorkspace
      api={api as unknown as ApiClient}
      permissions={overrides.permissions ?? ["settlements.create", "settlements.reverse"]}
    />,
  );
  return { api, getCalls, postCalls };
}

describe("TraderSettlementsWorkspace", () => {
  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
  });

  it("shows a permission-denied message instead of the workspace for a User without settlements.create", async () => {
    setup({ permissions: ["orders.assign_driver"] });
    expect(
      await screen.findByText("You do not have permission to perform this action."),
    ).toBeInTheDocument();
    expect(screen.queryByText("New Settlement")).not.toBeInTheDocument();
  });

  it("renders the six primary summary cards from server-authoritative totals", async () => {
    setup();
    const cards = await screen.findByTestId("trader-settlements-summary");
    function cardValue(label: string) {
      return within(cards).getByText(label).nextElementSibling?.textContent;
    }
    expect(cards.querySelectorAll(".kpi-card")).toHaveLength(6);
    expect(cardValue("Eligible Trader Payable")).toBe("500.00");
    expect(cardValue("Unsettled Amount")).toBe("200.00");
    expect(cardValue("Partially Settled Amount")).toBe("60.00");
    expect(cardValue("Money Sent")).toBe("300.00");
    expect(cardValue("Money Received")).toBe("100.00");
    expect(cardValue("Remaining Outstanding")).toBe("200.00");
  });

  it("renders the three secondary indicators separately from the primary cards", async () => {
    setup();
    const secondary = await screen.findByTestId("trader-settlements-summary-secondary");
    function chipValue(label: string) {
      return within(secondary).getByText(label).nextElementSibling?.textContent;
    }
    expect(chipValue("Eligible Orders")).toBe("5");
    expect(chipValue("Traders with Outstanding Balance")).toBe("2");
    expect(chipValue("Reversed Payments")).toBe("1");
  });

  it("sends the Trader filter to the backend as a query parameter", async () => {
    const { getCalls } = setup();
    await screen.findByText("SET-000123");
    getCalls.length = 0;
    fireEvent.change(screen.getByLabelText("Trader"), { target: { value: "trader-1" } });
    await waitFor(() =>
      expect(getCalls.some((call) => call.includes("traderId=trader-1"))).toBe(true),
    );
  });

  it("shows Money Sent and Money Received as separate table columns", async () => {
    setup();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Money Sent")).toBeInTheDocument();
    expect(within(table).getByText("Money Received")).toBeInTheDocument();
    const row = screen.getByText("SET-000123").closest("tr");
    expect(row?.textContent).toContain("2026-07-27");
  });

  it("opens the New Settlement dialog and loads eligible Orders once a Trader is selected", async () => {
    const { getCalls } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "New Settlement" }));
    fireEvent.click(await screen.findByRole("button", { name: /Test Trader/ }));
    await waitFor(() =>
      expect(getCalls.some((call) => call.includes("eligible-orders?traderId=trader-1"))).toBe(
        true,
      ),
    );
    expect(await screen.findByText("SER-1")).toBeInTheDocument();
  });

  it("calls the oldest-first allocation proposal endpoint when a Payment Amount is entered", async () => {
    const { postCalls } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "New Settlement" }));
    fireEvent.click(await screen.findByRole("button", { name: /Test Trader/ }));
    await screen.findByText("SER-1");
    fireEvent.change(screen.getByLabelText("Payment Amount"), { target: { value: "100" } });
    await waitFor(() =>
      expect(
        postCalls.some((call) => call.path === "operations/settlements/payments/propose-allocation"),
      ).toBe(true),
    );
    // Renders the proposed allocation line from the server, not a client computation.
    expect(await screen.findByText("Outstanding Before")).toBeInTheDocument();
  });

  it("updates allocation totals when the proposed amount is manually edited", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "New Settlement" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(await dialog.findByRole("button", { name: /Test Trader/ }));
    await dialog.findByText("SER-1");
    fireEvent.change(dialog.getByLabelText("Payment Amount"), { target: { value: "100" } });
    await dialog.findByText("Outstanding Before");
    const allocationInput = (await dialog.findByDisplayValue("100.00")) as HTMLInputElement;
    fireEvent.change(allocationInput, { target: { value: "60" } });
    await waitFor(() => expect(dialog.getByText("60.00")).toBeInTheDocument());
  });

  it("blocks proceeding to Review while the allocated total does not match the Payment Amount", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "New Settlement" }));
    fireEvent.click(await screen.findByRole("button", { name: /Test Trader/ }));
    await screen.findByText("SER-1");
    fireEvent.change(screen.getByLabelText("Payment Amount"), { target: { value: "100" } });
    await screen.findByText("Outstanding Before");
    const allocationInput = (await screen.findByDisplayValue("100.00")) as HTMLInputElement;
    fireEvent.change(allocationInput, { target: { value: "60" } });
    await waitFor(() =>
      expect(screen.getByText("The total allocated amount must equal the Payment Amount.")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Confirm Money Sent to Trader")).not.toBeInTheDocument();
  });

  it("masks the Trader beneficiary bank account number in the picker and excludes inactive accounts", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "New Settlement" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(await dialog.findByRole("button", { name: /Test Trader/ }));
    await dialog.findByText("SER-1");
    fireEvent.change(dialog.getByLabelText("Payment Amount"), { target: { value: "100" } });
    fireEvent.change(dialog.getByLabelText("Payment Method"), {
      target: { value: "bank_transfer" },
    });
    const beneficiarySelect = await dialog.findByLabelText("Trader Beneficiary Bank Account");
    expect(beneficiarySelect.textContent).toContain("******7890");
    expect(beneficiarySelect.textContent).not.toContain("5551234567");
    // The inactive Trader bank account must never appear as an option.
    expect(within(beneficiarySelect).queryAllByText(/Trader Account/)).toHaveLength(1);
    const sourceSelect = dialog.getByLabelText("Company Source Bank Account");
    expect(sourceSelect.textContent).toContain("******7890");
    expect(within(sourceSelect).queryAllByText(/Company Account/)).toHaveLength(1);
  });

  it("confirms a full payment and shows the success screen with the Settlement Number", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "New Settlement" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(await dialog.findByRole("button", { name: /Test Trader/ }));
    await dialog.findByText("SER-1");
    fireEvent.change(dialog.getByLabelText("Payment Amount"), { target: { value: "100" } });
    await dialog.findByText("Outstanding Before");
    await waitFor(() =>
      expect(dialog.getByText("Confirm Money Sent to Trader")).toBeInTheDocument(),
    );
    fireEvent.click(dialog.getByText("Confirm Money Sent to Trader"));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "operations/settlements/payments",
        expect.objectContaining({ traderId: "trader-1" }),
        expect.objectContaining({ "X-Idempotency-Key": expect.any(String) }),
      ),
    );
    expect(await dialog.findByText(/SET-000200 confirmed\./)).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Preview Statement" })).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Print" })).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Download PDF" })).toBeInTheDocument();
  });

  it("shows a partially-settled Order with the correct remaining balance in the allocation table", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "New Settlement" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(await dialog.findByRole("button", { name: /Test Trader/ }));
    await dialog.findByText("SER-1");
    fireEvent.change(dialog.getByLabelText("Payment Amount"), { target: { value: "100" } });
    await dialog.findByText("Outstanding Before");
    const allocationInput = (await dialog.findByDisplayValue("100.00")) as HTMLInputElement;
    fireEvent.change(allocationInput, { target: { value: "40" } });
    // Outstanding balance 100 - paid now 40 = 60 remaining.
    await waitFor(() => expect(dialog.getByText("60.00")).toBeInTheDocument());
  });

  it("displays a specific backend error rather than a generic failure message", async () => {
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/settlements/payments/summary")) return Promise.resolve(summary);
        if (path.startsWith("operations/settlements/payments/list"))
          return Promise.resolve({ items: [], page: 1, pageSize: 25, total: 0 });
        if (path.startsWith("operations/settlements/payments/eligible-orders"))
          return Promise.resolve({ items: [eligibleOrder], page: 1, pageSize: 200, total: 1 });
        if (path === "operations/traders") return Promise.resolve([trader]);
        return Promise.resolve({ items: [], page: 1, pageSize: 25, total: 0 });
      }),
      getBinary: vi.fn(),
      post: vi.fn((path: string) => {
        if (path === "operations/settlements/payments/propose-allocation") {
          return Promise.resolve(proposal);
        }
        if (path === "operations/settlements/payments") {
          return Promise.reject(
            new ApiError(
              "One or more Orders' outstanding balances have changed.",
              "settlement_allocation_exceeds_outstanding",
              409,
            ),
          );
        }
        return Promise.resolve({});
      }),
    };
    render(
      <TraderSettlementsWorkspace
        api={api as unknown as ApiClient}
        permissions={["settlements.create"]}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "New Settlement" }));
    fireEvent.click(await screen.findByRole("button", { name: /Test Trader/ }));
    await screen.findByText("SER-1");
    fireEvent.change(screen.getByLabelText("Payment Amount"), { target: { value: "100" } });
    await screen.findByText("Outstanding Before");
    await waitFor(() =>
      expect(screen.getByText("Confirm Money Sent to Trader")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Confirm Money Sent to Trader"));
    expect(
      await screen.findByText("One or more Orders' outstanding balances have changed."),
    ).toBeInTheDocument();
  });

  describe("Money Received", () => {
    it("confirms Money Received via the confirm-receipt endpoint", async () => {
      const { api } = setup();
      await screen.findByText("SET-000123");
      fireEvent.click(screen.getByRole("button", { name: "Confirm Money Received" }));
      const dialog = within(await screen.findByRole("dialog"));
      fireEvent.click(dialog.getByRole("button", { name: "Confirm Money Received" }));
      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith(
          "operations/settlements/payments/settlement-1/confirm-receipt",
          expect.any(Object),
          expect.objectContaining({ "X-Idempotency-Key": expect.any(String) }),
        ),
      );
    });

    it("does not offer Confirm Money Received once already confirmed", async () => {
      setup({
        getExtra: (path) =>
          path.startsWith("operations/settlements/payments/list")
            ? {
                items: [{ ...settlementRow, moneyReceivedAt: "2026-07-28T10:00:00.000Z", moneyReceivedConfirmed: true }],
                page: 1,
                pageSize: 25,
                total: 1,
              }
            : undefined,
      });
      await screen.findByText("SET-000123");
      expect(screen.queryByRole("button", { name: "Confirm Money Received" })).not.toBeInTheDocument();
    });
  });

  describe("Reversal", () => {
    it("requires a reason before reversal, and calls the reverse endpoint", async () => {
      const { api } = setup();
      await screen.findByText("SET-000123");
      fireEvent.click(screen.getByRole("button", { name: "Reverse" }));
      const dialog = within(await screen.findByRole("dialog"));
      fireEvent.click(dialog.getByRole("button", { name: "Reverse" }));
      expect(dialog.getByText("A reason is required to reverse this settlement.")).toBeInTheDocument();
      fireEvent.change(dialog.getByLabelText("Reason"), { target: { value: "Trader disputed" } });
      fireEvent.click(dialog.getByRole("button", { name: "Reverse" }));
      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith(
          "operations/settlements/payments/settlement-1/reverse",
          { reason: "Trader disputed" },
        ),
      );
    });

    it("does not offer Reverse once Money Received has been confirmed", async () => {
      setup({
        getExtra: (path) =>
          path.startsWith("operations/settlements/payments/list")
            ? {
                items: [{ ...settlementRow, moneyReceivedAt: "2026-07-28T10:00:00.000Z", moneyReceivedConfirmed: true }],
                page: 1,
                pageSize: 25,
                total: 1,
              }
            : undefined,
      });
      await screen.findByText("SET-000123");
      expect(screen.queryByRole("button", { name: "Reverse" })).not.toBeInTheDocument();
    });
  });

  describe("Settlement detail", () => {
    it("shows Created By, Order allocations and PDF actions", async () => {
      setup();
      await screen.findByText("SET-000123");
      fireEvent.click(screen.getByRole("button", { name: "View" }));
      const dialog = within(await screen.findByRole("dialog"));
      expect(await dialog.findByText("ops.creator")).toBeInTheDocument();
      expect(dialog.getByText("SER-1")).toBeInTheDocument();
      expect(dialog.getByRole("button", { name: "Preview Statement" })).toBeInTheDocument();
      expect(dialog.getByRole("button", { name: "Print" })).toBeInTheDocument();
      expect(dialog.getByRole("button", { name: "Download PDF" })).toBeInTheDocument();
    });

    it("never renders an internal settlement or Order database ID", async () => {
      setup();
      await screen.findByText("SET-000123");
      fireEvent.click(screen.getByRole("button", { name: "View" }));
      const dialog = within(await screen.findByRole("dialog"));
      await dialog.findByText("SER-1");
      expect(dialog.queryByText("settlement-1")).not.toBeInTheDocument();
      expect(dialog.queryByText("order-1")).not.toBeInTheDocument();
    });
  });

  it("renders Arabic labels and RTL-safe text when the active language is Arabic", async () => {
    await i18nInstance.changeLanguage("ar");
    setup();
    expect((await screen.findAllByText("تسويات التاجر")).length).toBeGreaterThan(0);
    await i18nInstance.changeLanguage("en");
  });
});
