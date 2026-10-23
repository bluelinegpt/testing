import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import "../../localization/i18n.js";
import {
  OrderCorrectionDialog,
  OrderCorrectionHistorySection,
  type OrderCorrectionPreview,
} from "./OrderCorrectionPanels.js";

const preview: OrderCorrectionPreview = {
  blockers: [],
  canCorrect: true,
  collection: {
    amount: "270.00",
    otherOrderCount: 21,
    paymentMethod: "cash",
    receivedAfterCorrection: "4943.00",
    receivedAsConfirmed: "5213.00",
    reconciliationNumber: "REC-000052",
  },
  driverName: "Driver 17",
  orderNumber: "ORD-000212",
  recoveryTotal: "250.00",
  referenceNumber: "4353",
  serialNumber: "ORD-000212",
  settlements: [{ amountPaid: "250.00", otherOrderCount: 9, settlementNumber: "SET-000150" }],
  traderName: "Collection Abaya",
  warnings: [{ code: "order_correction_driver_fee", message: "The Driver's delivery fee (15.00) is reversed automatically." }],
  zeroDueDocuments: [],
};

function apiWith(previewData: OrderCorrectionPreview) {
  const posts: { body: unknown; path: string }[] = [];
  const api = {
    get: vi.fn(() => Promise.resolve(previewData)),
    getBinary: vi.fn(() => Promise.resolve(new Blob(["%PDF"]))),
    post: vi.fn((path: string, body?: unknown) => {
      posts.push({ body, path });
      return Promise.resolve({ correctionNumber: "DCX-000001", recoveryReceivableNumbers: ["RCV-000101"] });
    }),
  };
  return { api: api as unknown as ApiClient & typeof api, posts };
}

describe("Order correction (DCX)", () => {
  it("shows what is taken off each document and needs a reason and the final check", async () => {
    const { api, posts } = apiWith(preview);
    const onCorrected = vi.fn();
    render(<OrderCorrectionDialog api={api} onClose={vi.fn()} onCorrected={onCorrected} orderId="order-1" />);
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText("Driver collection REC-000052")).toBeInTheDocument();
    expect(dialog.getByText("Trader settlement SET-000150")).toBeInTheDocument();
    expect(dialog.getByText(/21 other Orders stay on it/)).toBeInTheDocument();
    expect(dialog.getByText(/Total to recover from the Trader/)).toBeInTheDocument();
    expect(dialog.getByText(/delivery fee \(15.00\)/)).toBeInTheDocument();
    const submit = dialog.getByRole("button", { name: "Make correction" });
    expect(submit).toBeDisabled();
    fireEvent.change(dialog.getByLabelText("Reason (printed on the amended documents)"), {
      target: { value: "Not delivered, marked by mistake" },
    });
    expect(submit).toBeDisabled();
    fireEvent.click(dialog.getByRole("checkbox"));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(onCorrected).toHaveBeenCalledWith(expect.stringContaining("DCX-000001")));
    expect(onCorrected).toHaveBeenCalledWith(expect.stringContaining("RCV-000101"));
    expect(posts).toEqual([
      { body: { reason: "Not delivered, marked by mistake" }, path: "operations/orders/order-1/corrections" },
    ]);
  });

  it("does not offer the correction when something blocks it", async () => {
    const { api } = apiWith({
      ...preview,
      blockers: [{ code: "order_correction_requires_delivered", message: "Only a Delivered Order can be corrected." }],
      canCorrect: false,
    });
    render(<OrderCorrectionDialog api={api} onClose={vi.fn()} onCorrected={vi.fn()} orderId="order-1" />);
    const dialog = within(await screen.findByRole("dialog"));
    expect(await dialog.findByText("Only a Delivered Order can be corrected.")).toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Make correction" })).toBeNull();
  });

  it("shows on the Order every document it was removed from, with a print of the original", async () => {
    const api = {
      get: vi.fn(() =>
        Promise.resolve([
          {
            collectionAmount: "270.00",
            correctedAt: "2026-10-23T08:00:00.000Z",
            correctedBy: "aiman",
            correctionId: "c-1",
            correctionNumber: "DCX-000001",
            lines: [
              { amount: "270.00", documentId: "rec-52", documentNumber: "REC-000052", kind: "driver_collection", recoveryReceivableNumber: null },
              { amount: "250.00", documentId: "set-150", documentNumber: "SET-000150", kind: "trader_settlement", recoveryReceivableNumber: "RCV-000101" },
            ],
            reason: "Not delivered",
            recoveredAmount: "250.00",
          },
        ]),
      ),
      getBinary: vi.fn(() => Promise.resolve(new Blob(["%PDF"]))),
    };
    vi.spyOn(window, "open").mockReturnValue(null);
    render(
      <OrderCorrectionHistorySection api={api as unknown as ApiClient} orderId="order-1" reportLanguage="en" />,
    );
    expect(await screen.findByText("DCX-000001")).toBeInTheDocument();
    expect(screen.getAllByText("Removed — not valid for this Order")).toHaveLength(2);
    expect(screen.getByText(/to recover as RCV-000101/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "View original" })[1]!);
    await waitFor(() =>
      expect(api.getBinary).toHaveBeenCalledWith(
        "operations/settlements/payments/set-150/pdf?language=en&version=original",
      ),
    );
  });
});
