import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
    expect(source).toContain("operations/reports/orders.xlsx?");
    expect(source).toContain("p.delete(\"page\")");
    expect(source).toContain("p.delete(\"pageSize\")");
    for (const column of ["orderNumber", "date", "traderName", "customer", "customerMobile", "emirates", "area", "cod", "fee", "status"]) {
      expect(source).toContain(`\"${column}\"`);
    }
  });
});
