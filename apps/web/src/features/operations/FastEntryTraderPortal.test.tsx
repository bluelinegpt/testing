import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import "../../localization/i18n.js";
import { FastOrderEntryDialog } from "./OrdersModuleWorkspace.js";

const area = {
  code: "AR-1", emirateCode: "SHJ", emirateId: "emirate-shj", emirateNameAr: "الشارقة", emirateNameEn: "Sharjah",
  id: "area-1", isActive: true, nameAr: "التعاون", nameEn: "Al Taawun", notes: null, updatedAt: "2026-10-01",
};

describe("Fast Entry in the Trader portal", () => {
  it("loads the sheet for the signed-in Trader and creates his orders through the portal", async () => {
    const api = {
      get: vi.fn((path: string) =>
        Promise.resolve(
          path === "portal/trader/areas"
            ? [{ emirateId: "emirate-shj", emirateNameAr: "الشارقة", emirateNameEn: "Sharjah", id: "area-1", nameAr: "التعاون", nameEn: "Al Taawun" }]
            : [],
        ),
      ),
      getBinary: vi.fn(),
      post: vi.fn((...args: [path: string, body?: unknown, headers?: unknown]) => Promise.resolve({ path: args[0], serialNumber: "77" })),
      postMultipart: vi.fn().mockResolvedValue({
        excludedLines: 0,
        rows: [
          {
            area, areaNote: null, codAmount: "125.00", customerAddress: "ش التعاون", customerName: "عميل",
            driverId: null, driverName: "", emirateId: "emirate-shj", errors: [], excludedReason: null,
            mobile: "0502222222", notes: "", packageCount: 1, paymentCondition: "customer_pays_cod_and_fee",
            pickup: false, referenceNumber: "17330", secondMobile: "", sheetRow: 3, sheetServiceFee: "25.00",
            sheetTraderName: "Someone", trader: { code: "TRD-1", id: "me", mobileNumber: "", nameAr: null, nameEn: "My Shop" },
          },
        ],
        totalLines: 1,
      }),
    };
    const onCreated = vi.fn();
    render(
      <FastOrderEntryDialog
        api={api as unknown as ApiClient}
        emirates={[]}
        mode="trader"
        onClose={vi.fn()}
        onCreated={onCreated}
        onSaved={vi.fn()}
      />,
    );
    const dialog = within(await screen.findByRole("dialog", { name: /Fast order entry/ }));
    // No Trader, Driver, Serial or fee columns; no paste box.
    const headers = dialog.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers).not.toContain("Trader");
    expect(headers).not.toContain("Driver");
    expect(headers).not.toContain("Service Fee");
    expect(dialog.queryByText("Paste from Excel or CSV")).toBeNull();
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [new File(["x"], "sheet.xlsx")] },
    });
    await dialog.findByText("Sheet row 3");
    expect(api.postMultipart).toHaveBeenCalledWith("portal/trader/orders/fast-entry/sheet", expect.anything());
    await waitFor(() => expect((dialog.getByLabelText("Area") as HTMLSelectElement).value).toBe("area-1"));
    fireEvent.click(dialog.getByRole("button", { name: "Create orders" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const [path, body] = api.post.mock.calls[0]!;
    expect(path).toBe("portal/trader/orders");
    expect(body).toMatchObject({ areaId: "area-1", codAmount: 125, referenceNumber: "17330" });
    expect(body).not.toHaveProperty("traderId");
    expect(body).not.toHaveProperty("driverId");
    expect(body).not.toHaveProperty("serviceFee");
    expect(api.post.mock.calls.some(([called]) => called === "operations/orders/quote")).toBe(false);
  });
});
