import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Editing an Order's fee, COD, additional fees or Trader must keep its
 * service-charge Trader Receivable in step (ORD-000063 / ref 1250 and the
 * 8 Oct XYZ test ORD-000151: fee 20 -> 15 left the trader charged 20).
 */
describe("Order edit keeps the Trader fee receivable in step", () => {
  const service = readFileSync(resolve(process.cwd(), "src/operations/operations.service.ts"), "utf8");
  const block = service.slice(service.indexOf("const paymentConditionChanged = nextPaymentCondition !== current.paymentCondition;"));

  it("runs the receivable sync for fee, COD, additional-fee and Trader changes, not only Who pays", () => {
    expect(block).toContain('["trader", "cod_amount", "service_fee", "additional_fees"].includes(change.field)');
    expect(block).toContain("if (receivableAffectingChange) {");
  });

  it("skips a no-op and refuses to change a receivable the Trader has already paid", () => {
    expect(block).toContain("new Decimal(linkedReceivable.originalAmountDue).equals(financials.traderReceivableDue)");
    expect(block).toContain('"order_fee_has_collections"');
    expect(block).toContain("Reverse the Trader collection or settlement first.");
    expect(block.indexOf('"order_fee_has_collections"')).toBeLessThan(block.indexOf("original_amount_due=${financials.traderReceivableDue.toFixed(2)}::numeric"));
  });
});
