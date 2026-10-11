import type { PlatformAccountingRepairAdapter } from "../accounting/platform-accounting-repair.adapter.js";
import { ORDER_HEALTH_REASONS, type OrderHealthReasonCode } from "./company-order-health.service.js";
import type { OrderFinancialHealth } from "./order-financial-classification.js";
import {
  capabilityFor,
  type RepairCapability,
  type RepairPlan,
  type RepairPlanContext,
} from "./repair-capability.registry.js";
import type { Repairability } from "./repair-center.model.js";

/**
 * ONE FINDING, ONE REPAIRABILITY (Repair Center Phase 3, Prompt 2).
 *
 * The Repair Preview and Verify First both answer "can this finding be
 * repaired?" through THIS function, so they cannot disagree:
 *
 *   HEALTHY                                     -> NOT_REQUIRED
 *   no certified capability / no plan /
 *   a `requires_review` capability              -> MANUAL_REVIEW
 *   the plan cannot prove the correct state
 *   (`manualReviewReasons`, Phase 3 Prompt 3)   -> MANUAL_REVIEW
 *   the capability's own preview has blockers   -> BLOCKED
 *   otherwise                                   -> READY
 *
 * The plan comes from the capability's own `preview` (the domain's read
 * paths); nothing here writes.
 */
export function repairabilityOf(
  health: OrderFinancialHealth,
  capability: RepairCapability | undefined,
  plan: RepairPlan | undefined,
): Repairability {
  if (health === "HEALTHY") return "NOT_REQUIRED";
  if (capability === undefined || plan === undefined || capability.decision === "requires_review") {
    return "MANUAL_REVIEW";
  }
  if ((plan.manualReviewReasons ?? []).length > 0) return "MANUAL_REVIEW";
  return plan.blockers.length > 0 ? "BLOCKED" : "READY";
}

export interface FindingPreview {
  readonly health: OrderFinancialHealth;
  readonly capability: RepairCapability | undefined;
  readonly plan: RepairPlan | undefined;
  readonly repairability: Repairability;
}

/** The capability, its plan and the repairability of ONE recomputed finding. */
export async function previewFinding(
  context: RepairPlanContext,
  reasonCode: OrderHealthReasonCode,
): Promise<FindingPreview> {
  const health = ORDER_HEALTH_REASONS[reasonCode].health;
  const capability = health === "HEALTHY" ? undefined : capabilityFor(reasonCode);
  const plan = capability === undefined ? undefined : await capability.preview(context);
  return { capability, health, plan, repairability: repairabilityOf(health, capability, plan) };
}

/**
 * Stand-in for the Platform accounting adapter where only Trader receivable
 * findings are previewed (Verify First). No Trader receivable capability
 * reads the accounting adapter; touching it is a programming error.
 */
const RECEIVABLE_FINDINGS_ONLY = new Proxy(
  {},
  {
    get(): never {
      throw new Error("Trader receivable findings never use the Platform accounting adapter");
    },
  },
) as PlatformAccountingRepairAdapter;

/**
 * `previewFinding` for a Trader receivable finding (Verify First), without
 * the Platform accounting adapter (which lives in the Accounting module).
 */
export async function previewTraderReceivableFinding(
  context: Omit<RepairPlanContext, "accounting">,
  reasonCode: OrderHealthReasonCode,
): Promise<FindingPreview> {
  const capability = capabilityFor(reasonCode);
  if (capability !== undefined && capability.domain !== "TRADER_RECEIVABLE") {
    throw new Error(`${reasonCode} is not a Trader receivable finding`);
  }
  return previewFinding({ ...context, accounting: RECEIVABLE_FINDINGS_ONLY }, reasonCode);
}
