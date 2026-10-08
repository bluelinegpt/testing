import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * An Order that ends undelivered (returned to Trader or cancelled) owes its
 * Outsourced Driver nothing (decision 9 Oct 2026). XYZ ORD-000155 was
 * delivered, reopened, then returned, and kept 15.00 owed to the Driver.
 */
describe("Undelivered Orders reverse the Outsourced Driver delivery fee", () => {
  const operations = readFileSync(resolve(process.cwd(), "src/operations/operations.service.ts"), "utf8");
  const workflow = readFileSync(resolve(process.cwd(), "src/operations/orders-workflow.service.ts"), "utf8");
  const fees = readFileSync(resolve(process.cwd(), "src/payroll/outsourced-driver-fee.service.ts"), "utf8");

  it("calls the reversal when an Order is cancelled or returned to Trader", () => {
    const at = operations.indexOf("await this.outsourcedDriverFees.reverseForUndeliveredOrder(transaction, {");
    expect(at).toBeGreaterThan(-1);
    expect(operations.slice(at - 600, at)).toContain('if (status === "cancelled" || status === "returned_to_trader") {');
  });

  it("also reverses it on the office web-portal path (Change delivery status)", () => {
    // XYZ ORD-000156 was cancelled through this path and kept its fee.
    const at = workflow.indexOf("await this.outsourcedDriverFees.reverseForUndeliveredOrder(database, {");
    expect(at).toBeGreaterThan(-1);
    expect(workflow.slice(at - 600, at)).toContain('if (status === "cancelled" || status === "returned_to_trader") {');
  });

  it("reverses only active delivery accruals and keeps paid ones recoverable", () => {
    const body = fees.slice(fees.indexOf("public async reverseForUndeliveredOrder("));
    const method = body.slice(0, body.indexOf("private async createForDeliveredOrderIdempotently("));
    expect(method).toContain("earning_type='delivery' and status not in ('reversed','recovery_required')");
    expect(method).toContain('paid.isZero() ? "reversed" : "recovery_required"');
    expect(method).toContain("company_id=${companyId}::uuid");
  });
});
