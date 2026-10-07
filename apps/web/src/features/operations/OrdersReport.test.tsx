import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { OrdersReport, parseReferenceNumbers } from "./OrdersReport.js";

describe("Orders Report UI contract", () => {
  const source = readFileSync(resolve(process.cwd(), "src/features/operations/OrdersReport.tsx"), "utf8");

  it("exposes date, trader, multi-status, pagination, loading, empty, and error controls", () => {
    expect(source).toContain('type="date"');
    expect(source).toContain("operations/traders");
    expect(source).toContain("item.name");
    expect(source).toContain('type="checkbox"');
    expect(source).toContain("pageSize");
    expect(source).toContain('role="alert"');
    expect(source).toContain("empty-state");
  });

  it("uses the same serialized filters for the report and complete Excel export", () => {
    expect(source).toContain("operations/reports/orders?");
    expect(source).toContain("operations/reports/orders.${format}?");
    expect(source).toContain("p.delete(\"page\")");
    expect(source).toContain("p.delete(\"pageSize\")");
    expect(source).toContain('p.set("language", normalizeLocale(i18n.resolvedLanguage))');
    for (const column of ["orderDate", "deliveryDate", "traderName", "customer", "customerMobile", "emirates", "area", "cod", "fee", "traderAmount", "paidToTrader", "collectedFromTrader", "balance", "status"]) {
      expect(source).toContain(`\"${column}\"`);
    }
  });
});

describe("Orders Report totals", () => {
  it("shows the Trader Amount column and the whole-report totals from the server", async () => {
    await i18nInstance.changeLanguage("en");
    const row = { orderNumber: "ORD-000344", orderDate: "2026-10-07", deliveryDate: "2026-10-08", traderName: "Trader", customer: "C", customerMobile: "0500000000", emirates: "Sharjah", area: "Al Nabba", cod: "0.00", fee: "18.00", traderAmount: "18.00", paidToTrader: "0.00", collectedFromTrader: "0.00", balance: "18.00", status: "delivered" };
    const api = {
      get: vi.fn((path: string) => path === "operations/traders"
        ? Promise.resolve([])
        : Promise.resolve({ items: [row], page: 1, pageSize: 25, totalCount: 30, totals: { cod: "1395.00", fee: "540.00", traderAmount: "855.00", paidToTrader: "600.00", collectedFromTrader: "18.00", balance: "273.00" } })),
      getBinary: vi.fn(),
    };
    render(<OrdersReport api={api as unknown as ApiClient} />);
    expect((await screen.findAllByText("18.00")).length).toBeGreaterThanOrEqual(2);
    for (const name of ["Trader Amount", "Paid to Trader", "Collected from Trader", "Balance"])
      expect(screen.getByRole("columnheader", { name })).toBeInTheDocument();
    const totals = screen.getByTestId("orders-report-totals");
    expect(within(totals).getByText("1395.00")).toBeInTheDocument();
    expect(within(totals).getByText("540.00")).toBeInTheDocument();
    expect(within(totals).getByText("855.00")).toBeInTheDocument();
    expect(within(totals).getByText("600.00")).toBeInTheDocument();
    expect(within(totals).getByText("273.00")).toBeInTheDocument();
    const footer = screen.getByRole("rowheader", { name: "Total" }).closest("tr")!;
    expect(within(footer).getByText("855.00")).toBeInTheDocument();
    expect(within(footer).getByText("273.00")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Order Date" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Delivery Date" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Order Number" })).toBeNull();
    expect(screen.queryByText("ORD-000344")).toBeNull();
  });
});

describe("Orders Report single trader", () => {
  it("shows the selected Trader once at the top and drops the Trader Name column", async () => {
    await i18nInstance.changeLanguage("en");
    const row = { orderNumber: "ORD-1", orderDate: "2026-10-01", deliveryDate: null, traderName: "Anaqa Wa Taraf", customer: "C", customerMobile: "0500000000", emirates: "Dubai", area: "Deira", cod: "100.00", fee: "18.00", traderAmount: "82.00", paidToTrader: "0.00", collectedFromTrader: "0.00", balance: "82.00", status: "new" };
    const api = {
      get: vi.fn((path: string) => path === "operations/traders"
        ? Promise.resolve([{ id: "t1", name: "Anaqa Wa Taraf" }])
        : Promise.resolve({ items: [row], page: 1, pageSize: 25, totalCount: 1, totals: { cod: "100.00", fee: "18.00", traderAmount: "82.00", paidToTrader: "0.00", collectedFromTrader: "0.00", balance: "82.00" } })),
      getBinary: vi.fn(),
    };
    render(<OrdersReport api={api as unknown as ApiClient} />);
    const select = await screen.findByRole("combobox");
    await screen.findByRole("option", { name: "Anaqa Wa Taraf" });
    fireEvent.change(select, { target: { value: "t1" } });
    expect(await screen.findByTestId("orders-report-trader")).toHaveTextContent("Anaqa Wa Taraf");
    expect(screen.queryByRole("columnheader", { name: "Trader Name" })).toBeNull();
    expect(screen.queryAllByText("Anaqa Wa Taraf", { selector: "td" })).toHaveLength(0);
  });
});

describe("Orders Report reference numbers and filters", () => {
  it("splits a typed list on English/Arabic commas, semicolons and new lines, dropping blanks and duplicates", () => {
    expect(parseReferenceNumbers(" 1001, 1002،1003;1004\n1001,, ")).toEqual(["1001", "1002", "1003", "1004"]);
  });

  it("sends references and the extra filters, and shows one total without +/- lines", async () => {
    await i18nInstance.changeLanguage("en");
    const row = { orderNumber: "ORD-1", orderDate: "2026-10-01", deliveryDate: null, traderName: "T", customer: "C", customerMobile: "0500000000", emirates: "Dubai", area: "Deira", cod: "0.00", fee: "18.00", traderAmount: "18.00", paidToTrader: "0.00", collectedFromTrader: "0.00", balance: "18.00", status: "new" };
    const get = vi.fn((path: string) => path === "operations/traders"
      ? Promise.resolve([])
      : path === "configuration/emirates"
        ? Promise.resolve([{ id: "e1", code: "DXB", nameEn: "Dubai", nameAr: "دبي" }])
        : path.startsWith("operations/drivers")
          ? Promise.resolve([{ id: "d1", name: "Driver One" }])
          : Promise.resolve({ items: [row], page: 1, pageSize: 25, totalCount: 1, totals: { cod: "0.00", fee: "18.00", traderAmount: "18.00", paidToTrader: "0.00", collectedFromTrader: "0.00", balance: "18.00" } }));
    render(<OrdersReport api={{ get, getBinary: vi.fn() } as unknown as ApiClient} />);
    await screen.findByTestId("orders-report-totals");
    expect(screen.queryByText(/due from Trader \(/i)).toBeNull();
    expect(screen.queryByText("-18.00")).toBeNull();
    const reportCalls = () => get.mock.calls.map(([path]) => String(path)).filter((path) => path.startsWith("operations/reports/orders?"));
    const refs = screen.getByTestId("orders-report-references");
    fireEvent.change(refs, { target: { value: "1001, 1002" } });
    fireEvent.blur(refs);
    await vi.waitFor(() => expect(reportCalls().some((path) => path.includes("references=1001%2C1002"))).toBe(true));
    fireEvent.change(await screen.findByTestId("orders-report-emirate"), { target: { value: "e1" } });
    fireEvent.change(await screen.findByTestId("orders-report-driver"), { target: { value: "d1" } });
    fireEvent.change(screen.getByTestId("orders-report-balance-type"), { target: { value: "due_from_trader" } });
    fireEvent.change(screen.getByTestId("orders-report-settlement"), { target: { value: "unsettled" } });
    const customer = screen.getByTestId("orders-report-customer");
    fireEvent.change(customer, { target: { value: "0501" } });
    fireEvent.keyDown(customer, { key: "Enter" });
    await vi.waitFor(() => expect(reportCalls().some((path) => ["emirateId=e1", "driverId=d1", "balanceType=due_from_trader", "settlementStatus=unsettled", "customer=0501"].every((part) => path.includes(part)))).toBe(true));
  });
});
