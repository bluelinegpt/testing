import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Order Maintenance verify-first contract", () => {
  const source = readFileSync(new URL("./order-maintenance.service.ts", import.meta.url), "utf8");

  it("defines every financial classification", () => {
    for (const classification of [
      "HEALTHY_ACTIVE_RECEIVABLE",
      "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION",
      "REVERSED_NEEDS_REPAIR",
      "ALREADY_PHYSICALLY_COLLECTED",
      "MISSING_RECEIVABLE",
      "NO_TRADER_RECEIVABLE_REQUIRED",
      "NEEDS_REVIEW",
    ]) expect(source).toContain(classification);
  });

  it("keeps verification company-scoped and read-only", () => {
    expect(source).toContain("financialVerification");
    expect(source).toContain("o.company_id=${companyId}::uuid and o.id=${orderId}::uuid");
    expect(source).toContain("r.company_id=${companyId}::uuid");
    expect(source).toContain("select o.id::text as \"orderId\"");
    expect(source).toContain("select r.id::text as id");
  });

  it("handles historical replacement state and refreshable actions", () => {
    expect(source).toContain("active = receivables.filter");
    expect(source).toContain('recommendedAction = "repair"');
    expect(source).toContain('recommendedAction = "reset_then_repair"');
    expect(source).toContain('classification = "HEALTHY_ACTIVE_RECEIVABLE"');
  });
});
