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
  // (also covers a plain re-save of an order whose outstanding charge is out of step)

  it("runs the receivable sync for fee, COD, additional-fee and Trader changes, not only Who pays", () => {
    expect(block).toContain('["trader", "cod_amount", "service_fee", "additional_fees"].includes(change.field)');
    expect(block).toContain("const selfHealOnly = !receivableAffectingChange;");
  });

  it("skips a no-op and refuses to change a receivable the Trader has already paid", () => {
    expect(block).toContain("new Decimal(linkedReceivable.originalAmountDue).equals(financials.traderReceivableDue)");
    expect(block).toContain('"order_fee_has_collections"');
    expect(block).toContain("Reverse the Trader collection or settlement first.");
    expect(block.indexOf('"order_fee_has_collections"')).toBeLessThan(block.indexOf("Replaced: Order fee, COD or Trader changed"));
  });

  it("on a re-save that changes nothing financial, only corrects the amount of one outstanding, uncollected charge", () => {
    const heal = block.slice(block.indexOf("const canSelfHeal ="), block.indexOf("if (selfHealOnly && !canSelfHeal)"));
    expect(heal).toContain("linkedReceivable !== undefined");
    expect(heal).toContain("!anyCollected");
    expect(heal).toContain("financials.traderReceivableDue.greaterThan(0)");
    expect(block).toContain("if (receivableUnchanged || (selfHealOnly && !canSelfHeal)) {");
  });

  it("replaces the charge (cancel + new) instead of re-amounting it, so the journal follows", () => {
    // The accounting trigger posts only on insert and on cancel; an in-place
    // amount change left the books at the old amount (XYZ ORD-000151).
    expect(block).not.toContain("original_amount_due=${financials.traderReceivableDue.toFixed(2)}::numeric");
    expect(block).toContain("Replaced: Order fee, COD or Trader changed");
    const replace = block.slice(block.indexOf("Replace, never re-amount"));
    expect(replace.indexOf("set status='cancelled'")).toBeLessThan(replace.indexOf("createOrderTraderReceivableIfNeeded"));
  });

  it("lets a no-change save reach the receivable check instead of returning early", () => {
    // The Edit dialog always sends the unchanged customer ids, which made the
    // "safe identifier only" shortcut return before the sync (ORD-000151).
    expect(service).toContain("if (providedOnlySafeIdentifierContactChange && !noChangeSaveOnEditableOrder) {");
    expect(service).toContain("const fieldsChanged = changes.length > 0;");
    expect(service).toContain("if (fieldsChanged) await sql`");
    const syncAt = service.indexOf("const paymentConditionChanged = nextPaymentCondition !== current.paymentCondition;");
    expect(service.indexOf("if (!fieldsChanged) return;")).toBeGreaterThan(syncAt);
  });
});
