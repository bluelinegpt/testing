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

/** The Cash account a cash settlement is funded from. */
const companyCashAccount = {
  code: "CASH-0001",
  id: "cash-company-1",
  isActive: true,
  name: "Main Cash",
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

const inactiveTraderBank = {
  ...traderBank,
  id: "bank-trader-2",
  isActive: false,
  isDefault: false,
};

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

function setup(
  overrides: {
    readonly getExtra?: (path: string) => unknown;
    readonly permissions?: readonly string[];
  } = {},
) {
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
      // Company Cash accounts fund a cash settlement (balance-control work).
      // `operations/accounting/cash-bank/cash-accounts` returns a plain ARRAY,
      // not a paged envelope, so it needs its own branch: the generic fallback
      // below answers `{ items: [] }` and the dialog's `cashAccounts.map`
      // rightly threw on it.
      if (path.startsWith("operations/accounting/cash-bank/cash-accounts")) {
        return Promise.resolve([companyCashAccount]);
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
  renderWithRouter(
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
    expect(screen.queryByText("Traders New Settlement")).not.toBeInTheDocument();
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

  it("opens the Traders New Settlement dialog and loads eligible Orders once a Trader is selected", async () => {
    const { getCalls } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Traders New Settlement" }));
    fireEvent.click(await screen.findByRole("button", { name: /Test Trader/ }));
    await waitFor(() =>
      expect(
        getCalls.some(
          (call) => call.includes("eligible-orders?") && call.includes("traderId=trader-1"),
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("SER-1")).toBeInTheDocument();
  });

  it("calls the oldest-first allocation proposal endpoint when a Payment Amount is entered", async () => {
    const { postCalls } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Traders New Settlement" }));
    fireEvent.click(await screen.findByRole("button", { name: /Test Trader/ }));
    await screen.findByText("SER-1");
    fireEvent.change(screen.getByLabelText("Payment Amount"), { target: { value: "100" } });
    await waitFor(() =>
      expect(
        postCalls.some(
          (call) => call.path === "operations/settlements/payments/propose-allocation",
        ),
      ).toBe(true),
    );
    // Renders the proposed allocation line from the server, not a client computation.
    expect(await screen.findByText("Outstanding Before")).toBeInTheDocument();
  });

  it("updates allocation totals when the proposed amount is manually edited", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Traders New Settlement" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(await dialog.findByRole("button", { name: /Test Trader/ }));
    await waitFor(() => expect(dialog.getAllByText("SER-1").length).toBeGreaterThan(0));
    fireEvent.change(dialog.getByLabelText("Payment Amount"), { target: { value: "100" } });
    await dialog.findByText("Outstanding Before");
    const allocationInput = (await dialog.findByDisplayValue("100.00")) as HTMLInputElement;
    fireEvent.change(allocationInput, { target: { value: "60" } });
    await waitFor(() => expect(dialog.getByText("60.00")).toBeInTheDocument());
  });

  it("blocks proceeding to Review while the allocated total does not match the Payment Amount", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Traders New Settlement" }));
    fireEvent.click(await screen.findByRole("button", { name: /Test Trader/ }));
    await screen.findByText("SER-1");
    fireEvent.change(screen.getByLabelText("Payment Amount"), { target: { value: "100" } });
    await screen.findByText("Outstanding Before");
    const allocationInput = (await screen.findByDisplayValue("100.00")) as HTMLInputElement;
    fireEvent.change(allocationInput, { target: { value: "60" } });
    await waitFor(() =>
      expect(
        screen.getByText("The total allocated amount must equal the Payment Amount."),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("Confirm Money Sent to Trader")).not.toBeInTheDocument();
  });

  it("masks the Trader beneficiary bank account number in the picker and excludes inactive accounts", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Traders New Settlement" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(await dialog.findByRole("button", { name: /Test Trader/ }));
    await waitFor(() => expect(dialog.getAllByText("SER-1").length).toBeGreaterThan(0));
    fireEvent.change(dialog.getByLabelText("Payment Amount"), { target: { value: "100" } });
    fireEvent.change(dialog.getByLabelText("Payment Method"), {
      target: { value: "bank_transfer" },
    });
    const beneficiarySelect = await dialog.findByLabelText("Trader Beneficiary Bank Account");
    expect(beneficiarySelect.textContent).toContain("******4567");
    expect(beneficiarySelect.textContent).not.toContain("5551234567");
    // The inactive Trader bank account must never appear as an option.
    expect(within(beneficiarySelect).queryAllByText(/Trader Account/)).toHaveLength(1);
    const sourceSelect = dialog.getByLabelText("Company Source Bank Account");
    expect(sourceSelect.textContent).toContain("******7890");
    expect(within(sourceSelect).queryAllByText(/Company Account/)).toHaveLength(1);
  });

  it("confirms a full payment and shows the success screen with the Settlement Number", async () => {
    const { api } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Traders New Settlement" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(await dialog.findByRole("button", { name: /Test Trader/ }));
    await waitFor(() => expect(dialog.getAllByText("SER-1").length).toBeGreaterThan(0));
    fireEvent.change(dialog.getByLabelText("Payment Amount"), { target: { value: "100" } });
    await dialog.findByText("Outstanding Before");
    // A cash settlement must name the Cash account funding it.
    fireEvent.change(dialog.getByLabelText("Cash Account"), {
      target: { value: "cash-company-1" },
    });
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
    fireEvent.click(await screen.findByRole("button", { name: "Traders New Settlement" }));
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(await dialog.findByRole("button", { name: /Test Trader/ }));
    await waitFor(() => expect(dialog.getAllByText("SER-1").length).toBeGreaterThan(0));
    fireEvent.change(dialog.getByLabelText("Payment Amount"), { target: { value: "100" } });
    await dialog.findByText("Outstanding Before");
    const allocationInput = (await dialog.findByDisplayValue("100.00")) as HTMLInputElement;
    fireEvent.change(allocationInput, { target: { value: "40" } });
    // Outstanding balance 100 - paid now 40 = 60 remaining.
    await waitFor(() => {
      const label = dialog.getByText("Remaining Outstanding After Payment");
      expect(label.nextElementSibling).toHaveTextContent("60.00");
    });
  });

  it("selects the Cash Account automatically when the Company has only one", async () => {
    /* A required field with a single possible answer is not a choice, it is a
       step to forget -- and forgetting it blocked Review with "Cash Account is
       required" every time. With more than one the operator still picks:
       which cash box the money leaves is not a decision to make for them. */
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/settlements/payments/summary"))
          return Promise.resolve(summary);
        if (path.startsWith("operations/settlements/payments/list"))
          return Promise.resolve({ items: [], page: 1, pageSize: 25, total: 0 });
        if (path.startsWith("operations/settlements/payments/eligible-orders"))
          return Promise.resolve({ items: [eligibleOrder], page: 1, pageSize: 200, total: 1 });
        if (path === "operations/traders") return Promise.resolve([trader]);
        if (path.startsWith("operations/accounting/cash-bank/cash-accounts"))
          return Promise.resolve([companyCashAccount]);
        return Promise.resolve({ items: [], page: 1, pageSize: 25, total: 0 });
      }),
      getBinary: vi.fn(),
      post: vi.fn((path: string) =>
        Promise.resolve(path === "operations/settlements/payments/propose-allocation" ? proposal : {}),
      ),
    };
    renderWithRouter(
      <TraderSettlementsWorkspace
        api={api as unknown as ApiClient}
        permissions={["settlements.create"]}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Traders New Settlement" }));
    fireEvent.click(await screen.findByRole("button", { name: /Test Trader/ }));
    await screen.findByText("SER-1");

    // Nothing typed into Cash Account, and Cash is the default method.
    const cashAccount = (await screen.findByLabelText("Cash Account")) as HTMLSelectElement;
    await waitFor(() => expect(cashAccount.value).toBe("cash-company-1"));
  });

  it("displays a specific backend error rather than a generic failure message", async () => {
    const api = {
      get: vi.fn((path: string) => {
        if (path.startsWith("operations/settlements/payments/summary"))
          return Promise.resolve(summary);
        if (path.startsWith("operations/settlements/payments/list"))
          return Promise.resolve({ items: [], page: 1, pageSize: 25, total: 0 });
        if (path.startsWith("operations/settlements/payments/eligible-orders"))
          return Promise.resolve({ items: [eligibleOrder], page: 1, pageSize: 200, total: 1 });
        if (path === "operations/traders") return Promise.resolve([trader]);
        // Plain array, like the real cash-accounts endpoint.
        if (path.startsWith("operations/accounting/cash-bank/cash-accounts")) {
          return Promise.resolve([companyCashAccount]);
        }
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
    renderWithRouter(
      <TraderSettlementsWorkspace
        api={api as unknown as ApiClient}
        permissions={["settlements.create"]}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Traders New Settlement" }));
    fireEvent.click(await screen.findByRole("button", { name: /Test Trader/ }));
    await screen.findByText("SER-1");
    fireEvent.change(screen.getByLabelText("Payment Amount"), { target: { value: "100" } });
    await screen.findByText("Outstanding Before");
    fireEvent.change(screen.getByLabelText("Cash Account"), {
      target: { value: "cash-company-1" },
    });
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
      fireEvent.click(screen.getByRole("button", { name: "Confirm Money Received by Trader" }));
      const dialog = within(await screen.findByRole("dialog"));
      fireEvent.click(dialog.getByRole("button", { name: "Confirm Money Received by Trader" }));
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
                items: [
                  {
                    ...settlementRow,
                    moneyReceivedAt: "2026-07-28T10:00:00.000Z",
                    moneyReceivedConfirmed: true,
                  },
                ],
                page: 1,
                pageSize: 25,
                total: 1,
              }
            : undefined,
      });
      await screen.findByText("SET-000123");
      expect(
        screen.queryByRole("button", { name: "Confirm Money Received" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("Reversal", () => {
    it("requires a reason before reversal, and calls the reverse endpoint", async () => {
      const { api } = setup();
      await screen.findByText("SET-000123");
      fireEvent.click(screen.getByRole("button", { name: "Reverse" }));
      const dialog = within(await screen.findByRole("dialog"));
      fireEvent.click(dialog.getByRole("button", { name: "Reverse" }));
      expect(
        dialog.getByText("A reason is required to reverse this settlement."),
      ).toBeInTheDocument();
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
                items: [
                  {
                    ...settlementRow,
                    moneyReceivedAt: "2026-07-28T10:00:00.000Z",
                    moneyReceivedConfirmed: true,
                  },
                ],
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
      await waitFor(() => expect(dialog.getAllByText("SER-1").length).toBeGreaterThan(0));
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

/**
 * Receipt-confirmation deep link.
 *
 * The Orders list can ask this screen to open the existing Confirm Money
 * Received dialog against ONE authoritative settlement. The cases that matter
 * are the ones where it must refuse: an ambiguous target, a stale id, work
 * already done, and a settlement this Company cannot see.
 */
describe("confirm_receipt deep link", () => {
  const visit = (search: string) => {
    globalThis.history.replaceState({}, "", `/trader-settlements${search}`);
  };

  afterEach(() => {
    globalThis.history.replaceState({}, "", "/trader-settlements");
  });

  it("opens the existing confirmation dialog for a unique settlement", async () => {
    visit("?traderId=trader-1&settlementId=settlement-1&openDialog=confirm_receipt&returnTo=%2Forders");
    const { postCalls } = setup();

    const dialog = await screen.findByRole("dialog");
    // The REAL dialog, showing the resolved settlement.
    expect(within(dialog).getByText(/SET-/)).toBeInTheDocument();
    // Opening it writes nothing.
    expect(postCalls.filter((call) => call.path.includes("confirm-receipt"))).toHaveLength(0);
    // The instruction is consumed, so a refresh cannot reopen it.
    expect(globalThis.location.search).not.toContain("openDialog");
    expect(globalThis.location.search).toContain("settlementId=settlement-1");
  });

  it("refuses to guess when the backend reported an ambiguous target", async () => {
    // No settlementId: the backend found several confirmable settlements.
    visit("?traderId=trader-1&openDialog=confirm_receipt");
    setup();
    expect(await screen.findByText(/more than one settlement awaiting/i)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not open a dialog for a settlement this Company cannot see", async () => {
    // A cross-Company or invented id is simply absent from the scoped list.
    visit("?settlementId=settlement-from-another-company&openDialog=confirm_receipt");
    setup();
    expect(await screen.findByText(/no longer available for receipt confirmation/i)).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not open an actionable dialog without permission", async () => {
    visit("?settlementId=settlement-1&openDialog=confirm_receipt");
    setup({ permissions: ["settlements.view"] });
    // The security property is what matters: no actionable dialog appears, so
    // the confirmation control is never reachable from the URL alone.
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("ignores an off-origin returnTo", async () => {
    visit("?settlementId=settlement-1&openDialog=confirm_receipt&returnTo=https%3A%2F%2Fevil.test");
    setup();
    await screen.findByRole("dialog");
    // Rejected by the shared primitive; nothing carries the hostile value.
    expect(document.body.innerHTML).not.toContain("evil.test");
  });
});

/**
 * Traders New Settlement Order preselection.
 *
 * The Orders list can ask this screen to open Traders New Settlement with the Trader
 * AND the originating Order already ticked. The property that matters is that
 * the tick uses the eligible row's own CURRENT outstanding balance -- an Order
 * with 175.00 due and 174.92 already paid must contribute 0.08, not 175.00.
 */
describe("new_settlement Order preselection", () => {
  const visit = (search: string) => {
    globalThis.history.replaceState({}, "", `/trader-settlements${search}`);
  };

  afterEach(() => {
    globalThis.history.replaceState({}, "", "/trader-settlements");
  });

  it("opens Traders New Settlement with the Trader and originating Order selected", async () => {
    visit("?traderId=trader-1&orderId=order-1&orderNumber=ORD-1&openDialog=new_settlement&returnTo=%2Forders");
    const { postCalls } = setup();

    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Eligible Orders");
    expect(within(dialog).getByText("Filter").closest("details")).not.toHaveAttribute("open");
    await waitFor(() => {
      const checked = within(dialog)
        .getAllByRole("checkbox")
        .filter((box) => (box as HTMLInputElement).checked);
      expect(checked.length).toBeGreaterThan(0);
    });
    // Nothing is created by arriving.
    expect(postCalls.filter((call) => call.path.includes("settlements"))).toHaveLength(0);
    // The instruction is consumed; a refresh cannot reopen the dialog.
    expect(globalThis.location.search).not.toContain("openDialog");
  });

  it("preselects an order-origin settlement but leaves the paid amount for operator entry", async () => {
    visit("?traderId=trader-1&orderId=order-1&openDialog=new_settlement");
    const olderOrder = {
      ...eligibleOrder,
      deliveryDate: "2026-07-10",
      id: "older-order",
      outstandingBalance: "25.00",
      serialNumber: "SER-0",
    };
    const { postCalls } = setup({
      getExtra: (path: string) =>
        path.startsWith("operations/settlements/payments/eligible-orders")
          ? {
              items: [olderOrder, { ...eligibleOrder, outstandingBalance: "275.00" }],
              page: 1,
              pageSize: 200,
              total: 2,
            }
          : undefined,
    });

    const dialog = within(await screen.findByRole("dialog"));
    await dialog.findByText("SER-0");
    await waitFor(() => expect(dialog.getAllByText("SER-1").length).toBeGreaterThan(0));

    await waitFor(() =>
      expect(dialog.getByLabelText("Payment Amount")).toHaveDisplayValue(""),
    );
    const ordersTable = dialog.getAllByRole("table")[0]!;
    const rowCheckboxes = within(ordersTable)
      .getAllByRole("checkbox")
      .slice(1) as HTMLInputElement[];
    expect(rowCheckboxes.map((box) => box.checked)).toEqual([false, true]);
    expect(dialog.queryByText(/oldest-first allocation/i)).not.toBeInTheDocument();
    expect(
      postCalls.some((call) => call.path === "operations/settlements/payments/propose-allocation"),
    ).toBe(false);
  });

  it("uses the CURRENT outstanding balance, not the original amount due", async () => {
    // The 175.00 / 174.92 / 0.08 case: only 0.08 remains allocatable.
    visit("?traderId=trader-1&orderId=order-1&openDialog=new_settlement");
    setup({
      getExtra: (path: string) =>
        path.startsWith("operations/settlements/payments/eligible-orders")
          ? {
              items: [
                {
                  ...eligibleOrder,
                  originalAmountDueToTrader: "175.00",
                  outstandingBalance: "0.08",
                },
              ],
              page: 1,
              pageSize: 200,
              total: 1,
            }
          : undefined,
    });

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => {
      // Scoped to the Orders table. The list totals beneath it legitimately
      // repeat 0.08 as the outstanding sum of the one listed Order, so an
      // unscoped lookup now matches twice -- which says nothing about whether
      // the ROW shows the current balance or the original amount due.
      const table = within(dialog).getAllByRole("table")[0]!;
      expect(within(table).getByText("0.08")).toBeInTheDocument();
    });
  });

  /**
   * Totals and select-all on the eligible-Orders list.
   *
   * Deciding what to pay meant reading Outstanding Balance down the column and
   * adding it up by eye, then ticking each row one at a time. Both figures are
   * now shown, and both describe the LISTED Orders -- the same rows select-all
   * ticks -- so the number beside the checkbox always matches what it does.
   */
  describe("eligible Orders totals", () => {
    const twoOrders = {
      items: [
        { ...eligibleOrder, id: "order-1", outstandingBalance: "130.00", serialNumber: "SER-1" },
        { ...eligibleOrder, id: "order-2", outstandingBalance: "180.00", serialNumber: "SER-2" },
      ],
      page: 1,
      pageSize: 200,
      total: 2,
    };
    /** The per-Order checkboxes only -- never the header one or a filter. */
    const rowCheckboxes = (dialog: ReturnType<typeof within>) =>
      within(dialog.getAllByRole("table")[0]!)
        .getAllByRole("checkbox")
        .filter((box) => box.getAttribute("aria-label") !== "Select all listed Orders");

    const openWithTwoOrders = async () => {
      visit("?traderId=trader-1&openDialog=new_settlement");
      setup({
        getExtra: (path: string) =>
          path.startsWith("operations/settlements/payments/eligible-orders")
            ? twoOrders
            : undefined,
      });
      const dialog = within(await screen.findByRole("dialog"));
      /* Wait for the Orders to be LISTED, not merely for the dialog. The header
         checkbox renders immediately but is disabled until there is something to
         tick, and clicking a disabled checkbox does nothing -- so a test that
         clicks as soon as it appears silently asserts against an empty list. */
      await dialog.findByText(/Orders? listed/);
      return dialog;
    };

    it("totals the outstanding balance of the listed Orders", async () => {
      const dialog = await openWithTwoOrders();
      // 130.00 + 180.00, added for the operator rather than by them.
      expect(await dialog.findByText(/2 Orders listed, outstanding/)).toBeInTheDocument();
      expect(dialog.getByText("310.00")).toBeInTheDocument();
    });

    it("says nothing about a selection until one is made", async () => {
      const dialog = await openWithTwoOrders();
      await dialog.findByText(/2 Orders listed/);
      // An untouched form reporting "0 Orders selected" is noise.
      expect(dialog.queryByText(/selected, total/)).toBeNull();
    });

    it("selects every listed Order from the header checkbox", async () => {
      const dialog = await openWithTwoOrders();
      const selectAll = await dialog.findByRole("checkbox", { name: "Select all listed Orders" });
      fireEvent.click(selectAll);

      await waitFor(() =>
        expect(dialog.getByText(/2 Orders selected, total/)).toBeInTheDocument(),
      );
      const rowBoxes = rowCheckboxes(dialog);
      expect(rowBoxes).toHaveLength(2);
      expect(rowBoxes.every((box) => (box as HTMLInputElement).checked)).toBe(true);
    });

    it("clears every listed Order from the same checkbox", async () => {
      const dialog = await openWithTwoOrders();
      const selectAll = await dialog.findByRole("checkbox", { name: "Select all listed Orders" });
      fireEvent.click(selectAll);
      await waitFor(() => expect(dialog.getByText(/2 Orders selected/)).toBeInTheDocument());

      fireEvent.click(selectAll);

      await waitFor(() => expect(dialog.queryByText(/selected, total/)).toBeNull());
    });

    it("counts and totals a partial selection", async () => {
      const dialog = await openWithTwoOrders();
      // Scoped to the Orders table: the filter bar above it has its own
      // "Outstanding Only" checkbox, and an unscoped lookup toggles that filter
      // instead of an Order, selecting nothing.
      const [firstRow] = rowCheckboxes(dialog);
      fireEvent.click(firstRow!);

      // One row, its own balance -- not the list total.
      await waitFor(() => expect(dialog.getByText(/1 Order selected, total/)).toBeInTheDocument());
      expect(dialog.getAllByText("130.00").length).toBeGreaterThan(0);
    });

    /**
     * Paying one Order out of several selected.
     *
     * The server proposes oldest-first, so a 50.00 payment against two selected
     * Orders comes back as a single proposed line on the older one. Moving that
     * 50.00 onto the OTHER Order is a legitimate thing to want, and it is what
     * the override checkbox exists for -- but two things made it look broken.
     */
    const payTheSecondOrderOnly = async () => {
      const dialog = await openWithTwoOrders();
      for (const box of rowCheckboxes(dialog)) fireEvent.click(box);
      fireEvent.change(dialog.getByLabelText("Payment Amount"), { target: { value: "50" } });
      /* Wait for the SERVER's proposal to land, not merely for the table.
         `manualOverride` is measured against that proposal, so editing before it
         arrives means editing nothing and the override never registers. */
      await dialog.findByDisplayValue("100.00");
      // Scoped to the allocation table (the second one) and matched as
      // spinbuttons: the amount fields are type="number", and Payment Amount
      // above is one too.
      const amounts = within(dialog.getAllByRole("table")[1]!).getAllByRole("spinbutton");
      // Take the proposal off the older Order and put it on the newer one.
      fireEvent.change(amounts[0]!, { target: { value: "0" } });
      fireEvent.change(amounts[1]!, { target: { value: "50" } });
      return dialog;
    };

    it("counts an unpaid selected Order in the remaining outstanding", async () => {
      const dialog = await payTheSecondOrderOnly();

      /* 100.00 still owed on the proposed Order left at zero -- the proposal's
         own `outstandingBefore` governs its line, by design -- plus 180.00 -
         50.00 on the Order actually being paid. 230.00.

         The figure used to iterate only the SERVER's proposed lines, so the
         second Order vanished from it entirely and this read 100.00: money still
         owed, missing from the very total that says whether a Trader is square. */
      await waitFor(() => {
        const label = dialog.getAllByText("Remaining Outstanding After Payment")[0]!;
        expect(label.nextElementSibling).toHaveTextContent("230.00");
      });
    });

    it("says that the override must be confirmed before anything can proceed", async () => {
      const dialog = await payTheSecondOrderOnly();

      // The warning explained what an override IS; it never said the settlement
      // stops until the box is ticked, so a blocked form read as a rejection.
      expect(
        await dialog.findByText(/the settlement cannot be confirmed until you do/i),
      ).toBeInTheDocument();
      expect(dialog.queryByText("Confirm Money Sent to Trader")).toBeNull();
    });

    it("lets the settlement proceed once the override is confirmed", async () => {
      const dialog = await payTheSecondOrderOnly();
      const override = await dialog.findByRole("checkbox", { checked: false, name: /oldest-first/i });
      fireEvent.click(override);

      await waitFor(() =>
        expect(dialog.getByText("Confirm Money Sent to Trader")).toBeInTheDocument(),
      );
      // And the notice retires with it.
      expect(dialog.queryByText(/cannot be confirmed until you do/i)).toBeNull();
    });

    it("ticks the header checkbox once every row is ticked by hand", async () => {
      const dialog = await openWithTwoOrders();
      const selectAll = (await dialog.findByRole("checkbox", {
        name: "Select all listed Orders",
      })) as HTMLInputElement;
      expect(selectAll.checked).toBe(false);

      for (const box of rowCheckboxes(dialog)) fireEvent.click(box);

      // Reflects the rows rather than only its own clicks, so it never claims a
      // partial selection is complete or a complete one is partial.
      await waitFor(() => expect(selectAll.checked).toBe(true));
    });
  });

  /**
   * The Trader Account Statement's row filters.
   *
   * Paid only / Outstanding only / Reversed only are applied by the SERVER, so
   * the statement has to be re-requested for a change to have any effect. It was
   * not: ticking a box updated local state and nothing else, so the operator saw
   * the same statement and reasonably concluded the filters were broken.
   *
   * These assert the REQUEST, because that is where the defect was. Whether the
   * server then filters correctly is its own concern, covered on that side.
   */
  describe("account statement filters", () => {
    const statementCalls = (api: { get: { mock: { calls: unknown[][] } } }) =>
      api.get.mock.calls.map(([path]) => String(path)).filter((path) => path.includes("statement"));

    /* A real statement shape. The generic mock answers every unknown path with a
       paged envelope, which this dialog cannot render -- it reads
       `summary.openingBalance` and friends, so the component threw and took the
       filter checkboxes down with it. */
    const statementResponse = {
      generatedAt: "08 Aug 2026, 16:00",
      period: { from: "2026-08-01", to: "2026-08-31" },
      summary: {
        closingBalance: "0.00",
        codCollected: "0.00",
        deliveredOrderCount: 0,
        netPayments: "0.00",
        openingBalance: "0.00",
        outstandingAmount: "0.00",
        outstandingOrderCount: 0,
        partiallySettledOrderCount: 0,
        serviceFeesDeducted: "0.00",
        settledOrderCount: 0,
        totalPayable: "0.00",
        totalPayments: "0.00",
        totalReversals: "0.00",
      },
      trader: { id: "trader-1", nameEn: "Test Trader", number: "TRD-001" },
      transactions: [],
      warnings: [],
    };

    /** Opens the dialog; `generate` false stops before the first request. */
    const openStatement = async (generate = true) => {
      const { api } = setup({
        getExtra: (path: string) =>
          path.includes("account-statement") ? statementResponse : undefined,
      });
      fireEvent.click(await screen.findByRole("button", { name: "Trader Account Statement" }));
      const dialog = within(await screen.findByRole("dialog"));
      /* A Trader is required before anything is requested: `load()` returns
         early without one, so a test that skips this asserts against zero calls
         no matter what the filters do. The month defaults to the current one. */
      await waitFor(() => expect(dialog.getByRole("option", { name: "Test Trader" })).toBeTruthy());
      fireEvent.change(dialog.getByLabelText("Trader"), { target: { value: "trader-1" } });
      if (generate) fireEvent.click(dialog.getByRole("button", { name: "Generate Statement" }));
      return { api, dialog };
    };

    it("re-requests the statement when Paid only is ticked", async () => {
      const { api, dialog } = await openStatement();
      await waitFor(() => expect(statementCalls(api).length).toBeGreaterThan(0));
      const before = statementCalls(api).length;

      fireEvent.click(dialog.getByRole("checkbox", { name: "Paid only" }));

      await waitFor(() => expect(statementCalls(api).length).toBeGreaterThan(before));
      expect(statementCalls(api).at(-1)).toContain("paidOnly=true");
    });

    it("carries Outstanding only and Reversed only into the request", async () => {
      const { api, dialog } = await openStatement();

      fireEvent.click(dialog.getByRole("checkbox", { name: "Outstanding Only" }));
      await waitFor(() => expect(statementCalls(api).at(-1)).toContain("outstandingOnly=true"));

      fireEvent.click(dialog.getByRole("checkbox", { name: "Reversed only" }));
      await waitFor(() => expect(statementCalls(api).at(-1)).toContain("reversedOnly=true"));
    });

    it("drops the flag from the request when the box is unticked", async () => {
      const { api, dialog } = await openStatement();
      const paidOnly = dialog.getByRole("checkbox", { name: "Paid only" });

      fireEvent.click(paidOnly);
      await waitFor(() => expect(statementCalls(api).at(-1)).toContain("paidOnly=true"));
      fireEvent.click(paidOnly);

      // Absent, not "false": `Boolean("false")` is true on the server side.
      await waitFor(() => expect(statementCalls(api).at(-1)).not.toContain("paidOnly"));
    });

    it("does not request anything before the first Generate Statement", async () => {
      const { api, dialog } = await openStatement(false);

      fireEvent.click(dialog.getByRole("checkbox", { name: "Paid only" }));

      // Nothing is on screen to refresh, and the Trader and period are chosen
      // deliberately rather than reactively.
      await waitFor(() => expect(statementCalls(api)).toHaveLength(0));
    });
  });

  it("reports an originating Order that is no longer eligible rather than forcing it", async () => {
    visit("?traderId=trader-1&orderId=order-gone&openDialog=new_settlement");
    setup();
    expect(
      await screen.findByText(/no longer eligible for Trader settlement/i),
    ).toBeInTheDocument();
  });

  it("leaves nothing selected when no Order was supplied", async () => {
    visit("?traderId=trader-1&openDialog=new_settlement");
    setup();
    const dialog = await screen.findByRole("dialog");
    // queryAll, because a dialog with no rendered rows yet legitimately has no
    // checkboxes at all -- the assertion is that none is CHECKED.
    await waitFor(() => {
      const checked = within(dialog)
        .queryAllByRole("checkbox")
        .filter((box) => (box as HTMLInputElement).checked);
      expect(checked).toHaveLength(0);
    });
  });
});
