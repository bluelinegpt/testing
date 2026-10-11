import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Verify First source contract (Repair Center Phase 3, Prompt 2: ONE
 * FINANCIAL TRUTH). Behaviour is pinned by the database contract test
 * (financial-truth-contract.database.test.ts); this file pins the shape.
 */
describe("Order Maintenance verify-first contract", () => {
  const source = readFileSync(new URL("./order-maintenance.service.ts", import.meta.url), "utf8");
  const vocabulary = readFileSync(new URL("./order-financial-classification.ts", import.meta.url), "utf8");
  const verify = source.slice(
    source.indexOf("public async financialVerification"),
    source.indexOf("private anomalyMessage"),
  );

  it("defines every financial classification", () => {
    for (const classification of [
      "HEALTHY_ACTIVE_RECEIVABLE",
      "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION",
      "REVERSED_NEEDS_REPAIR",
      "ALREADY_PHYSICALLY_COLLECTED",
      "MISSING_RECEIVABLE",
      "NO_TRADER_RECEIVABLE_REQUIRED",
      "RECEIVABLE_INCONSISTENT",
      "NEEDS_REVIEW",
    ]) expect(vocabulary).toContain(`"${classification}"`);
  });

  it("keeps verification company-scoped and read-only", () => {
    expect(verify).toContain("o.company_id=${companyId}::uuid and o.id=${orderId}::uuid");
    expect(verify).toContain("r.company_id=${companyId}::uuid");
    expect(verify).toContain("set transaction read only");
    expect(verify).not.toMatch(/\b(insert into|update \w+ set|delete from)\b/iu);
  });

  it("reads the shared decision instead of classifying on its own", () => {
    expect(verify).toContain("this.orderHealth.orderEvaluation(db, companyId, orderId)");
    expect(verify).toContain("evaluation.financialClassification");
    expect(verify).toContain("evaluation.financialCode");
    expect(verify).toContain("previewTraderReceivableFinding(");
    // No second decision chain.
    expect(verify).not.toContain("classification = \"");
    expect(verify).not.toContain("active.some(");
    expect(verify).not.toContain("RECEIVABLE_ISSUE_ANOMALIES");
  });

  it("never recommends resetting a healthy offset settlement", () => {
    expect(source).not.toContain("reset_then_repair\";");
    expect(source).not.toContain('recommendedAction = "reset_then_repair"');
    expect(source).toContain('readonly recommendedAction: "none" | "repair";');
  });
});
