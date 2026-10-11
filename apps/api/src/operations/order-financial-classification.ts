/**
 * ORDER FINANCIAL CLASSIFICATION -- the vocabulary shared by Company / Order
 * Health, Verify First and the Repair Center (Repair Center Phase 3,
 * Prompt 2: "one financial truth").
 *
 * This module holds ONLY the classification vocabulary and its mapping to a
 * high-level health. It has no dependencies, so the services that produce
 * classifications (CompanyOrderHealthService, the single decision) and the
 * services that consume them (OrderMaintenanceService.financialVerification,
 * RepairPreviewService) can all import it without an import cycle.
 *
 * The DECISION itself -- which classification an Order gets -- is made in
 * exactly one place: the set-based evaluation of CompanyOrderHealthService,
 * built on the receivable reconciliation in trader-receivable-reconciliation.ts.
 * Verify First reads that evaluation; it has no classification chain of its own.
 */

export type FinancialVerificationClassification =
  | "HEALTHY_ACTIVE_RECEIVABLE"
  | "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION"
  | "REVERSED_NEEDS_REPAIR"
  | "ALREADY_PHYSICALLY_COLLECTED"
  | "MISSING_RECEIVABLE"
  | "NO_TRADER_RECEIVABLE_REQUIRED"
  /**
   * Phase 3 Prompt 2: an actual, actionable inconsistency between a current
   * Trader receivable and its effective collections / offsets / Order amount
   * (the ISSUE reconciliation codes of trader-receivable-reconciliation.ts and
   * RECEIVABLE_AMOUNT_MISMATCH). Previously reported as NEEDS_REVIEW with an
   * `anomalyCode`; it is ISSUE, not REVIEW.
   */
  | "RECEIVABLE_INCONSISTENT"
  | "NEEDS_REVIEW";

/**
 * The high-level outcome of a financial classification:
 *
 *   HEALTHY -- financially consistent. This includes a Receivable fully
 *              satisfied by currently effective Settlement offsets: an offset
 *              is a valid settlement mechanism and a physical Trader
 *              Collection is not mandatory.
 *   ISSUE   -- an actual, actionable inconsistency: a required Receivable is
 *              missing, only a reversed one remains, or a current one does not
 *              reconcile with its own effective records.
 *   REVIEW  -- unusual or ambiguous; cannot safely be classified.
 */
export type OrderFinancialHealth = "HEALTHY" | "ISSUE" | "REVIEW";

export const ORDER_FINANCIAL_HEALTH: Readonly<
  Record<FinancialVerificationClassification, OrderFinancialHealth>
> = {
  ALREADY_PHYSICALLY_COLLECTED: "HEALTHY",
  HEALTHY_ACTIVE_RECEIVABLE: "HEALTHY",
  MISSING_RECEIVABLE: "ISSUE",
  NEEDS_REVIEW: "REVIEW",
  NO_TRADER_RECEIVABLE_REQUIRED: "HEALTHY",
  OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION: "HEALTHY",
  RECEIVABLE_INCONSISTENT: "ISSUE",
  REVERSED_NEEDS_REPAIR: "ISSUE",
};

export function orderFinancialHealth(
  classification: FinancialVerificationClassification,
): OrderFinancialHealth {
  return ORDER_FINANCIAL_HEALTH[classification];
}
