import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { TraderSettlementsWorkspace } from "./TraderSettlementsWorkspace.js";

/**
 * Trader Settlements list filters: Driver, Order Number, Order Reference
 * Number, Emirate and Area. They must reach the company-scoped API as query
 * parameters (the server applies them before pagination), Clear Filters must
 * reset them, and an Excel column paste must become a comma list.
 */

const summary = {
  eligibleOrders: 0,
  eligibleTraderPayable: "0.00",
  moneyReceivedAmount: "0.00",
  moneySentAmount: "0.00",
  partiallySettledAmount: "0.00",
  remainingOutstanding: "0.00",
  reversedPayments: 0,
  tradersWithOutstandingBalance: 0,
  unsettledAmount: "0.00",
};

const settlementRow = {
  confirmedBy: "ops.user",
  createdBy: "ops.user",
  isReversed: false,
  moneyReceivedAt: null,
  moneyReceivedConfirmed: false,
  moneySentAt: "2026-07-27T11:00:00.000Z",
  orderCount: 1,
  paymentAmount: "75.00",
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

const driver = { code: "DRV-001", id: "driver-1", name: "Driver One" };
const emirate = { code: "DXB", id: "emirate-dxb", isActive: true, nameAr: "دبي", nameEn: "Dubai" };
const area = { emirateId: "emirate-dxb", id: "area-deira", isActive: true, nameAr: "ديرة", nameEn: "Deira" };

function setup() {
  const getCalls: string[] = [];
  const api = {
    get: vi.fn((path: string) => {
      getCalls.push(path);
      if (path.startsWith("operations/settlements/payments/summary")) return Promise.resolve(summary);
      if (path.startsWith("operations/settlements/payments/list")) {
        return Promise.resolve({ items: [settlementRow], page: 1, pageSize: 25, total: 1 });
      }
      if (path === "operations/traders") return Promise.resolve([]);
      if (path === "operations/drivers") return Promise.resolve([driver]);
      if (path === "configuration/emirates") return Promise.resolve([emirate]);
      if (path.startsWith("configuration/areas/search")) {
        return Promise.resolve({ hasMore: false, items: [area] });
      }
      return Promise.resolve({ items: [], page: 1, pageSize: 25, total: 0 });
    }),
    getBinary: vi.fn(),
    post: vi.fn(() => Promise.resolve({})),
  };
  render(
    <MemoryRouter>
      <TraderSettlementsWorkspace api={api as unknown as ApiClient} permissions={["settlements.create"]} />
    </MemoryRouter>,
  );
  return { getCalls };
}

const listCalls = (calls: readonly string[]) =>
  calls.filter((call) => call.startsWith("operations/settlements/payments/list"));
const lastQuery = (calls: readonly string[]) =>
  new URLSearchParams(listCalls(calls).at(-1)?.split("?")[1] ?? "");

describe("TraderSettlementsWorkspace list filters", () => {
  beforeEach(async () => {
    await i18nInstance.changeLanguage("en");
  });

  it("sends Driver, Order Number, Order Reference, Emirate and Area together as query parameters", async () => {
    const { getCalls } = setup();
    await screen.findByText("SET-000123");

    const driverBox = screen.getByRole("combobox", { name: "Driver" });
    fireEvent.focus(driverBox);
    fireEvent.change(driverBox, { target: { value: "Driver" } });
    fireEvent.click(await screen.findByRole("option", { name: "Driver One" }));

    fireEvent.change(screen.getByLabelText("Order Number"), { target: { value: "110, 111" } });
    fireEvent.change(screen.getByLabelText("Order Reference Number"), {
      target: { value: "2383,1523,2447" },
    });
    fireEvent.change(screen.getByLabelText("Emirate"), { target: { value: "emirate-dxb" } });

    const areaBox = await screen.findByRole("combobox", { name: "Area" });
    fireEvent.focus(areaBox);
    fireEvent.change(areaBox, { target: { value: "Dei" } });
    fireEvent.click(await screen.findByRole("option", { name: "Deira" }));

    await waitFor(() => {
      const query = lastQuery(getCalls);
      expect(query.get("driverId")).toBe("driver-1");
      expect(query.get("orderNumber")).toBe("110, 111");
      expect(query.get("referenceNumber")).toBe("2383,1523,2447");
      expect(query.get("emirateId")).toBe("emirate-dxb");
      expect(query.get("areaId")).toBe("area-deira");
    });
    // The Area search is limited to the chosen Emirate.
    expect(getCalls.some((call) => call.startsWith("configuration/areas/search?emirateId=emirate-dxb"))).toBe(true);
    // The summary receives the same filters.
    const summaryCall = getCalls.filter((call) => call.startsWith("operations/settlements/payments/summary")).at(-1);
    expect(summaryCall).toContain("referenceNumber=");
  });

  it("asks for an Emirate before an Area can be chosen, and changing Emirate clears the Area", async () => {
    const { getCalls } = setup();
    await screen.findByText("SET-000123");
    expect(screen.getByPlaceholderText("Select an Emirate first")).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Emirate"), { target: { value: "emirate-dxb" } });
    const areaBox = await screen.findByRole("combobox", { name: "Area" });
    fireEvent.focus(areaBox);
    fireEvent.change(areaBox, { target: { value: "Dei" } });
    fireEvent.click(await screen.findByRole("option", { name: "Deira" }));
    await waitFor(() => expect(lastQuery(getCalls).get("areaId")).toBe("area-deira"));

    fireEvent.change(screen.getByLabelText("Emirate"), { target: { value: "" } });
    await waitFor(() => {
      expect(lastQuery(getCalls).get("areaId")).toBeNull();
      expect(lastQuery(getCalls).get("emirateId")).toBeNull();
    });
  });

  it("Clear Filters resets every new filter", async () => {
    const { getCalls } = setup();
    await screen.findByText("SET-000123");
    fireEvent.change(screen.getByLabelText("Order Number"), { target: { value: "110" } });
    fireEvent.change(screen.getByLabelText("Order Reference Number"), { target: { value: "2383" } });
    fireEvent.change(screen.getByLabelText("Emirate"), { target: { value: "emirate-dxb" } });
    await waitFor(() => expect(lastQuery(getCalls).get("emirateId")).toBe("emirate-dxb"));

    fireEvent.click(screen.getAllByRole("button", { name: "Clear Filters" })[0]!);

    await waitFor(() => {
      const query = lastQuery(getCalls);
      for (const key of ["driverId", "orderNumber", "referenceNumber", "emirateId", "areaId"]) {
        expect(query.get(key)).toBeNull();
      }
    });
    expect(screen.getByLabelText("Order Number")).toHaveValue("");
    expect(screen.getByLabelText("Order Reference Number")).toHaveValue("");
    expect(screen.getByLabelText("Emirate")).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Driver" })).toHaveValue("");
  });

  it("turns a pasted Excel column into a comma list", async () => {
    setup();
    await screen.findByText("SET-000123");
    const input = screen.getByLabelText("Order Reference Number");
    fireEvent.paste(input, { clipboardData: { getData: () => "2383\r\n1523\n\n2447\n" } });
    await waitFor(() => expect(input).toHaveValue("2383, 1523, 2447"));
    expect(input).toHaveAttribute("dir", "ltr");
  });

  it("states which summary totals follow the filters", async () => {
    setup();
    expect(await screen.findByTestId("trader-settlements-summary-scope")).toBeInTheDocument();
  });

  it("shows Arabic labels for the new filters", async () => {
    await i18nInstance.changeLanguage("ar");
    setup();
    await screen.findByText("SET-000123");
    expect(screen.getByLabelText("رقم الطلب")).toHaveAttribute("dir", "ltr");
    expect(screen.getByLabelText("الرقم المرجعي للطلب")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "السائق" })).toBeInTheDocument();
    expect(screen.getByLabelText("الإمارة")).toBeInTheDocument();
    await i18nInstance.changeLanguage("en");
  });
});
