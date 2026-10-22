import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import "../../localization/i18n.js";
import { OneScreenSettlementDialog } from "./OneScreenSettlementDialog.js";

const page = <T,>(items: readonly T[]) => ({ items, page: 1, pageSize: 200, total: items.length });

function setup() {
  const posts: { body: unknown; path: string }[] = [];
  const api = {
    get: vi.fn((path: string) => {
      if (path === "operations/traders") {
        return Promise.resolve([
          { code: "TRD-1", id: "trader-1", mobileNumber: "", name: "ARMAN ABYA", openOrders: 1, status: "active", totalOrders: 1, unsettledNetPayable: "300.00" },
        ]);
      }
      if (path.startsWith("operations/accounting/cash-bank/cash-accounts")) {
        return Promise.resolve([{ id: "cash-1", name: "Main cash" }]);
      }
      if (path === "configuration/bank-accounts") return Promise.resolve([]);
      if (path.startsWith("configuration/traders/")) return Promise.resolve([]);
      if (path.startsWith("operations/settlements/payments/eligible-orders")) {
        return Promise.resolve(
          page([
            { additionalFees: "0.00", areaName: "Deira", codAmount: "300.00", customerMobileNumber: "0501", customerName: "Customer A", deliveryDate: "2026-10-21", emirateName: "Dubai", id: "order-1", orderNumber: "ORD-001", outstandingBalance: "279.00", referenceNumber: "5183", totalDeductions: "21.00" },
            { additionalFees: "0.00", areaName: "Deira", codAmount: "100.00", customerMobileNumber: "0502", customerName: "Customer B", deliveryDate: "2026-10-21", emirateName: "Dubai", id: "order-2", orderNumber: "ORD-002", outstandingBalance: "84.00", referenceNumber: "5184", totalDeductions: "16.00" },
          ]),
        );
      }
      if (path.startsWith("operations/trader-receivables/eligible")) {
        return Promise.resolve(
          page([
            { businessDate: "2026-10-21", id: "rcv-1", orderNumber: "ORD-003", outstandingAmount: "25.00", reason: "Order service fee owed by Trader", receivableNumber: "RCV-000070", sourceReference: "ORD-003" },
          ]),
        );
      }
      if (path.startsWith("operations/settlements/payments/open-credits")) return Promise.resolve([]);
      if (path === "operations/settlements/payments/open-traders") {
        return Promise.resolve([
          { code: "TRD-1", creditCount: 0, credits: "0.00", feeCount: 1, fees: "25.00", name: "ARMAN ABYA", net: "338.00", payCount: 2, toPay: "363.00", traderId: "trader-1", zeroCount: 1 },
        ]);
      }
      if (path.startsWith("operations/settlements/payments/zero-due-orders")) {
        return Promise.resolve([
          { additionalFees: "0.00", areaName: "Al Aahad", codAmount: "15.00", customerMobileNumber: "0503", customerName: "Customer C", deliveryDate: "2026-10-21", emirateName: "Dubai", id: "zero-1", orderNumber: "ORD-001377", printedOnSettlementNumber: "SET-000155", referenceNumber: "04980", serviceFee: "16.00" },
        ]);
      }
      return Promise.resolve(page([]));
    }),
    getBinary: vi.fn(),
    patch: vi.fn(),
    post: vi.fn((path: string, body?: unknown) => {
      posts.push({ body, path });
      if (path === "operations/settlements/drafts") {
        return Promise.resolve({ id: "draft-1", payload: body, status: "draft", traderId: "trader-1", traderName: "ARMAN ABYA" });
      }
      if (path.endsWith("/confirm")) return Promise.resolve({ settlementId: "settlement-9" });
      return Promise.resolve({});
    }),
    postBinary: vi.fn(),
  };
  const onPosted = vi.fn();
  render(
    <OneScreenSettlementDialog
      api={api as unknown as ApiClient}
      onClose={vi.fn()}
      onDraftSaved={vi.fn()}
      onPosted={onPosted}
      reportLanguage="en"
    />,
  );
  return { api, onPosted, posts };
}

describe("One-screen Trader Settlement", () => {
  it("opens on the Traders with something to invoice, with their amounts", async () => {
    setup();
    const dialog = within(await screen.findByRole("dialog"));
    const row = (await dialog.findByRole("button", { name: "ARMAN ABYA (TRD-1)" })).closest("tr")!;
    expect(row.textContent).toContain("363.00");
    expect(row.textContent).toContain("−25.00");
    expect(row.textContent).toContain("338.00");
    fireEvent.change(dialog.getByLabelText("Search Trader name or code"), { target: { value: "zzz" } });
    expect(await dialog.findByText("No Trader has anything left to invoice.")).toBeInTheDocument();
  });

  it("lists orders to pay, Trader fees and 0-due orders in one table, with the totals at the end", async () => {
    setup();
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(await dialog.findByRole("button", { name: "ARMAN ABYA (TRD-1)" }));
    await dialog.findByText("5183");
    expect(dialog.getByText("RCV-000070")).toBeInTheDocument();
    expect(dialog.getByText("Prints on SET-000155")).toBeInTheDocument();
    // Orders and fees are ticked; the 0-due order is not.
    await waitFor(() => expect(dialog.getByRole("checkbox", { name: "Include 5183" })).toBeChecked());
    expect(dialog.getByRole("checkbox", { name: "Include ORD-003" })).toBeChecked();
    expect(dialog.getByRole("checkbox", { name: "Include 04980" })).not.toBeChecked();
    // 279 + 84 - 25 = 338
    const totals = dialog.getByRole("status");
    expect(totals.textContent).toContain("363.00");
    expect(totals.textContent).toContain("−25.00");
    expect(totals.textContent).toContain("338.00");
    // Unticking a fee raises the net.
    fireEvent.click(dialog.getByRole("checkbox", { name: "Include ORD-003" }));
    await waitFor(() => expect(dialog.getByRole("status").textContent).toContain("363.00"));
  });

  it("posts the ticked lines in full, with the 0-due order printed at 0.00", async () => {
    const { onPosted, posts } = setup();
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(await dialog.findByRole("button", { name: "ARMAN ABYA (TRD-1)" }));
    await dialog.findByText("5183");
    fireEvent.click(dialog.getByRole("checkbox", { name: "Include 04980" }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(dialog.getByRole("button", { name: /Post payment/ }));
    await waitFor(() => expect(onPosted).toHaveBeenCalledWith("settlement-9"));
    const draft = posts.find((call) => call.path === "operations/settlements/drafts")!.body as Record<string, unknown>;
    expect(draft).toMatchObject({
      allocations: [
        { amount: 279, orderId: "order-1" },
        { amount: 84, orderId: "order-2" },
      ],
      amount: 338,
      cashAccountId: "cash-1",
      receivableOffsets: [{ amount: 25, receivableId: "rcv-1" }],
      traderId: "trader-1",
      zeroDueOrderIds: ["zero-1"],
    });
    expect(posts.some((call) => call.path === "operations/settlements/drafts/draft-1/confirm")).toBe(true);
  });

  it("pays part of an order when Edit amounts is on", async () => {
    const { posts } = setup();
    const dialog = within(await screen.findByRole("dialog"));
    fireEvent.click(await dialog.findByRole("button", { name: "ARMAN ABYA (TRD-1)" }));
    await dialog.findByText("5183");
    fireEvent.click(dialog.getByLabelText("Edit amounts (partial payment)"));
    fireEvent.change(dialog.getByLabelText("Amount for 5183"), { target: { value: "100" } });
    await waitFor(() => expect(dialog.getByRole("status").textContent).toContain("159.00"));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(dialog.getByRole("button", { name: /Post payment/ }));
    await waitFor(() => expect(posts.some((call) => call.path.endsWith("/confirm"))).toBe(true));
    const draft = posts.find((call) => call.path === "operations/settlements/drafts")!.body as {
      allocations: unknown;
      amount: number;
    };
    expect(draft.amount).toBe(159);
    expect(draft.allocations).toEqual([
      { amount: 100, orderId: "order-1" },
      { amount: 84, orderId: "order-2" },
    ]);
  });
});
