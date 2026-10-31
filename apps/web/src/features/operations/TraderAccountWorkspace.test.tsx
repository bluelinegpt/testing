import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import "../../localization/i18n.js";
import { TraderAccountWorkspace } from "./TraderAccountWorkspace.js";

const accounts = {
  items: [
    {
      awaitingDriverCash: 0, balance: "170.00", code: "TRD-1", isActive: true,
      lastPaymentAmount: "330.00", lastPaymentDate: "2026-10-20", lastPaymentNumber: "SET-000147",
      nameAr: null, nameEn: "BERVAZ", openReceivables: "0.00", ordersWaiting: 2, traderId: "trader-1",
    },
    {
      awaitingDriverCash: 1, balance: "-32.00", code: "TRD-2", isActive: true,
      lastPaymentAmount: null, lastPaymentDate: null, lastPaymentNumber: null,
      nameAr: null, nameEn: "Faisal Abaya", openReceivables: "32.00", ordersWaiting: 8, traderId: "trader-2",
    },
  ],
  totals: { owedByTraders: "32.00", owedToTraders: "170.00" },
};

function setup(permissions: readonly string[] = ["settlements.create", "settlements.reverse"]) {
  const api = {
    get: vi.fn((path: string) => {
      if (path.startsWith("operations/trader-accounts?")) return Promise.resolve(accounts);
      if (path === "operations/trader-accounts/trader-1/documents") {
        return Promise.resolve([
          { amount: "0.00", date: "2026-10-30", draftId: "draft-1", id: "inv-1", kind: "zero_invoice", number: "INV-000017", orderCount: 3, reversed: false },
          { amount: "10.00", date: "2026-10-29", draftId: "draft-2", id: "col-1", kind: "collection", number: "COL-000028", orderCount: 2, reversed: false },
          { amount: "330.00", date: "2026-10-20", draftId: null, id: "set-1", kind: "settlement", number: "SET-000147", orderCount: 3, reversed: false },
        ]);
      }
      if (path.includes("/account-statement?")) {
        return Promise.resolve({
          generatedAt: "", period: { from: "2026-10-01", to: "2026-10-31" },
          summary: {
            closingBalance: "170.00", codCollected: "0.00", deliveredOrderCount: 0, netPayments: "0.00",
            openingBalance: "0.00", outstandingAmount: "170.00", outstandingOrderCount: 0,
            partiallySettledOrderCount: 0, serviceFeesDeducted: "0.00", settledOrderCount: 0,
            totalPayable: "0.00", totalPayments: "0.00", totalReversals: "0.00",
          },
          trader: { id: "trader-1", nameEn: "BERVAZ", number: "TRD-1" },
          transactions: [],
          warnings: [],
        });
      }
      return Promise.resolve([]);
    }),
    getBinary: vi.fn(),
    post: vi.fn(),
    postBinary: vi.fn(),
  };
  const onNavigate = vi.fn();
  render(
    <TraderAccountWorkspace
      api={api as unknown as ApiClient}
      onNavigate={onNavigate}
      permissions={permissions}
    />,
  );
  return { api, onNavigate };
}

describe("Trader Account", () => {
  it("lists each Trader's balance in plain words, open balances only by default", async () => {
    const { api } = setup();
    expect(await screen.findByText("BERVAZ")).toBeVisible();
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith("operations/trader-accounts?openOnly=true"),
    );
    const owed = screen.getByTestId("trader-account-balance-TRD-1");
    expect(owed).toHaveTextContent("170.00");
    expect(owed).toHaveTextContent("We owe the Trader");
    const owes = screen.getByTestId("trader-account-balance-TRD-2");
    expect(owes).toHaveTextContent("32.00");
    expect(owes).toHaveTextContent("The Trader owes us");
    expect(screen.getByText(/SET-000147/)).toBeVisible();
  });

  it("opens the Trader's statement for the current month straight away", async () => {
    const { api } = setup();
    const row = (await screen.findByText("BERVAZ")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Statement" }));
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        expect.stringMatching(/^operations\/settlements\/payments\/traders\/trader-1\/account-statement\?.*month=/),
      ),
    );
  });

  it("shows SET, INV and COL documents with View, Print and Un-post", async () => {
    const { onNavigate } = setup();
    const row = (await screen.findByText("BERVAZ")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Documents" }));
    const dialog = await screen.findByRole("dialog", { name: /Documents/ });
    const settlement = (await within(dialog).findByText("SET-000147")).closest("tr")!;
    fireEvent.click(within(settlement).getByRole("button", { name: "View" }));
    expect(onNavigate).toHaveBeenCalledWith("/trader-settlements/set-1");
    const invoice = within(dialog).getByText("INV-000017").closest("tr")!;
    expect(within(invoice).queryByRole("button", { name: "View" })).not.toBeInTheDocument();
    expect(within(invoice).getByRole("button", { name: "Print" })).toBeVisible();
    expect(within(invoice).getByRole("button", { name: "Un-post" })).toBeVisible();
  });

  it("offers Settle only to users who can settle", async () => {
    setup(["reports.export"]);
    const row = (await screen.findByText("BERVAZ")).closest("tr")!;
    expect(within(row).queryByRole("button", { name: "Settle" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Settle now" })).not.toBeInTheDocument();
  });
});
