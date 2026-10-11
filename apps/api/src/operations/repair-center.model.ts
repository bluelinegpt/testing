import { createHash } from "node:crypto";

import type { OrderHealthReasonCode, OrderHealthRecommendedAction } from "./company-order-health.service.js";
import type { OrderFinancialHealth } from "./order-maintenance.service.js";
import type { ManualReviewExplanation } from "./repair-manual-review.js";

/**
 * REPAIR CENTER FINDING MODEL (Phase 2, Prompt 2) -- computed, never stored.
 *
 * A finding is derived from the database on every request by the same
 * evaluation the Company Health Check uses. Nothing here creates a row: a
 * finding's identity is a deterministic hash of (Company, Order, reason), so
 * the same problem has the same id on every read and a solved problem simply
 * stops appearing.
 */

export type RepairDomain =
  | "ORDER"
  | "TRADER_RECEIVABLE"
  | "TRADER_SETTLEMENT"
  | "TRADER_COLLECTION"
  | "DRIVER_CASH"
  | "ACCOUNTING";

/**
 * NOT_REQUIRED   healthy / informational -- nothing to repair.
 * READY          a certified domain operation exists for exactly this state
 *                and every prerequisite the preview can prove holds.
 * BLOCKED        the certified operation exists but a prerequisite fails.
 * MANUAL_REVIEW  ambiguous, or no certified operation exists.
 */
export type Repairability = "NOT_REQUIRED" | "READY" | "BLOCKED" | "MANUAL_REVIEW";

export type FindingSeverity = "none" | "medium" | "high";

/** A stable, machine-readable reason with a human sentence. */
export interface RepairIssue {
  readonly code: string;
  readonly message: string;
}

export type RepairEvidence = Readonly<Record<string, string | number | boolean | null>>;

export interface RepairFinding {
  readonly findingId: string;
  readonly companyId: string;
  readonly orderId: string;
  readonly domain: RepairDomain;
  readonly entityType: "order" | "trader_receivable";
  readonly entityId: string;
  readonly entityNumber: string;
  readonly health: OrderFinancialHealth;
  readonly severity: FindingSeverity;
  readonly reasonCode: OrderHealthReasonCode;
  readonly title: string;
  readonly summary: string;
  readonly detectedState: string;
  readonly expectedState: string;
  readonly recommendedAction: OrderHealthRecommendedAction;
  /** The registered capability for this reason, or null when none exists. */
  readonly repairCapability: string | null;
  readonly repairability: Repairability;
  readonly blockers: readonly RepairIssue[];
  readonly warnings: readonly RepairIssue[];
  readonly evidence: RepairEvidence;
  /**
   * Phase 3 Prompt 3: for a Trader-financial MANUAL_REVIEW finding, what is
   * inconsistent, the financial comparison, the affected records and why no
   * automatic repair is offered. Null otherwise.
   */
  readonly manualReview: ManualReviewExplanation | null;
  /** When this computation ran. Never part of the preview fingerprint. */
  readonly detectedAt: string;
}

interface FindingDefinition {
  readonly domain: RepairDomain;
  readonly title: string;
  readonly expectedState: string;
}

/** Per reason: where the finding lives and what "correct" looks like. */
export const FINDING_DEFINITIONS: Readonly<Record<OrderHealthReasonCode, FindingDefinition>> = {
  NO_TRADER_RECEIVABLE_REQUIRED: {
    domain: "ORDER",
    expectedState: "No Trader receivable, because the order financial model says nothing is owed.",
    title: "No Trader receivable required",
  },
  HEALTHY_ACTIVE_RECEIVABLE: {
    domain: "TRADER_RECEIVABLE",
    expectedState: "One current Trader receivable for the fee the Trader owes.",
    title: "Trader receivable open",
  },
  ALREADY_PHYSICALLY_COLLECTED: {
    domain: "TRADER_COLLECTION",
    expectedState: "The current receivable fully covered by a confirmed Trader Collection.",
    title: "Trader fee physically collected",
  },
  SETTLED_BY_COLLECTION_AND_OFFSET: {
    domain: "TRADER_COLLECTION",
    expectedState: "The current receivable covered by a confirmed collection plus an effective settlement offset.",
    title: "Trader fee settled by collection and settlement offset",
  },
  OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION: {
    domain: "TRADER_SETTLEMENT",
    expectedState: "The current receivable covered by exactly one effective settlement offset.",
    title: "Trader fee settled by settlement offset",
  },
  MISSING_RECEIVABLE: {
    domain: "TRADER_RECEIVABLE",
    expectedState: "One current Trader receivable for the fee the Trader owes.",
    title: "Required Trader receivable missing",
  },
  REVERSED_NEEDS_REPAIR: {
    domain: "TRADER_RECEIVABLE",
    expectedState:
      "One current Trader receivable for the fee the Trader owes; reversed receivables stay as history.",
    title: "Only a reversed Trader receivable remains",
  },
  MULTIPLE_EFFECTIVE_SETTLEMENTS: {
    domain: "TRADER_SETTLEMENT",
    expectedState: "At most one effective settlement offset per receivable.",
    title: "Receivable offset by more than one effective settlement",
  },
  RECEIVABLE_OVER_COLLECTED: {
    domain: "TRADER_RECEIVABLE",
    expectedState: "Effective collections plus effective offsets no greater than the amount due.",
    title: "Receivable collected beyond the amount due",
  },
  RECEIVABLE_COLLECTED_AMOUNT_MISMATCH: {
    domain: "TRADER_RECEIVABLE",
    expectedState:
      "The recorded collected amount equal to effective collections plus effective offsets.",
    title: "Receivable collected amount does not reconcile",
  },
  MULTIPLE_ACTIVE_RECEIVABLES: {
    domain: "TRADER_RECEIVABLE",
    expectedState: "Exactly one current Trader receivable for the order.",
    title: "More than one active Trader receivable",
  },
  RECEIVABLE_NOT_REQUIRED_BUT_ACTIVE: {
    domain: "TRADER_RECEIVABLE",
    expectedState: "No current Trader receivable, because the customer's COD covers the fee.",
    title: "Active Trader receivable that is not required",
  },
  RECEIVABLE_STATE_INCONSISTENT: {
    domain: "TRADER_RECEIVABLE",
    expectedState: "A Trader receivable state the certified classification recognises.",
    title: "Trader receivable state inconsistent",
  },
  // ---- Phase 3: Trader financial reconciliation (trader-receivable-reconciliation.ts)
  RECEIVABLE_AMOUNT_MISMATCH: {
    domain: "TRADER_RECEIVABLE",
    expectedState: "The current receivable amount equal to what the order required when its obligation was set (its own stored financial snapshot).",
    title: "Trader receivable amount does not match the order",
  },
  RECEIVABLE_AMOUNT_NOT_PROVABLE: {
    domain: "TRADER_RECEIVABLE",
    expectedState:
      "A person confirms what this older order required; it has no VAT snapshot, so the amount is never inferred from today's settings.",
    title: "Trader receivable amount cannot be proven for this older order",
  },
  COLLECTION_ALLOCATION_MISMATCH: {
    domain: "TRADER_COLLECTION",
    expectedState:
      "Every confirmed collection allocation from the receivable's own Trader, within the money that collection received.",
    title: "Trader collection allocation inconsistent",
  },
  ORPHAN_COLLECTION_ALLOCATION: {
    domain: "TRADER_COLLECTION",
    expectedState: "No confirmed collection allocation on a cancelled or reversed receivable.",
    title: "Trader payment applied to a cancelled or reversed receivable",
  },
  SETTLEMENT_OFFSET_MISMATCH: {
    domain: "TRADER_SETTLEMENT",
    expectedState:
      "Effective settlement offsets only from the receivable's own Trader, only on a current receivable (or a reversed one compensated by its Trader Credit).",
    title: "Settlement offset does not match the receivable",
  },
  RECEIVABLE_MARKED_COLLECTED_WITHOUT_EFFECTIVE_SETTLEMENT: {
    domain: "TRADER_RECEIVABLE",
    expectedState: "Status 'collected' only when effective collections plus effective offsets cover the amount due.",
    title: "Trader receivable marked collected without effective settlement",
  },
  FINANCIALLY_SETTLED_BUT_RECEIVABLE_STATE_OPEN: {
    domain: "TRADER_RECEIVABLE",
    expectedState: "Status 'collected' once effective collections plus effective offsets cover the amount due.",
    title: "Trader receivable settled but still open",
  },
  RECEIVABLE_PARTIAL_STATE_MISMATCH: {
    domain: "TRADER_RECEIVABLE",
    expectedState:
      "Status 'outstanding' with nothing settled, 'partially_collected' with part settled (the domain status rule).",
    title: "Trader receivable payment status inconsistent",
  },
  ORDER_MISSING_ACCOUNTING_EVENT: {
    domain: "ACCOUNTING",
    expectedState: "An order accounting event, because the order was delivered while GL Accounting was ON.",
    title: "Delivered order has no accounting event",
  },
  ACCOUNTING_EVENT_FAILED: {
    domain: "ACCOUNTING",
    expectedState: "The order's accounting event posted.",
    title: "Order accounting event failed",
  },
  DRIVER_CASH_RECONCILED_WITHOUT_RECONCILIATION: {
    domain: "DRIVER_CASH",
    expectedState: "Marked reconciled only when an effective driver reconciliation includes the order.",
    title: "Driver cash marked reconciled without a reconciliation",
  },
  DRIVER_CASH_RECONCILIATION_NOT_REFLECTED: {
    domain: "DRIVER_CASH",
    expectedState: "Marked reconciled because an effective driver reconciliation includes the order.",
    title: "Driver reconciliation not reflected on the order",
  },
};

/** Deterministic id: the same Company, Order and reason always hash alike. */
export function findingIdOf(companyId: string, orderId: string, reasonCode: string): string {
  return `fnd_${createHash("sha256")
    .update(`${companyId}|${orderId}|${reasonCode}`)
    .digest("hex")
    .slice(0, 24)}`;
}

export function severityOf(health: OrderFinancialHealth): FindingSeverity {
  return health === "ISSUE" ? "high" : health === "REVIEW" ? "medium" : "none";
}

/**
 * Canonical JSON: object keys sorted at every depth, so the same data always
 * serialises to the same bytes regardless of property order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

/** The preview fingerprint: sha256 of the canonical relevant state. */
export function stateFingerprint(state: unknown): string {
  return `rcv1:${createHash("sha256").update(canonicalJson(state)).digest("hex")}`;
}
