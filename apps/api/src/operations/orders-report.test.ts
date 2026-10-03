import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Orders Report contract", () => {
  const service = readFileSync(resolve(process.cwd(), "src/operations/operations.service.ts"), "utf8");
  const controller = readFileSync(resolve(process.cwd(), "src/operations/operations.controller.ts"), "utf8");

  it("uses inclusive creation-date boundaries, validated statuses, trader filtering, and stable pagination", () => {
    expect(service).toContain("(o.created_at at time zone ${timezone})::date >= ${dateFrom}::date");
    expect(service).toContain("(o.created_at at time zone ${timezone})::date <= ${dateTo}::date");
    expect(service).toContain("o.trader_id=${traderId}::uuid");
    expect(service).toContain("Invalid order status filter");
    expect(service).toContain("o.created_at desc, o.id desc");
    expect(service).toContain("limit ${pageSize} offset ${(page - 1) * pageSize}");
  });

  it("keeps company isolation and identical filters for paged rows and Excel export", () => {
    expect(service).toContain("o.company_id = ${identity.companyId}::uuid");
    expect(service).toContain("public async ordersReportExcel");
    expect(service).toContain("this.ordersReport({ ...filters, page, pageSize: 200 })");
    expect(service).toContain('"Order Number"');
    expect(service).toContain('"Customer Mobile"');
    expect(controller).toContain('@Get("reports/orders")');
    expect(controller).toContain('@Get("reports/orders.xlsx")');
  });
});
