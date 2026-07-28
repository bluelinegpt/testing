import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { DriverCollectionsWorkspace } from "./DriverCollectionsWorkspace.js";

const summary = {
  actualAmountReceived: "500.00",
  cashTotal: "300.00",
  collectionsWithDifferenceCount: 0,
  driverExpenses: "20.00",
  netExpectedFromDrivers: "480.00",
  outstandingFromDrivers: "150.00",
  pendingAmountToCollect: "150.00",
  pendingOrderCount: 3,
  reconciledCollectionsCount: 4,
  visaTotal: "200.00",
};

const collectionRow = {
  businessDate: "2026-07-27",
  collectionPaymentMethod: "cash" as const,
  confirmedAt: "2026-07-27T11:00:00.000Z",
  confirmedBy: "ops.user",
  driverName: "Test Driver",
  driverType: "outsourced",
  expenseTotal: "0.00",
  grossCollections: "100.00",
  id: "rec-1",
  isReversed: false,
  netAmountReceived: "100.00",
  orderCount: 1,
  paymentTotal: "100.00",
  reconciliationNumber: "REC-000123",
  status: "confirmed",
  statusLabel: "Confirmed",
};

const driver = {
  driverType: "outsourced",
  id: "drv-1",
  name: "Test Driver",
  pendingCollectionTotal: "60.00",
  pendingOrderCount: 1,
};

const eligibleOrder = {
  amountCollected: "60.00",
  areaName: "Deira",
  cashStatus: "pending",
  cashStatusLabel: "Pending Collection",
  customerName: "Test Customer",
  deliveredAt: "2026-07-27",
  id: "order-1",
  orderNumber: "ORD-1",
  traderName: "Test Trader",
};

function setup(overrides: { readonly getExtra?: (path: string) => unknown } = {}) {
  const getCalls: string[] = [];
  const api = {
    get: vi.fn((path: string) => {
      getCalls.push(path);
      const extraFirst = overrides.getExtra?.(path);
      if (extraFirst !== undefined) return Promise.resolve(extraFirst);
      if (path.startsWith("operations/cash/reconciliations/summary")) {
        return Promise.resolve(summary);
      }
      if (path.startsWith("operations/cash/reconciliations?")) {
        return Promise.resolve({ items: [collectionRow], page: 1, pageSize: 25, total: 1 });
      }
      if (path.startsWith("operations/cash/drivers")) {
        return Promise.resolve({ items: [driver], page: 1, pageSize: 25, total: 1 });
      }
      if (path.startsWith("operations/traders/search")) {
        return Promise.resolve({ items: [{ id: "trader-1", nameEn: "Test Trader" }] });
      }
      if (path === "configuration/emirates") {
        return Promise.resolve([]);
      }
      if (path.startsWith("operations/cash/expense-types")) {
        return Promise.resolve([]);
      }
      if (path.startsWith("operations/cash/eligible-orders")) {
        return Promise.resolve({ items: [eligibleOrder], page: 1, pageSize: 25, total: 1 });
      }
      return Promise.resolve({ items: [], page: 1, pageSize: 25, total: 0 });
    }),
    getBinary: vi.fn(() => Promise.resolve(new Blob(["%PDF-fake"], { type: "application/pdf" }))),
    post: vi.fn((path: string, body?: unknown) => {
      if (path === "operations/cash/reconciliations/preview") {
        return Promise.resolve({
          difference: "0.00",
          driverId: driver.id,
          expenseTotal: "0.00",
          grossCollections: "60.00",
          netAmountExpected: "60.00",
          orderCount: 1,
          warnings: [],
        });
      }
      if (path === "operations/cash/reconciliations/selected") {
        return Promise.resolve({ reconciliationId: "rec-new", reconciliationNumber: "REC-000200" });
      }
      if (path.endsWith("/reverse")) {
        return Promise.resolve({});
      }
      void body;
      return Promise.resolve({});
    }),
  };
  render(<DriverCollectionsWorkspace api={api as unknown as ApiClient} />);
  return { api, getCalls };
}

describe("DriverCollectionsWorkspace", () => {
  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
  });

  it("shows the renamed Driver Collections title, not the old Drivers list", async () => {
    setup();
    expect((await screen.findAllByText("Driver Collections")).length).toBeGreaterThan(0);
  });

  it("renders exactly six primary summary cards from server-calculated totals, not a client computation", async () => {
    setup();
    const cards = await screen.findByTestId("collections-summary");
    // Every card value must be the literal server figure — never derived by
    // summing the currently-visible page of rows.
    function cardValue(label: string) {
      return within(cards).getByText(label).nextElementSibling?.textContent;
    }
    // Five plain cards plus the clickable Outstanding from Drivers drill-down button.
    expect(cards.querySelectorAll(".kpi-card")).toHaveLength(6);
    expect(cardValue("Cash Total")).toBe("300.00");
    expect(cardValue("Visa Total")).toBe("200.00");
    expect(cardValue("Driver Expenses")).toBe("20.00");
    expect(cardValue("Outstanding from Drivers")).toBe("150.00");
    expect(cardValue("Pending Amount to Collect")).toBe("150.00");
    expect(cardValue("Net Expected from Drivers")).toBe("480.00");
    // Actual Amount Received is not one of the six primary cards (§3).
    expect(within(cards).queryByText("Actual Amount Received")).not.toBeInTheDocument();
  });

  it("renders the three secondary indicators compactly, separate from the primary cards", async () => {
    setup();
    const secondary = await screen.findByTestId("collections-summary-secondary");
    function chipValue(label: string) {
      return within(secondary).getByText(label).nextElementSibling?.textContent;
    }
    expect(chipValue("Pending Orders")).toBe("3");
    expect(chipValue("Reconciled Collections")).toBe("4");
    expect(chipValue("Collections with Difference")).toBe("0");
  });

  it("sends filter changes to the backend as query parameters", async () => {
    const { api, getCalls } = setup();
    await screen.findByText("REC-000123");
    getCalls.length = 0;
    fireEvent.change(screen.getByLabelText("Order Serial Number"), {
      target: { value: "ORD-9" },
    });
    await waitFor(() =>
      expect(getCalls.some((call) => call.includes("orderSerialNumber=ORD-9"))).toBe(true),
    );
    expect(api.get).toHaveBeenCalled();
  });

  it("keeps the main filter row to the essential filters, moving the rest behind More Filters", async () => {
    setup();
    await screen.findByText("REC-000123");
    // Main row: kept filters visible without opening the drawer.
    expect(screen.getByLabelText("Driver")).toBeInTheDocument();
    expect(screen.getByLabelText("Payment method")).toBeInTheDocument();
    expect(screen.getByLabelText("Reconciliation Status")).toBeInTheDocument();
    expect(screen.getByLabelText("Collection Date From")).toBeInTheDocument();
    expect(screen.getByLabelText("Collection Date To")).toBeInTheDocument();
    expect(screen.getByLabelText("Order Serial Number")).toBeInTheDocument();
    expect(screen.getByLabelText("External Reference Number")).toBeInTheDocument();
    expect(screen.getByLabelText("Trader")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
    // Outstanding Only is not a reconciliation-list filter (§ Outstanding Only
    // correction) — completed reconciliations are never themselves "outstanding".
    expect(screen.queryByLabelText("Outstanding Only")).not.toBeInTheDocument();

    // Removed-by-default filters live in the collapsed <details> drawer — present
    // in the DOM (so the drawer never re-fetches on open) but not visible yet.
    const drawer = screen.getByText("More Filters").closest("details");
    expect(drawer).not.toHaveAttribute("open");
    expect(screen.getByLabelText("Driver type")).not.toBeVisible();
    expect(screen.getByLabelText("Customer")).not.toBeVisible();
    expect(screen.getByLabelText("Delivery Date From")).not.toBeVisible();
    expect(screen.getByLabelText("Delivery Date To")).not.toBeVisible();
    expect(screen.getByLabelText("Order Status")).not.toBeVisible();

    fireEvent.click(screen.getByText("More Filters"));
    expect(screen.getByLabelText("Driver type")).toBeInTheDocument();
    expect(screen.getByLabelText("Customer")).toBeInTheDocument();
    expect(screen.getByLabelText("Delivery Date From")).toBeInTheDocument();
    expect(screen.getByLabelText("Delivery Date To")).toBeInTheDocument();
    expect(screen.getByLabelText("Order Status")).toBeInTheDocument();
  });

  it("opens an Outstanding by Driver drill-down from the Outstanding from Drivers card", async () => {
    setup();
    await screen.findByText("REC-000123");
    fireEvent.click(
      screen.getByRole("button", { name: /Outstanding from Drivers/ }),
    );
    const dialog = within(await screen.findByRole("dialog"));
    expect(
      await dialog.findByText("Test Driver — Outsourced"),
    ).toBeInTheDocument();
    expect(dialog.getByText("Test Driver — Outsourced").closest("tr")?.textContent).toContain(
      "60.00",
    );
  });

  it("does not list a Driver with no outstanding Orders in the drill-down", async () => {
    setup({
      getExtra: (path) =>
        path.startsWith("operations/cash/drivers")
          ? {
              items: [{ ...driver, pendingCollectionTotal: "0.00", pendingOrderCount: 0 }],
              page: 1,
              pageSize: 100,
              total: 1,
            }
          : undefined,
    });
    await screen.findByText("REC-000123");
    fireEvent.click(
      screen.getByRole("button", { name: /Outstanding from Drivers/ }),
    );
    const dialog = within(await screen.findByRole("dialog"));
    await dialog.findByText("No Drivers currently have an outstanding balance.");
    expect(dialog.queryByText("Test Driver — Outsourced")).not.toBeInTheDocument();
  });

  it("never shows a required-field asterisk on any filter label", async () => {
    setup();
    await screen.findByText("REC-000123");
    const filters = screen.getByLabelText("Order Serial Number").closest("section");
    expect(filters?.textContent?.includes("*")).toBe(false);
  });

  it("places the Recent Reconciliations table immediately after the filters, before pagination", async () => {
    setup();
    await screen.findByText("REC-000123");
    const filterSection = screen.getByLabelText("Driver Collections filters");
    const tableHeading = screen.getByText("Recent reconciliations");
    // DOM order: filters, then the table section — not buried under extra content.
    expect(
      filterSection.compareDocumentPosition(tableHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("lists the collection row with a Reverse action for a confirmed, non-reversed row", async () => {
    setup();
    await screen.findByText("REC-000123");
    expect(screen.getByRole("button", { name: "Reverse" })).toBeInTheDocument();
  });

  it("does not offer Reverse for an already-reversed collection", async () => {
    setup({
      getExtra: (path) =>
        path.startsWith("operations/cash/reconciliations?")
          ? {
              items: [{ ...collectionRow, isReversed: true }],
              page: 1,
              pageSize: 25,
              total: 1,
            }
          : undefined,
    });
    await screen.findByText("REC-000123");
    expect(screen.queryByRole("button", { name: "Reverse" })).not.toBeInTheDocument();
  });

  it("drops Driver Type from the main table and offers Preview Report / Download PDF row actions", async () => {
    setup();
    await screen.findByText("REC-000123");
    const table = screen.getByRole("table");
    expect(within(table).queryByText("Driver Type")).not.toBeInTheDocument();
    expect(within(table).getByText("Collection Date")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview Report" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download PDF" })).toBeInTheDocument();
  });

  describe("Create Driver Collection dialog", () => {
    async function openCreateDialog() {
      setup();
      fireEvent.click(await screen.findByRole("button", { name: "New Collection" }));
      fireEvent.click(await screen.findByText("Test Driver — Outsourced"));
      return screen.getByRole("dialog");
    }

    it("shows Payment Method before Driver Expenses in the DOM order (§2)", async () => {
      await openCreateDialog();
      const headings = (await screen.findAllByRole("heading", { level: 3 })).map(
        (heading) => heading.textContent,
      );
      const paymentIndex = headings.indexOf("Payment method");
      const expensesIndex = headings.indexOf("Driver Expenses");
      expect(paymentIndex).toBeGreaterThanOrEqual(0);
      expect(expensesIndex).toBeGreaterThan(paymentIndex);
    });

    it("changing Payment Method clears the Order selection (Cash/Visa cannot mix)", async () => {
      const dialog = await openCreateDialog();
      const checkbox = await screen.findByRole("checkbox", { name: /ORD-1/ });
      fireEvent.click(checkbox);
      expect(checkbox).toBeChecked();
      fireEvent.change(within(dialog).getByLabelText("Payment method"), {
        target: { value: "visa" },
      });
      await waitFor(() => expect(checkbox).not.toBeChecked());
    });

    it("shows a negative Difference and an empty Actual Received before any entry", async () => {
      await openCreateDialog();
      fireEvent.click(await screen.findByRole("checkbox", { name: /ORD-1/ }));
      const actualReceived = (await screen.findByLabelText(
        "Actual Amount Received",
      )) as HTMLInputElement;
      // Net Expected is 60.00 (the preview mock's gross collections, no expenses);
      // Actual Received is never pre-filled, so the Difference reads -60.00 until
      // the operator enters what the Driver actually handed over.
      expect(actualReceived.value).toBe("");
      await screen.findByText("-60.00");
      expect(screen.getByRole("button", { name: "Confirm reconciliation" })).toBeDisabled();
    });

    it("blocks confirmation when Actual Received leaves a non-zero Difference", async () => {
      await openCreateDialog();
      fireEvent.click(await screen.findByRole("checkbox", { name: /ORD-1/ }));
      await screen.findByLabelText("Actual Amount Received");
      fireEvent.change(screen.getByLabelText("Actual Amount Received"), {
        target: { value: "10" },
      });
      await screen.findByText("Difference must be exactly AED 0.00 before confirming.");
      expect(screen.getByRole("button", { name: "Confirm reconciliation" })).toBeDisabled();
    });

    it("confirms with zero Difference and shows the Reconciliation Number on success", async () => {
      const dialog = within(await openCreateDialog());
      fireEvent.click(await screen.findByRole("checkbox", { name: /ORD-1/ }));
      // Actual Received is never pre-filled — enter the exact Net Expected (60.00)
      // to bring the Difference to zero.
      await screen.findByLabelText("Actual Amount Received");
      fireEvent.change(screen.getByLabelText("Actual Amount Received"), {
        target: { value: "60" },
      });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Confirm reconciliation" })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Confirm reconciliation" }));
      // The redesigned success view (§13) shows the Reconciliation Number both in
      // the confirmation message and in the summary list, plus Preview/Print/
      // Download/Done actions rather than a single bare Print button.
      expect((await dialog.findAllByText(/REC-000200/)).length).toBeGreaterThanOrEqual(2);
      expect(dialog.getByRole("button", { name: "Preview Report" })).toBeInTheDocument();
      expect(dialog.getByRole("button", { name: "Print" })).toBeInTheDocument();
      expect(dialog.getByRole("button", { name: "Download PDF" })).toBeInTheDocument();
    });
  });

  describe("Reversal", () => {
    it("requires a reason before Confirm Reversal is enabled, and calls the reverse endpoint", async () => {
      const { api } = setup();
      await screen.findByText("REC-000123");
      fireEvent.click(screen.getByRole("button", { name: "Reverse" }));
      const confirmButton = await screen.findByRole("button", { name: "Confirm Reversal" });
      expect(confirmButton).toBeDisabled();
      fireEvent.change(screen.getByLabelText("Reason for Reversal"), {
        target: { value: "Wrong Driver selected" },
      });
      expect(confirmButton).toBeEnabled();
      fireEvent.click(confirmButton);
      await waitFor(() =>
        expect(api.post).toHaveBeenCalledWith(
          "operations/cash/reconciliations/rec-1/reverse",
          { reason: "Wrong Driver selected" },
        ),
      );
    });

    it("refreshes the list and summary after a successful reversal", async () => {
      const { api } = setup();
      await screen.findByText("REC-000123");
      const callsBefore = api.get.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Reverse" }));
      fireEvent.change(await screen.findByLabelText("Reason for Reversal"), {
        target: { value: "Corrective reversal" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Confirm Reversal" }));
      await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(callsBefore));
    });
  });
});
