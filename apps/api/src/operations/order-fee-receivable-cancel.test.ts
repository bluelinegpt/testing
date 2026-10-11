import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Cancelling an Order cancels its unpaid Order fee (Aiman, 11 Oct 2026), on
 * both cancel paths: one Order (operations.service) and Change Status for
 * many (orders-workflow.service).
 */
describe("Cancelling an Order cancels its unpaid fee to the Trader", () => {
  const read = (file: string) => readFileSync(resolve(process.cwd(), "src/operations", file), "utf8");
  const helper = read("order-fee-receivable-cancel.ts");

  it("cancels only an Order fee nobody has paid any part of", () => {
    expect(helper).toContain("r.source_type = 'service_charge'");
    expect(helper).toContain("r.status = 'outstanding'");
    expect(helper).toContain("r.amount_collected = 0");
    expect(helper).toContain("o.company_id = ${input.companyId}::uuid");
    expect(helper).toContain("'trader_receivable.cancel_from_order'");
  });

  it("runs on both cancel paths, only for cancelled", () => {
    for (const file of ["operations.service.ts", "orders-workflow.service.ts"]) {
      const source = read(file);
      const call = source.indexOf("await cancelUncollectedOrderFeeReceivables(");
      expect(call, file).toBeGreaterThan(0);
      expect(source.slice(call - 300, call), file).toContain('status === "cancelled"');
    }
  });
});
