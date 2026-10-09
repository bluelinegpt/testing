import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Trader Account Statement shows only transactions that stand (decision
 * 9 Oct 2026): reversed Settlements, reversed Collections and cancelled or
 * reversed charges are left out together with their reversal lines, and the
 * opening balance follows the same rule so the totals still add up.
 */
describe("Trader statement hides reversed and cancelled transactions", () => {
  const service = readFileSync(resolve(process.cwd(), "src/operations/trader-account-statement.service.ts"), "utf8");

  it("has no reversal or cancellation lines", () => {
    expect(service).not.toContain("'reversal'::text");
    expect(service).not.toContain("'collection_reversal'::text");
    expect(service).not.toContain("'receivable_cancellation'::text");
  });

  it("leaves reversed settlements, reversed collections and cancelled charges out of lines and opening balance", () => {
    expect(service.split("r.status not in ('cancelled', 'reversed')").length - 1).toBeGreaterThanOrEqual(2);
    expect(service.split("c.status <> 'reversed'").length - 1).toBeGreaterThanOrEqual(2);
    expect(service).not.toContain("and r.business_date < ${from}::date)), 0)");
  });
});
