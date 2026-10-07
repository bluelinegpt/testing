import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../api/api-client.js";
import { i18nInstance } from "../../localization/i18n.js";
import { OrdersReport } from "./OrdersReport.js";

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
    for (const column of ["orderNumber", "date", "traderName", "customer", "customerMobile", "emirates", "area", "cod", "fee", "traderAmount", "paidToTrader", "collectedFromTrader", "balance", "status"]) {
      expect(source).toContain(`\"${column}\"`);
    }
  });
});

describe("Orders Report totals", () => {
  it("shows the Trader Amount column and the whole-report totals from the server", async () => {
    await i18nInstance.changeLanguage("en");
    const row = { orderNumber: "ORD-000344", date: "2026-10-07", traderName: "Trader", customer: "C", customerMobile: "0500000000", emirates: "Sharjah", area: "Al Nabba", cod: "0.00", fee: "18.00", traderAmount: "-18.00", paidToTrader: "0.00", collectedFromTrader: "0.00", balance: "-18.00", status: "delivered" };
    const api = {
      get: vi.fn((path: string) => path === "operations/traders"
        ? Promise.resolve([])
        : Promise.resolve({ items: [row], page: 1, pageSize: 25, totalCount: 30, totals: { cod: "1395.00", fee: "540.00", traderAmount: "855.00", paidToTrader: "600.00", collectedFromTrader: "18.00", balance: "273.00" } })),
      getBinary: vi.fn(),
    };
    render(<OrdersReport api={api as unknown as ApiClient} />);
    expect((await screen.findAllByText("-18.00")).length).toBe(2);
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
  });
});
