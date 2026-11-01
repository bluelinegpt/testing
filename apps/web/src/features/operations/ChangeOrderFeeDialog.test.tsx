import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApiError, type ApiClient } from "../../api/api-client.js";
import "../../localization/i18n.js";
import { ChangeOrderFeeDialog } from "./ChangeOrderFeeDialog.js";

const order = { additionalFees: "25.00", id: "o-1", orderNumber: "ORD-001805", referenceNumber: "4283", serviceFee: "25.00" };

describe("Change fee after delivery", () => {
  it("sends the new fees with a reason and says the draft was updated", async () => {
    const post = vi.fn(() =>
      Promise.resolve({ additionalFees: "40.00", draftUpdated: true, orderNumber: "ORD-001805", receivableNumber: "RCV-000120", serviceFee: "25.00" }),
    );
    const onSaved = vi.fn();
    render(<ChangeOrderFeeDialog api={{ post } as unknown as ApiClient} onClose={vi.fn()} onSaved={onSaved} order={order} />);
    expect(screen.getByRole("dialog", { name: "Change fee — 4283" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("Additional Fees"), { target: { value: "40" } });
    expect(screen.getByTestId("change-fee-total")).toHaveTextContent("50.00 → 65.00");
    const save = screen.getByRole("button", { name: "Save new fee" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason (required)"), { target: { value: "2 more boxes" } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("operations/orders/o-1/change-fee", {
        additionalFees: 40,
        reason: "2 more boxes",
        serviceFee: 25,
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Fee of ORD-001805 changed to 65.00.");
    expect(screen.getByRole("status")).toHaveTextContent("open draft was updated");
    expect(onSaved).toHaveBeenCalled();
  });

  it("shows the server's reason when the fee was already collected", async () => {
    const post = vi.fn(() =>
      Promise.reject(new ApiError("This fee was already collected from the Trader on COL-000025. Un-post that receipt first, then change the fee.", "order_fee_has_collections", 409)),
    );
    render(<ChangeOrderFeeDialog api={{ post } as unknown as ApiClient} onClose={vi.fn()} onSaved={vi.fn()} order={order} />);
    fireEvent.change(screen.getByLabelText("Additional Fees"), { target: { value: "40" } });
    fireEvent.change(screen.getByLabelText("Reason (required)"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save new fee" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Un-post that receipt first");
  });
});
