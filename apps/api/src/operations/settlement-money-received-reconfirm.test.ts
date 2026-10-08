import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Money Received is active while confirmations outnumber their reversals.
 * The old "any confirmation ever" checks left a reversed receipt stuck on
 * "Confirm receipt" with every confirm refused (XYZ SET-000055, 9 Oct 2026).
 */
describe("Money Received can be confirmed again after it is reversed", () => {
  const settlements = readFileSync(resolve(process.cwd(), "src/operations/trader-settlement.service.ts"), "utf8");
  const operations = readFileSync(resolve(process.cwd(), "src/operations/operations.service.ts"), "utf8");

  it("defines active Money Received as confirmations outnumbering reversals", () => {
    const helper = settlements.slice(settlements.indexOf("const activeMoneyReceived = ("));
    expect(helper.slice(0, 900)).toMatch(/receiptConfirmedAction\}\)\s*>\s*\(select count\(\*\)/);
  });

  it("uses the active rule for confirm, reverse-receipt, settlement reversal, detail, list, totals and filters", () => {
    const uses = settlements.split("activeMoneyReceived(").length - 1;
    expect(uses).toBeGreaterThanOrEqual(8);
    expect(settlements).toContain("if (alreadyConfirmed) {");
    expect(settlements).toContain("if (!receiptActive) {");
    expect(settlements).toContain("if (moneyReceivedActive) {");
    expect(settlements).not.toMatch(/and not exists \(\s*select 1 from audit_events reversed/);
  });

  it("offers Confirm receipt on the order list when the last receipt was reversed", () => {
    expect(operations).toContain("and ae.action = 'trader_settlement.receipt_confirmation_reversed'");
    expect(operations).toMatch(/receipt_confirmed'\s*\)\s*<=\s*\(/);
  });
});
