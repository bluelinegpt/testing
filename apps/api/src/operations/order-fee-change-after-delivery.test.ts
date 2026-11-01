import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Change the fee of a delivered / closed Pay by Trader Order (Aiman, 1 Nov
 * 2026). Source contract: the guards and the steps that keep the books and
 * the Trader's draft right.
 */
describe("Change fee after delivery", () => {
  const source = readFileSync(resolve(process.cwd(), "src/operations/operations.service.ts"), "utf8");
  const start = source.indexOf("public async changeDeliveredOrderFee(");
  const method = source.slice(start, source.indexOf("private normalizeOrderIdentifier(", start));
  const controller = readFileSync(resolve(process.cwd(), "src/operations/operations.controller.ts"), "utf8");

  it("is a guarded endpoint needing the fee-override permission and a reason", () => {
    expect(controller).toContain('@Post("orders/:orderId/change-fee")');
    expect(controller).toContain('@RequireAnyPermission("orders.override_service_fee", "users_roles.manage")');
    expect(method).toContain('"service_fee_override_reason_required"');
  });

  it("only for a delivered or closed Pay by Trader Order, never moving the Driver's cash or the Trader's payment", () => {
    expect(method).toContain('["delivered", "closed"].includes(current.deliveryStatus)');
    expect(method).toContain('current.paymentCondition !== "customer_pays_cod_trader_pays_fee"');
    expect(method).toContain('"order_fee_change_moves_payment"');
    expect(method).toContain("where o.id = ${orderId}::uuid and o.company_id = ${companyId}::uuid");
  });

  it("refuses a fee already collected and names the receipt to un-post", () => {
    expect(method).toContain('"order_fee_has_collections"');
    expect(method).toContain("Un-post ${");
    expect(method).toContain("c.status <> 'reversed'");
  });

  it("replaces the fee receivable (cancel + new), never re-amounts it, and updates the open draft", () => {
    expect(method).toContain("update trader_receivables set status = 'cancelled'");
    expect(method).toContain("await this.createOrderTraderReceivableIfNeeded(transaction");
    expect(method).not.toContain("set original_amount_due");
    expect(method).toContain("status = 'draft'");
    expect(method).toContain("line.receivableId !== old.id");
    expect(method).toContain("'order.fee_changed_after_delivery'");
  });
});
