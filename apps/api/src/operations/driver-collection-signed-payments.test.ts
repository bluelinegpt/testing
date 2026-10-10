import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Company-pays-Driver (11 Oct 2026) stores cash paid TO the Driver as a
 * payment with direction `out`. Every total of driver_reconciliation_payments
 * must subtract those, or the list, summary, details, report and confirm
 * result would show the payout as money received.
 */
describe("Driver collection payment totals are signed", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/operations/driver-cash-reconciliation.service.ts"),
    "utf8",
  );

  it("never sums payment amounts without their direction", () => {
    expect(source).not.toMatch(/sum\(p\.amount\)(?!\s*filter)/);
    expect(source).toContain("case when p.direction = 'out' then -p.amount else p.amount end");
  });

  it("writes each payment's direction and each Order line's own method", () => {
    expect(source).toContain("company_id, reconciliation_id, payment_method, direction, amount,");
    expect(source).toContain('${methods.get(order.id) ?? "none"}');
  });

  it("records a Company payout as a cash withdrawal from the Cash account", () => {
    expect(source).toContain('const movementType = isPayout ? "cash_withdrawal"');
    expect(source).toContain("const sourceCashAccountId = isPayout ? payment.cashAccountId : null;");
  });
});
