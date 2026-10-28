import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Orders Report contract", () => {
  const service = readFileSync(resolve(process.cwd(), "src/operations/operations.service.ts"), "utf8");
  const controller = readFileSync(resolve(process.cwd(), "src/operations/operations.controller.ts"), "utf8");
  // Headings and status names shared by the PDF and the Excel (27 Oct 2026).
  const labels = readFileSync(resolve(process.cwd(), "src/operations/orders-report-labels.ts"), "utf8");

  it("filters on inclusive Order Date boundaries, validated statuses, trader filtering, and stable pagination", () => {
    expect(service).toContain("coalesce(o.order_date, (o.created_at at time zone ${timezone})::date)");
    expect(service).toContain("${orderDate} >= ${dateFrom}::date");
    expect(service).toContain("${orderDate} <= ${dateTo}::date");
    expect(service).toContain("(o.delivered_at at time zone ${timezone})::date::text as \"deliveryDate\"");
    expect(service).toContain("o.trader_id=${traderId}::uuid");
    expect(service).toContain("Invalid order status filter");
    expect(service).toContain("order by ${orderDate} asc, o.created_at asc, o.id asc");
    expect(service).toContain("limit ${pageSize} offset ${(page - 1) * pageSize}");
  });

  it("keeps company isolation and identical filters for paged rows and Excel export", () => {
    expect(service).toContain("o.company_id = ${identity.companyId}::uuid");
    expect(service).toContain("public async ordersReportExcel");
    expect(service).toContain("this.ordersReport({ ...filters, page, pageSize: 200 })");
    expect(labels).toContain('orderDate: "Order Date"');
    expect(service).toContain('o.reference_number as "referenceNumber"');
    expect(service).toContain('[l.referenceNumber]: row.referenceNumber ?? ""');
    expect(service).toContain("[l.serial]: String(index + 1)");
    expect(controller).toContain("[labels.serial]: String(index + 1)");
    expect(labels).toContain('deliveryDate: "Delivery Date"');
    expect(labels).not.toContain('"Order Number"');
    expect(labels).toContain('customerMobile: "Customer Mobile"');
    expect(controller).toContain('@Get("reports/orders")');
    expect(controller).toContain('@Get("reports/orders.xlsx")');
    expect(controller).toContain('@Get("reports/orders.pdf")');
    expect(controller).toContain('@Query("language") language: string | undefined');
    expect(controller).toContain('language: reportLanguage');
    expect(labels).toContain("تاريخ الطلب");
    expect(labels).toContain("تاريخ التسليم");
    expect(labels).not.toContain("رقم الطلب");
    expect(controller).toContain("highlight: { label: filterLabels.trader, value: selectedTraderName }");
    expect(controller).toContain("...(singleTrader ? [] : [labels.traderName])");
    expect(labels).toContain("جديد");
    expect(controller).toContain("جميع التجار");
    expect(controller).toContain("showTelephone: false");
  });

  it("adds the Trader Amount column and whole-report totals to the list, Excel and PDF", () => {
    expect(service).toContain("(coalesce(o.trader_net_payable, 0) - trader_owes.due)");
    expect(service).toContain("r.source_type = 'service_charge' and r.source_reference = o.order_number");
    expect(service).toContain("r.status not in ('cancelled', 'reversed')");
    expect(labels).toContain('paidToTrader: "Paid to Trader"');
    expect(labels).toContain('collectedFromTrader: "Collected from Trader"');
    expect(labels).toContain("محصّل من التاجر");
    expect(service).toContain("coalesce(sum(o.cod_amount), 0)");
    expect(service).toContain("coalesce(sum(${shownFee}), 0)::numeric(18,2)::text as fee");
    expect(service).toContain("coalesce(sum(${shownTraderAmount}), 0)");
    expect(labels).toContain('traderAmount: "Trader Amount"');
    expect(service).toContain("report.totals.traderAmount");
    expect(labels).toContain("مبلغ التاجر");
    expect(controller).toContain("first.totals.traderAmount");
  });

  it("filters on any of several exact Reference Numbers", () => {
    expect(service).toContain("o.reference_number_normalized in (${sql.join(referenceNumbers)})");
    expect(service).toContain("this.normalizeOrderIdentifier(value)");
    expect(service).toContain("and ${referencePredicate}");
    expect(controller.match(/referenceNumbers: splitReferenceNumbers\(references\)/g)?.length).toBe(3);
  });

  it("shows what the Trader owes with a minus sign, in red, so the totals are the net position (27 Oct 2026)", () => {
    expect(service).toContain("const shownTraderAmount = sql`(case when ${cancelled} then null else ${traderAmount} end)`");
    expect(service).toContain("${signedBalance}::numeric(18,2)::text as balance,");
    expect(service).toContain('coalesce(sum(${shownTraderAmount}), 0)::numeric(18,2)::text as "traderAmount"');
    expect(service).toContain("coalesce(sum(${signedBalance}), 0)::numeric(18,2)::text as balance");
    expect(service).not.toContain("abs(${traderAmount})");
    expect(service).not.toContain("abs(${signedBalance})");
    expect(controller).toContain("negativeColumns: [labels.traderAmount, labels.balance]");
  });

  it("shows as COD the cash the Driver collects from the customer, in both languages (27 Oct 2026)", () => {
    expect(service).toContain("const shownCod = sql`(case when ${cancelled} then null else o.customer_amount_due end)`");
    expect(service).not.toContain("shownAmountToCollect");
    expect(labels).not.toContain("amountToCollect");
    expect(labels.match(/cod: "COD"/g)?.length).toBe(2);
  });

  it("shows the number of packages, with a total, on the screen, Excel and PDF (28 Oct 2026)", () => {
    expect(service).toContain("coalesce(o.package_count, 0)::int as packages,");
    expect(service).toContain("coalesce(sum(o.package_count), 0)::int as packages,");
    expect(service).toContain("[l.packages]: String(row.packages)");
    expect(controller).toContain("[labels.packages]: String(row.packages)");
    expect(labels).toContain('packages: "عدد الطرود"');
  });

  it("exports the Excel in the screen's language, with status names and Arabic place names", () => {
    expect(controller).toContain('this.operations.ordersReportExcel(language === "ar" ? "ar" : "en", {');
    expect(service).toContain("[l.status]: statusNames[row.status] ?? row.status");
    expect(service).toContain("[l.area]: arabic ? row.areaAr || row.area : row.area");
    expect(labels).toContain('assigned_to_driver: "معين للمندوب"');
  });

  it("supports delivery date, emirate, area, driver, customer, balance and settlement filters on all exports", () => {
    expect(service).toContain("(o.delivered_at at time zone ${timezone})::date >= ${deliveryFrom}::date");
    expect(service).toContain("a.emirate_id = ${emirateId}::uuid");
    expect(service).toContain("a.name_en ilike ${areaTerm}::text or a.name_ar ilike ${areaTerm}::text");
    expect(service).toContain("o.assigned_driver_id = ${driverId}::uuid");
    expect(service).toContain("o.customer_name ilike ${customerTerm}::text");
    expect(service).toContain("o.trader_settlement_status = ${settlementStatus}::text");
    expect(service).toContain("sql`${signedBalance} < 0`");
    expect(service).toContain("Invalid balance filter");
    expect(service).toContain("Invalid settlement filter");
    expect(controller.match(/\.\.\.extraOrdersReportFilters\(query\)/g)?.length).toBe(3);
  });

  it("shows cancelled orders' COD, Trader Amount and Balance as a red \"--\" and leaves them out of the totals", () => {
    expect(service).toContain("const cancelled = sql`(o.delivery_status in ('cancelled', 'returned_to_trader') or o.return_status = 'returned_to_trader')`");
    // No fee on an undelivered Order unless a fee charge exists (9 Oct 2026).
    expect(service).toContain("(case when ${cancelled} and trader_owes.due = 0 then null else o.service_fee end)");
    expect(service).toContain('[l.fee]: row.fee ?? "--"');
    expect(controller).toContain("[labels.fee]: row.fee ?? VOID");
    expect(service).toContain("coalesce(sum(${shownCod}), 0)::numeric(18,2)::text as cod");
    expect(service).toContain("coalesce(sum(${shownTraderAmount}), 0)");
    expect(service).toContain("(case when ${cancelled} then null else (${traderAmount} - ${paidToTrader} + trader_owes.collected) end)");
    expect(service).toContain('[l.balance]: row.balance ?? "--"');
    expect(controller).toContain("voidMarker: VOID");
  });

  it("links each row to its current Trader Settlement (not a reversal, not reversed), scoped by company", () => {
    expect(service).toContain('as "settlementId"');
    expect(service).toContain("and s.status = 'confirmed' and s.reversal_of_id is null");
    expect(service).toContain("where r.company_id = s.company_id and r.reversal_of_id = s.id");
    expect(service).toContain("where tso.company_id = o.company_id and tso.order_id = o.id");
  });
});
