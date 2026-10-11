import { HttpStatus } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql, type Transaction } from "kysely";

import type { PlatformAccountingRepairAdapter } from "../accounting/platform-accounting-repair.adapter.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type { OrderHealthEvaluation, OrderHealthReasonCode } from "./company-order-health.service.js";
import type { OperationsService } from "./operations.service.js";
import type { OrderMaintenanceService } from "./order-maintenance.service.js";
import type { ReceivableOffsetReversalService } from "./receivable-offset-reversal.service.js";
import type { TraderReceivableService } from "./trader-receivable.service.js";
import { expectedReceivableStatus } from "./trader-receivable-reconciliation.js";
import {
  hasNoFinancialDependencies,
  hasNoOperationalActivity,
  loadReceivableDependencies,
  type TraderReceivableDependencies,
} from "./trader-receivable-dependencies.js";
import type { GraphReceivable, OrderDependencyGraph } from "./repair-dependency-graph.js";
import type { RepairDomain, RepairIssue } from "./repair-center.model.js";

/**
 * REPAIR CAPABILITY REGISTRY (Phase 2, Prompts 2 and 3).
 *
 * Each entry describes an EXISTING, certified domain operation and how the
 * Repair Center invokes it. `execution` says whether the Repair Center may
 * run it (Prompt 3): REPAIR_TRADER_RECEIVABLE and (Phase 3) RECONCILE_TRADER_RECEIVABLE
 * are executable, and only
 * through `RepairExecutionService`, which re-proves READY server-side. Its
 * `execute` calls the certified domain method -- it never writes a business
 * table itself. RESET (manual review) and REPROCESS (precheck not bridged)
 * are NOT executable.
 *
 * A capability's `preview` reproduces what the domain operation itself would
 * do, from the domain's OWN read paths wherever they exist
 * (`OrderMaintenanceService.resetPlanFor`, `ReceivableOffsetReversalService.inspect`
 * and the pure plan in receivable-offset-reversal-plan.ts), plus the
 * operation's documented guards where it has no read path of its own
 * (`OperationsService.repairTraderReceivableInTransaction`). No second repair
 * engine exists here.
 *
 * Inventory of existing repair-type operations and why each is (not) registered:
 *   - Repair / recreate Trader Receivable     -> REPAIR_TRADER_RECEIVABLE
 *   - Delete unused / financially reset (reverse) a Trader Receivable,
 *     incl. the compensating Trader Credit     -> RESET_TRADER_RECEIVABLE
 *   - Accounting Event reprocess (with its certified precheck)
 *                                              -> REPROCESS_ACCOUNTING_EVENT
 *   - Controlled delivered-Order reopen        -> NOT registered: no health
 *     finding is resolved by reopening an Order.
 *   - Trader Credit creation                   -> NOT registered on its own:
 *     it is only ever created inside the certified receivable reversal.
 *   - Driver Cash reconciliation               -> NOT registered: on hold.
 *   - Cancel an unused duplicate receivable    -> CANCEL_DUPLICATE_TRADER_RECEIVABLE
 *     (Phase 3 Prompt 3: `TraderReceivableService.cancelReceivableInTransaction`)
 *   - Cancel an unused wrong-amount receivable
 *     and re-create it                         -> REPLACE_UNUSED_TRADER_RECEIVABLE
 *     (Phase 3 Prompt 3: cancel + the certified Repair Trader Receivable)
 *   - Trader Collection reversal / Settlement reversal -> NOT registered:
 *     each reverses a WHOLE real money movement (every receivable a
 *     Collection paid; a Settlement's Trader payment and every Order and
 *     offset it carries). No finding proves which movement is invalid, so
 *     allocation / orphan / offset / over-collection / multiple-settlement
 *     findings stay MANUAL_REVIEW (see the Phase 3 Prompt 3 decision table).
 */

export type CapabilityCode =
  | "REPAIR_TRADER_RECEIVABLE"
  | "RECONCILE_TRADER_RECEIVABLE"
  | "RESET_TRADER_RECEIVABLE"
  | "REPROCESS_ACCOUNTING_EVENT"
  | "CANCEL_DUPLICATE_TRADER_RECEIVABLE"
  | "REPLACE_UNUSED_TRADER_RECEIVABLE";

export interface RequiredInput {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
}

export interface ProposedChange {
  readonly entityType: string;
  readonly action: "create" | "update" | "delete" | "none";
  readonly entityNumber: string | null;
  readonly description: string;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
}

export interface PreservedRecord {
  readonly entityType: string;
  readonly entityNumber: string | null;
  readonly description: string;
}

export interface RepairPlan {
  readonly title: string;
  readonly explanation: string;
  readonly proposedChanges: readonly ProposedChange[];
  readonly preservedHistory: readonly PreservedRecord[];
  readonly blockers: readonly RepairIssue[];
  readonly warnings: readonly RepairIssue[];
  readonly requiredInputs: readonly RequiredInput[];
  /** The domain permission the future execution would require. */
  readonly requiredPermission: string;
  /**
   * Phase 3 Prompt 3: why the correct state CANNOT be proven for this Order
   * (ambiguity, financial activity, an unprovable expected amount). Non-empty
   * makes the finding MANUAL_REVIEW -- whatever the blockers say: a blocker is
   * a temporary obstacle to a proven repair, this is the absence of proof.
   */
  readonly manualReviewReasons?: readonly RepairIssue[];
}

export interface RepairPlanContext {
  readonly db: Kysely<DatabaseSchema>;
  readonly companyId: string;
  readonly evaluation: OrderHealthEvaluation;
  readonly graph: OrderDependencyGraph;
  readonly maintenance: OrderMaintenanceService;
  readonly reversals: ReceivableOffsetReversalService;
  /** Phase 2 Prompt 4: the certified accounting precheck, Platform-authorised. */
  readonly accounting: PlatformAccountingRepairAdapter;
}

/** What an executable capability receives -- inside the execution transaction. */
export interface RepairExecutionContext {
  readonly transaction: Transaction<DatabaseSchema>;
  readonly companyId: string;
  readonly orderId: string;
  readonly correlationId: string;
  readonly operations: OperationsService;
  /** Phase 3: the Trader receivable domain service (status reconciliation). */
  readonly traderReceivables: TraderReceivableService;
}

/** The certified operation's own report of what it did. */
export interface RepairExecutionOutcome {
  readonly changed: boolean;
  readonly summary: Readonly<Record<string, string | number | boolean | null>>;
}

export type CapabilityExecution =
  | { readonly available: false; readonly reason: string }
  | {
      readonly available: true;
      readonly execute: (context: RepairExecutionContext) => Promise<RepairExecutionOutcome>;
    };

export interface RepairCapability {
  readonly capabilityCode: CapabilityCode;
  readonly domain: RepairDomain;
  readonly description: string;
  /** Static requirement; a plan may narrow it to the exact path. */
  readonly requiredPermission: string;
  readonly supportedReasonCodes: readonly OrderHealthReasonCode[];
  /**
   * `deterministic`: the certified operation resolves exactly this state ->
   * READY when unblocked. `requires_review`: a person must decide the
   * operation applies -> always MANUAL_REVIEW, with the plan shown as a
   * candidate only.
   */
  readonly decision: "deterministic" | "requires_review";
  readonly executionHandler: string;
  readonly idempotencyStrategy: string;
  readonly auditRequirement: string;
  readonly accountingModeRestrictions: string;
  readonly requiredInputs: readonly RequiredInput[];
  readonly knownBlockers: readonly string[];
  readonly preview: (context: RepairPlanContext) => Promise<RepairPlan>;
  /** Repair Center execution (Prompt 3). Only READY findings ever reach it. */
  readonly execution: CapabilityExecution;
}

// ------------------------------------------------------------------ helpers

const money = (value: string | number) => new Decimal(value).toFixed(2);

function issue(code: string, message: string): RepairIssue {
  return { code, message };
}

/**
 * Phase 3 Prompt 4: the Order's expected receivable is not proven by its own
 * records (a legacy Order without a coherent VAT / obligation snapshot).
 */
const EXPECTED_AMOUNT_NOT_PROVABLE: RepairIssue = {
  code: "EXPECTED_AMOUNT_NOT_PROVABLE",
  message:
    "This order has no coherent VAT / obligation snapshot, so the amount the Trader owed when its obligation was set cannot be proven; today's Company VAT settings are never used to re-price it.",
};

/** Records that remain exactly as they are, whatever the repair does. */
function preservedHistory(graph: OrderDependencyGraph): PreservedRecord[] {
  const preserved: PreservedRecord[] = [];
  for (const receivable of graph.receivables.filter((row) => !row.current)) {
    preserved.push({
      description: `Historical ${receivable.status} receivable stays as history`,
      entityNumber: receivable.receivableNumber,
      entityType: "trader_receivable",
    });
  }
  const settlements = new Map<string, { number: string; effective: boolean; reversedBy: string | null }>();
  for (const offset of graph.offsets) {
    settlements.set(offset.settlementId, {
      effective: offset.effective,
      number: offset.settlementNumber,
      reversedBy: offset.reversedBySettlementNumber,
    });
  }
  for (const settlement of settlements.values()) {
    preserved.push({
      description: settlement.effective
        ? "Settlement and its offset rows stay unchanged"
        : "Reversed settlement and its offset rows stay as history",
      entityNumber: settlement.number,
      entityType: "trader_settlement",
    });
    if (settlement.reversedBy !== null) {
      preserved.push({
        description: "Settlement reversal stays as history",
        entityNumber: settlement.reversedBy,
        entityType: "trader_settlement",
      });
    }
  }
  for (const allocation of graph.allocations) {
    preserved.push({
      description: "Trader Collection and its allocation stay unchanged",
      entityNumber: allocation.collectionNumber,
      entityType: "trader_collection",
    });
  }
  for (const credit of graph.credits) {
    preserved.push({
      description: "Trader Credit stays linked to its receivable",
      entityNumber: credit.creditNumber,
      entityType: "trader_credit",
    });
  }
  for (const event of graph.events.filter((row) => row.journalNumber !== null)) {
    preserved.push({
      description: "Journal stays posted as history (never deleted or edited)",
      entityNumber: event.journalNumber,
      entityType: "journal_entry",
    });
  }
  if (graph.events.length > 0) {
    preserved.push({
      description: `${graph.events.length} existing accounting event(s) stay unchanged`,
      entityNumber: null,
      entityType: "accounting_event",
    });
  }
  preserved.push({
    description: "Audit trail and order history stay unchanged",
    entityNumber: null,
    entityType: "audit_trail",
  });
  return preserved;
}

function commonWarnings(graph: OrderDependencyGraph): RepairIssue[] {
  const warnings: RepairIssue[] = [
    issue("ORDER_STATUS_UNCHANGED", "The order's delivery and settlement status stay unchanged."),
  ];
  if (graph.receivables.some((row) => !row.current)) {
    warnings.push(
      issue("HISTORICAL_RECEIVABLE_PRESERVED", "Historical receivables stay as history and are not reused."),
    );
  }
  if (graph.offsets.some((row) => !row.current)) {
    warnings.push(
      issue(
        "HISTORICAL_SETTLEMENT_PRESERVED",
        "Historical settlement offsets (reversed settlements) stay as history and are not counted.",
      ),
    );
  }
  if (!graph.accountingEnabled) {
    warnings.push(
      issue("ACCOUNTING_OFF_NO_GL_EVENT", "GL Accounting is OFF: no accounting event or journal is created."),
    );
  } else if (graph.currentPeriodStatus !== "open") {
    warnings.push(
      issue(
        "FISCAL_PERIOD_NOT_OPEN",
        "Today's accounting period is not open; a captured event would wait until it can post.",
      ),
    );
  }
  return warnings;
}

function processingBlockers(graph: OrderDependencyGraph, entityIds: readonly string[]): RepairIssue[] {
  return graph.events.some(
    (event) => event.processingStatus === "processing" && entityIds.includes(event.sourceEntityId),
  )
    ? [issue("ACCOUNTING_EVENT_PROCESSING", "An affected accounting event is being processed right now.")]
    : [];
}

function crossCompanyBlockers(graph: OrderDependencyGraph): RepairIssue[] {
  return graph.allocations.some((row) => !row.companyMatches) || graph.offsets.some((row) => !row.companyMatches)
    ? [issue("CROSS_COMPANY_DEPENDENCY", "A dependency belongs to another Company.")]
    : [];
}

function current(graph: OrderDependencyGraph): GraphReceivable[] {
  return graph.receivables.filter((row) => row.current);
}

// ------------------------------------------------------- REPAIR RECEIVABLE

/**
 * `OperationsService.repairTraderReceivableInTransaction`, as it behaves:
 *   - refuses (`trader_receivable_not_required`) unless the payment condition
 *     is "customer pays COD, Trader pays fee";
 *   - does nothing (`created: false`) when a non-reversed, non-cancelled
 *     receivable exists (checked under FOR UPDATE);
 *   - otherwise creates ONE `outstanding` service-charge receivable for the
 *     Order's `service_fee`, dated today, plus one Order event; nothing is
 *     created for an amount <= 0;
 *   - the receivable insert fires the capture trigger, which enqueues
 *     `trader_receivable_recognized` only while GL Accounting is ON.
 */
async function previewRepairReceivable(context: RepairPlanContext): Promise<RepairPlan> {
  const { evaluation, graph } = context;
  const order = graph.order;
  const fee = new Decimal(order.serviceFee);
  const due = new Decimal(evaluation.traderDue);
  const blockers: RepairIssue[] = [...crossCompanyBlockers(graph)];
  if (order.paymentCondition !== "customer_pays_cod_trader_pays_fee") {
    blockers.push(
      issue("UNSUPPORTED_PAYMENT_CONDITION", "The certified repair only applies when the Trader pays the fee."),
    );
  }
  if (current(graph).length > 0) {
    blockers.push(
      issue("ACTIVE_RECEIVABLE_EXISTS", "A current receivable already exists, so the repair would create nothing."),
    );
  }
  if (!fee.greaterThan(0)) {
    blockers.push(
      issue("REPAIR_AMOUNT_NOT_POSITIVE", "The order's service fee is not positive, so nothing would be created."),
    );
  } else if (!fee.equals(due)) {
    // The certified repair bills the Order's service fee; the order financial
    // model says the Trader owes `due`. Executing would bill the wrong amount.
    blockers.push(
      issue(
        "REPAIR_AMOUNT_DIFFERS_FROM_FINANCIAL_MODEL",
        `The repair would bill AED ${money(fee.toString())}, but the order financial model says the Trader owes AED ${money(due.toString())}.`,
      ),
    );
  }
  // Phase 3 Prompt 4: the amount is billed only when the Order's own records
  // prove it (THE expected amount rule, company-order-health.service.ts).
  const manualReviewReasons: RepairIssue[] = evaluation.amountProvable ? [] : [EXPECTED_AMOUNT_NOT_PROVABLE];
  // The order's own event and any event of its (historical) receivables.
  blockers.push(...processingBlockers(graph, [order.id, ...graph.receivables.map((row) => row.id)]));
  if (graph.accountingEnabled) {
    // Phase 2 Prompt 4 finding: the new receivable would carry no Company
    // creator, so its recognition event has no operational actor and the
    // certified posting pipeline refuses it (`accounting_event_actor_missing`;
    // journal_entries.created_by_account_id is NOT NULL). Repairing would
    // create an accounting event that can never post -- so it is BLOCKED while
    // GL Accounting is ON. Accounting OFF repairs are unaffected.
    blockers.push(
      issue(
        "PLATFORM_ACTOR_CANNOT_POST_JOURNAL",
        "GL Accounting is ON: a Platform-created receivable's recognition event has no Company actor, and the posting pipeline refuses events without one. Repair it from the Company portal instead.",
      ),
    );
  }
  const changes: ProposedChange[] = [
    {
      action: "create",
      description: `One new current Trader receivable for AED ${money(fee.toString())} (status outstanding)`,
      details: {
        amountDue: money(fee.toString()),
        businessDate: "today",
        createdBy: "No Company creator (Platform Repair Center); the Platform actor is in the repair audit",
        reason: "Order service fee owed by Trader",
        sourceType: "service_charge",
        status: "outstanding",
      },
      entityNumber: null,
      entityType: "trader_receivable",
    },
    {
      action: "create",
      description: "One order event 'trader_receivable.created_from_order'",
      details: { actorRole: "Platform Repair Center", eventType: "trader_receivable.created_from_order" },
      entityNumber: null,
      entityType: "order_event",
    },
    {
      action: "create",
      description: "One immutable Platform repair audit record (actor, reason, before/after fingerprints)",
      details: { table: "platform_repair_executions" },
      entityNumber: null,
      entityType: "platform_repair_execution",
    },
    graph.accountingEnabled
      ? {
          action: "create",
          description:
            "GL Accounting is ON: the receivable's capture trigger enqueues one 'trader_receivable_recognized' accounting event; its journal is created later by the posting pipeline",
          details: { eventType: "trader_receivable_recognized", initialStatus: "received" },
          entityNumber: null,
          entityType: "accounting_event",
        }
      : {
          action: "none",
          description: "GL Accounting is OFF: no accounting event and no journal",
          details: {},
          entityNumber: null,
          entityType: "accounting_event",
        },
    {
      action: "none",
      description: `Order stays ${order.deliveryStatus}; settlement status stays ${order.traderSettlementStatus}`,
      details: {},
      entityNumber: order.orderNumber,
      entityType: "order",
    },
  ];
  return {
    blockers,
    explanation:
      "Re-creates the missing current receivable with the existing certified Repair Trader Receivable operation. History is never reused or deleted.",
    manualReviewReasons,
    preservedHistory: preservedHistory(graph),
    proposedChanges: changes,
    requiredInputs: [],
    requiredPermission: "users_roles.manage",
    title: "Repair Trader Receivable",
    warnings: [
      ...commonWarnings(graph),
      issue(
        "PLATFORM_REPAIR_AUDITED",
        "Executed from the Repair Center, the repair writes an immutable Platform repair audit record; the order event and the receivable record no Company actor.",
      ),
    ],
  };
}

// --------------------------------------------------------- RESET RECEIVABLE

const REVERSAL_REFUSALS: Readonly<Record<string, string>> = {
  trader_receivable_already_reversed: "UNSUPPORTED_RECEIVABLE_STATE",
  trader_receivable_has_physical_collection: "PHYSICAL_COLLECTION_EXISTS",
  trader_receivable_offset_not_reversible: "UNSUPPORTED_SETTLEMENT_STATE",
  trader_receivable_offset_partial: "UNSUPPORTED_SETTLEMENT_STATE",
  trader_settlement_accounting_not_posted: "SETTLEMENT_ACCOUNTING_NOT_POSTED",
  trader_settlement_already_reversed: "UNSUPPORTED_SETTLEMENT_STATE",
  trader_settlement_not_confirmed: "UNSUPPORTED_SETTLEMENT_STATE",
};

/**
 * `OrderMaintenanceService.resetTraderReceivable`, from its OWN read path
 * (`resetPlanFor`) and, for the processed path, the reversal service's OWN
 * inspection (`inspect` -> `refuseReversal` / `planReversal`).
 */
async function previewResetReceivable(context: RepairPlanContext): Promise<RepairPlan> {
  const { graph } = context;
  const blockers: RepairIssue[] = [...crossCompanyBlockers(graph)];
  const warnings: RepairIssue[] = commonWarnings(graph);
  const changes: ProposedChange[] = [];
  const reasonInput: RequiredInput = {
    description: "Mandatory reason recorded in the audit trail",
    name: "reason",
    required: true,
  };
  let requiredPermission = "trader_receivables.reverse";
  const base = {
    explanation:
      "The existing certified Delete / Reset Trader Receivable operation: an unused receivable is deleted; a processed one is financially reversed, never deleted.",
    preservedHistory: preservedHistory(graph),
    requiredInputs: [reasonInput],
    title: "Reset Trader Receivable",
  };
  let plan;
  try {
    plan = await context.maintenance.resetPlanFor(context.db, context.companyId, graph.order.id);
  } catch (error) {
    if (error instanceof ApplicationException) {
      blockers.push(issue("UNSUPPORTED_RECEIVABLE_STATE", "The order has no receivable to reset."));
      return { ...base, blockers, proposedChanges: changes, requiredPermission, warnings };
    }
    throw error;
  }
  const target = graph.receivables.find((row) => row.id === plan.receivableId);
  if (current(graph).length !== 1 || target === undefined || !target.current) {
    // The certified reset acts on the NEWEST receivable. If that is history,
    // or several are current, it would not act on the one this finding is about.
    blockers.push(
      issue(
        "AMBIGUOUS_HISTORY",
        "The certified reset would act on the newest receivable, which is not the single current one.",
      ),
    );
  }
  blockers.push(...processingBlockers(graph, [plan.receivableId]));
  if (plan.action === "physical_delete") {
    requiredPermission = "users_roles.manage";
    changes.push({
      action: "delete",
      description:
        "The UNUSED receivable is deleted: it has no collection, offset, accounting event, journal or credit",
      details: { amountCollected: plan.amountCollected, amountDue: plan.amount },
      entityNumber: plan.receivableNumber,
      entityType: "trader_receivable",
    });
    changes.push({
      action: "create",
      description: "Audit row 'trader_receivable.physical_delete' with the reason",
      details: {},
      entityNumber: null,
      entityType: "audit_event",
    });
  } else if (plan.offsetCount === 0) {
    blockers.push(
      plan.collectionCount > 0
        ? issue(
            "PHYSICAL_COLLECTION_EXISTS",
            "The receivable was physically collected; the certified reset has no path for it.",
          )
        : issue("UNSUPPORTED_RECEIVABLE_STATE", "This processed receivable has no supported reset path."),
    );
  } else {
    const inspected = await context.reversals.inspect(
      context.db,
      context.companyId,
      plan.receivableId,
      graph.accountingEnabled,
    );
    if (inspected.blockedReasonCode !== null) {
      blockers.push(
        issue(
          REVERSAL_REFUSALS[inspected.blockedReasonCode] ?? "UNSUPPORTED_SETTLEMENT_STATE",
          inspected.blockedReason ?? "The certified reversal refuses this state.",
        ),
      );
    }
    changes.push(
      {
        action: "update",
        description: "Receivable becomes 'reversed'; its collected amount stays as history",
        details: { amountCollected: plan.amountCollected, from: plan.receivableStatus, to: "reversed" },
        entityNumber: plan.receivableNumber,
        entityType: "trader_receivable",
      },
      {
        action: "create",
        description: `Compensating Trader Credit for AED ${inspected.traderCompensation} (required by the certified reversal)`,
        details: { amount: inspected.traderCompensation, sourceType: "receivable_offset_reversal" },
        entityNumber: null,
        entityType: "trader_credit",
      },
      {
        action: "none",
        description: `Settlement ${inspected.settlementNumber} stays ${inspected.settlementStatus}; none of its ${inspected.settlementOffsetCount} offset row(s) is written or deleted`,
        details: { untouchedOtherOffsets: inspected.untouchedOffsetCount },
        entityNumber: inspected.settlementNumber,
        entityType: "trader_settlement",
      },
      {
        action: "none",
        description: "No cash moves; the Trader's net position change is AED " + inspected.traderNetPositionChange,
        details: { cashMovement: inspected.physicalCashMovement },
        entityNumber: null,
        entityType: "cash",
      },
      {
        action: "create",
        description: "Audit row 'trader_receivable.reverse_offset' with the reason",
        details: {},
        entityNumber: null,
        entityType: "audit_event",
      },
    );
    if (graph.accountingEnabled) {
      if (inspected.recognitionJournalWillBeReversed) {
        changes.push({
          action: "create",
          description:
            "GL Accounting is ON: the capture trigger enqueues 'trader_receivable_reversed' for the recognition",
          details: { eventType: "trader_receivable_reversed" },
          entityNumber: null,
          entityType: "accounting_event",
        });
      }
      changes.push(
        inspected.creditAccountingCaptured
          ? {
              action: "create",
              description: "The Credit's own 'trader_credit_issued' accounting event is enqueued",
              details: { eventType: "trader_credit_issued" },
              entityNumber: null,
              entityType: "accounting_event",
            }
          : {
              action: "none",
              description:
                "No 'trader_credit_issued' event: the clearing settlement never posted to the ledger",
              details: {},
              entityNumber: null,
              entityType: "accounting_event",
            },
      );
    }
  }
  return { ...base, blockers, proposedChanges: changes, requiredPermission, warnings };
}

// ------------------------------------------------------ REPROCESS ACCOUNTING

/**
 * `AccountingReprocessPrecheckService.execute`: re-queues ONE failed Event for
 * the normal posting processor after its certified precheck passes. The
 * precheck runs under the Company's own Accounting permissions; it is not
 * bridged to the Platform yet, so the preview cannot PROVE it passes. The
 * capability is therefore reported BLOCKED, never READY, until Prompt 3.
 */
async function previewReprocessAccounting(context: RepairPlanContext): Promise<RepairPlan> {
  const { graph } = context;
  const failed = graph.events.filter(
    (event) =>
      event.sourceEntityType === "order" &&
      ["failed", "blocked_configuration"].includes(event.processingStatus),
  );
  const blockers: RepairIssue[] = [];
  const warnings: RepairIssue[] = [
    ...commonWarnings(graph),
    issue(
      "RECOVER_FROM_ACCOUNTING_HEALTH",
      "Accounting recovery executes from Repair Center -> Accounting Health, whose event-scoped preview also fingerprints the accounting configuration, mappings and fiscal periods.",
    ),
  ];
  const target = failed[0];
  if (target === undefined) {
    blockers.push(issue("ACCOUNTING_EVENT_NOT_FOUND", "No failed order accounting event was found."));
  } else {
    // The certified precheck (Phase 2 Prompt 4 adapter), for this exact event.
    // Outside the preview's READ ONLY transaction: the certified precheck takes
    // FOR SHARE locks (see PlatformAccountingRepairAdapter.inspect).
    const inspection = await context.accounting.inspect(null, context.companyId, target.id);
    if (inspection === undefined) {
      blockers.push(issue("ACCOUNTING_EVENT_NOT_FOUND", "The accounting event is not in this Company."));
    } else if (inspection.repairability === "BLOCKED") {
      blockers.push(...inspection.blockers);
    } else if (inspection.repairability !== "READY") {
      blockers.push(
        issue(
          "ACCOUNTING_RECOVERY_NOT_AVAILABLE",
          `Accounting Health classifies this event ${inspection.repairability} (${inspection.classificationCode}).`,
        ),
      );
    }
    if (inspection !== undefined) warnings.push(...inspection.warnings);
  }
  blockers.push(...processingBlockers(graph, [graph.order.id]));
  return {
    blockers,
    explanation:
      "Reprocess the failed order accounting event through the certified accounting pipeline (precheck, re-queue, claim, posting) in one transaction. The Repair Center writes no journal itself.",
    preservedHistory: preservedHistory(graph),
    proposedChanges: failed.map((event) => ({
      action: "update" as const,
      description: `Accounting event '${event.eventType}' posts from '${event.processingStatus}' through the certified pipeline`,
      details: { eventId: event.id, eventType: event.eventType, from: event.processingStatus },
      entityNumber: null,
      entityType: "accounting_event",
    })),
    requiredInputs: [{ description: "Mandatory reason", name: "reason", required: true }],
    requiredPermission: "accounting.post",
    title: "Reprocess Accounting Event",
    warnings,
  };
}

/**
 * Execution: the certified operation itself, with no Company creator (a
 * Platform administrator is not a Company account). Its own guards still
 * apply: payment condition, and no second active receivable under FOR UPDATE.
 */
async function executeRepairReceivable(context: RepairExecutionContext): Promise<RepairExecutionOutcome> {
  const result = await context.operations.repairTraderReceivableInTransaction(
    context.transaction,
    context.companyId,
    context.orderId,
    context.correlationId,
    { actorAccountId: null, actorRole: "Platform Repair Center" },
  );
  return { changed: result.created, summary: { amount: result.amount, created: result.created } };
}

// ------------------------------------------------ RECONCILE RECEIVABLE (Phase 3)

/** Effective money of one receivable, from the graph (same rule as the evaluation). */
function settledOf(graph: OrderDependencyGraph, receivableId: string): Decimal {
  const physical = graph.allocations
    .filter((row) => row.receivableId === receivableId && row.collectionStatus === "confirmed")
    .reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
  const offsets = graph.offsets
    .filter((row) => row.receivableId === receivableId && row.effective)
    .reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
  return physical.plus(offsets);
}

/**
 * `TraderReceivableService.reconcileReceivableStatusInTransaction`: sets ONLY
 * the receivable's status to the domain status rule's value for its own
 * recorded collected amount. READY only when that amount already equals the
 * effective physical collections + effective offsets, so the intended state is
 * proven by the records themselves. Nothing is re-amounted, created or deleted.
 */
async function previewReconcileReceivable(context: RepairPlanContext): Promise<RepairPlan> {
  const { graph } = context;
  const blockers: RepairIssue[] = [...crossCompanyBlockers(graph)];
  const currentRows = current(graph);
  const target = currentRows.length === 1 ? currentRows[0] : undefined;
  if (target === undefined) {
    blockers.push(
      issue("AMBIGUOUS_HISTORY", `The order has ${currentRows.length} current receivables; exactly one is required.`),
    );
  }
  const changes: ProposedChange[] = [];
  if (target !== undefined) {
    const settled = settledOf(graph, target.id);
    const recorded = new Decimal(target.amountCollected);
    const toStatus = expectedReceivableStatus(recorded, target.amountDue);
    if (!recorded.equals(settled)) {
      blockers.push(
        issue(
          "RECORDED_AMOUNT_DOES_NOT_RECONCILE",
          `The receivable records AED ${money(recorded.toString())} collected, but its effective collections and offsets total AED ${money(settled.toString())}; which one is right needs review.`,
        ),
      );
    }
    const ownAllocations = graph.allocations.filter((row) => row.receivableId === target.id && row.collectionStatus === "confirmed");
    if (
      ownAllocations.some(
        (row) =>
          row.collectionTraderId !== target.traderId ||
          new Decimal(row.collectionAllocatedTotal).greaterThan(row.collectionAmountReceived),
      ) ||
      graph.offsets.some((row) => row.receivableId === target.id && row.effective && row.settlementTraderId !== target.traderId)
    ) {
      blockers.push(
        issue("INCONSISTENT_CLEARING_RECORDS", "A collection or settlement of this receivable is itself inconsistent."),
      );
    }
    if (toStatus === target.status) {
      blockers.push(issue("NOTHING_TO_RECONCILE", "The receivable status already follows the domain status rule."));
    }
    blockers.push(...processingBlockers(graph, [target.id]));
    changes.push(
      {
        action: "update",
        description: `Receivable status ${target.status} -> ${toStatus} (the domain status rule for AED ${money(recorded.toString())} collected of AED ${money(target.amountDue)} due); its amounts stay unchanged`,
        details: {
          amountCollected: money(recorded.toString()),
          amountDue: money(target.amountDue),
          effectiveSettled: money(settled.toString()),
          from: target.status,
          to: toStatus,
        },
        entityNumber: target.receivableNumber,
        entityType: "trader_receivable",
      },
      {
        action: "create",
        description: "Audit row 'trader_receivable.status_reconciled' (from / to status, amounts, the rule applied)",
        details: {},
        entityNumber: null,
        entityType: "audit_event",
      },
      {
        action: "create",
        description: "One immutable Platform repair audit record (actor, reason, before/after fingerprints)",
        details: { table: "platform_repair_executions" },
        entityNumber: null,
        entityType: "platform_repair_execution",
      },
      {
        action: "none",
        description:
          "No accounting event and no journal in either Accounting mode: a status change between outstanding / partially collected / collected is not an accounting fact",
        details: {},
        entityNumber: null,
        entityType: "accounting_event",
      },
      {
        action: "none",
        description: "No collection, allocation, settlement, offset or credit is written or deleted",
        details: {},
        entityNumber: null,
        entityType: "trader_collection",
      },
    );
  }
  return {
    blockers,
    explanation:
      "Re-applies the domain status rule to the receivable's own recorded collected amount, which already equals its effective collections and offsets. Status only.",
    preservedHistory: preservedHistory(graph),
    proposedChanges: changes,
    requiredInputs: [],
    requiredPermission: "trader_receivables.reverse",
    title: "Reconcile Trader Receivable status",
    warnings: [
      ...commonWarnings(graph).filter((warning) => warning.code !== "ACCOUNTING_OFF_NO_GL_EVENT"),
      issue("STATUS_ONLY_NO_ACCOUNTING", "Status only: no money, no accounting event and no journal is created in either Accounting mode."),
    ],
  };
}

async function executeReconcileReceivable(context: RepairExecutionContext): Promise<RepairExecutionOutcome> {
  const currentRows = (
    await sql<{ id: string }>`
      select r.id from trader_receivables r
       where r.company_id = ${context.companyId}::uuid and r.source_type = 'service_charge'
         and r.source_reference = (select o.order_number from orders o
                                    where o.id = ${context.orderId}::uuid and o.company_id = ${context.companyId}::uuid)
         and r.status not in ('reversed', 'cancelled')
       order by r.created_at
         for update
    `.execute(context.transaction)
  ).rows;
  if (currentRows.length !== 1) {
    throw new ApplicationException(
      "repair_receivable_ambiguous",
      "Exactly one current receivable is required to reconcile",
      HttpStatus.CONFLICT,
    );
  }
  const result = await context.traderReceivables.reconcileReceivableStatusInTransaction(
    context.transaction,
    context.companyId,
    currentRows[0]!.id,
    context.correlationId,
    { actorAccountId: null, actorRole: "Platform Repair Center" },
  );
  return {
    changed: result.changed,
    summary: {
      amountCollected: result.amountCollected,
      amountDue: result.amountDue,
      fromStatus: result.fromStatus,
      receivableId: result.receivableId,
      toStatus: result.toStatus,
    },
  };
}


// ------------------------------------------ UNUSED RECEIVABLES (Phase 3, Prompt 3)
//
// Both capabilities below only ever CANCEL a receivable (status change, row
// kept, the certified cancel guard re-checked under lock) that carries no
// financial dependency at all -- the same zero-dependency rule that decides
// whether Delete / Reset may delete one (trader-receivable-dependencies.ts).
// Nothing that money has touched is ever changed.

const PLATFORM_ROLE = "Platform Repair Center";

/** Cancelling a RECOGNISED receivable enqueues its recognition reversal as its Company creator. */
function recognisedCancelBlocker(dependencies: TraderReceivableDependencies, receivableNumber: string): RepairIssue[] {
  return dependencies.accountingEventCount > 0 || dependencies.journalCount > 0
    ? [
        issue(
          "PLATFORM_ACTOR_CANNOT_POST_JOURNAL",
          `${receivableNumber} was recognised in the GL: cancelling it enqueues its recognition reversal on behalf of the Company user who created it, and the Platform never acts as a Company user. Cancel it from the Company portal instead.`,
        ),
      ]
    : [];
}

interface DuplicateSelection {
  readonly duplicateId?: string;
  readonly canonicalId?: string;
  readonly reason?: RepairIssue;
}

/**
 * Which current receivable is the provable duplicate. Exactly two current
 * receivables; exactly one of them is `outstanding` with NO operational
 * activity (no collection, offset or credit ever, nothing collected); the
 * other carries the activity, which is what makes it canonical. Age and
 * creator are never evidence.
 */
function duplicateSelection(
  rows: readonly { readonly id: string; readonly status: string }[],
  dependencies: ReadonlyMap<string, TraderReceivableDependencies>,
): DuplicateSelection {
  const idle = rows.filter((row) => {
    const deps = dependencies.get(row.id);
    return row.status === "outstanding" && deps !== undefined && hasNoOperationalActivity(deps);
  });
  if (rows.length !== 2) {
    return {
      reason: issue(
        "AMBIGUOUS_CANONICAL_RECEIVABLE",
        `The order has ${rows.length} current receivables; the certified correction only handles one unused duplicate beside one canonical receivable.`,
      ),
    };
  }
  if (idle.length === 2) {
    return {
      reason: issue(
        "AMBIGUOUS_CANONICAL_RECEIVABLE",
        "Neither current receivable has any collection, settlement offset, credit or money: nothing in the records proves which one is canonical (age is not proof).",
      ),
    };
  }
  if (idle.length === 0) {
    return {
      reason: issue(
        "BOTH_RECEIVABLES_FINANCIALLY_ACTIVE",
        "Both current receivables carry collections, settlement offsets, credits or money; cancelling either would change financial history.",
      ),
    };
  }
  const duplicateId = idle[0]!.id;
  return { canonicalId: rows.find((row) => row.id !== duplicateId)!.id, duplicateId };
}

async function previewCancelDuplicateReceivable(context: RepairPlanContext): Promise<RepairPlan> {
  const { companyId, db, evaluation, graph } = context;
  const blockers: RepairIssue[] = [...crossCompanyBlockers(graph)];
  const manualReviewReasons: RepairIssue[] = [];
  const rows = current(graph);
  const dependencies = await loadReceivableDependencies(db, companyId, rows.map((row) => row.id));
  const selection = duplicateSelection(rows, dependencies);
  if (selection.reason !== undefined) manualReviewReasons.push(selection.reason);
  const duplicate = rows.find((row) => row.id === selection.duplicateId);
  const canonical = rows.find((row) => row.id === selection.canonicalId);
  const changes: ProposedChange[] = [];
  if (duplicate !== undefined && canonical !== undefined) {
    if (!evaluation.owes) {
      manualReviewReasons.push(
        issue("RECEIVABLE_NOT_REQUIRED", "The order rules require no Trader receivable at all; which record should remain needs review."),
      );
    }
    if (!evaluation.amountProvable) manualReviewReasons.push(EXPECTED_AMOUNT_NOT_PROVABLE);
    if (!new Decimal(canonical.amountDue).equals(evaluation.traderDue)) {
      manualReviewReasons.push(
        issue(
          "CANONICAL_AMOUNT_DIFFERS",
          `The canonical receivable ${canonical.receivableNumber} is for AED ${money(canonical.amountDue)}, but the order financial model says the Trader owes AED ${money(evaluation.traderDue)}.`,
        ),
      );
    }
    const settled = settledOf(graph, canonical.id);
    if (
      !settled.equals(canonical.amountCollected) ||
      canonical.status !== expectedReceivableStatus(canonical.amountCollected, canonical.amountDue)
    ) {
      manualReviewReasons.push(
        issue(
          "CANONICAL_RECEIVABLE_INCONSISTENT",
          `The canonical receivable ${canonical.receivableNumber} does not reconcile with its own collections and offsets; it needs review first.`,
        ),
      );
    }
    blockers.push(...recognisedCancelBlocker(dependencies.get(duplicate.id)!, duplicate.receivableNumber));
    blockers.push(...processingBlockers(graph, [duplicate.id, canonical.id]));
    changes.push(
      {
        action: "update",
        description: `Cancel the unused duplicate ${duplicate.receivableNumber} (AED ${money(duplicate.amountDue)}, outstanding, no collection, offset, credit or money): status outstanding -> cancelled; the row is kept`,
        details: { from: "outstanding", to: "cancelled" },
        entityNumber: duplicate.receivableNumber,
        entityType: "trader_receivable",
      },
      {
        action: "none",
        description: `Keep ${canonical.receivableNumber} (AED ${money(canonical.amountDue)}, ${canonical.status}): it carries the order's collections / offsets; nothing about it changes`,
        details: {},
        entityNumber: canonical.receivableNumber,
        entityType: "trader_receivable",
      },
      {
        action: "create",
        description: "Audit row 'trader_receivable.cancel' (no Company actor; role Platform Repair Center)",
        details: {},
        entityNumber: null,
        entityType: "audit_event",
      },
      {
        action: "create",
        description: "One immutable Platform repair audit record (actor, reason, before/after fingerprints)",
        details: { table: "platform_repair_executions" },
        entityNumber: null,
        entityType: "platform_repair_execution",
      },
      {
        action: "none",
        description:
          "No accounting event and no journal: the duplicate was never recognised in the GL, so the capture trigger has nothing to reverse",
        details: {},
        entityNumber: null,
        entityType: "accounting_event",
      },
    );
  }
  return {
    blockers,
    explanation:
      "Cancels the one current receivable that no money, offset or credit has ever touched, keeping the receivable the order's financial activity belongs to. Nothing is deleted.",
    manualReviewReasons,
    preservedHistory: preservedHistory(graph),
    proposedChanges: changes,
    requiredInputs: [],
    requiredPermission: "trader_receivables.create",
    title: "Cancel duplicate Trader Receivable",
    warnings: [
      ...commonWarnings(graph).filter((warning) => warning.code !== "ACCOUNTING_OFF_NO_GL_EVENT"),
      issue("CANCEL_ONLY_NO_DELETE", "Cancellation is a status change; the duplicate stays visible as cancelled history."),
    ],
  };
}

/** The Order's current receivables, locked, inside the execution transaction. */
async function lockCurrentReceivables(context: RepairExecutionContext) {
  return (
    await sql<{ id: string; status: string; receivableNumber: string }>`
      select r.id::text as id, r.status, r.receivable_number as "receivableNumber"
        from trader_receivables r
       where r.company_id = ${context.companyId}::uuid and r.source_type = 'service_charge'
         and r.source_reference = (select o.order_number from orders o
                                    where o.id = ${context.orderId}::uuid and o.company_id = ${context.companyId}::uuid)
         and r.status not in ('reversed', 'cancelled')
       order by r.id
         for update
    `.execute(context.transaction)
  ).rows;
}

async function executeCancelDuplicateReceivable(context: RepairExecutionContext): Promise<RepairExecutionOutcome> {
  // Re-prove the selection under the receivable locks: a collection, offset or
  // credit that arrived since the preview makes it ambiguous and refuses.
  const rows = await lockCurrentReceivables(context);
  const dependencies = await loadReceivableDependencies(context.transaction, context.companyId, rows.map((row) => row.id));
  const selection = duplicateSelection(rows, dependencies);
  if (selection.duplicateId === undefined) {
    throw new ApplicationException(
      "repair_receivable_ambiguous",
      selection.reason?.message ?? "The duplicate receivable cannot be proven",
      HttpStatus.CONFLICT,
    );
  }
  if (recognisedCancelBlocker(dependencies.get(selection.duplicateId)!, "").length > 0) {
    throw new ApplicationException(
      "repair_requires_company_accounting_actor",
      "The duplicate was recognised in the GL; it must be cancelled from the Company portal",
      HttpStatus.CONFLICT,
    );
  }
  const result = await context.traderReceivables.cancelReceivableInTransaction(
    context.transaction,
    context.companyId,
    selection.duplicateId,
    "Duplicate current receivable with no financial activity (Platform Repair Center)",
    context.correlationId,
    { actorAccountId: null, actorRole: PLATFORM_ROLE },
  );
  return {
    changed: true,
    summary: {
      canonicalReceivableId: selection.canonicalId ?? null,
      cancelledReceivableId: result.receivableId,
      status: result.status,
    },
  };
}

async function previewReplaceUnusedReceivable(context: RepairPlanContext): Promise<RepairPlan> {
  const { companyId, db, evaluation, graph } = context;
  const order = graph.order;
  const blockers: RepairIssue[] = [...crossCompanyBlockers(graph)];
  const manualReviewReasons: RepairIssue[] = [];
  const rows = current(graph);
  const target = rows.length === 1 ? rows[0] : undefined;
  const due = new Decimal(evaluation.traderDue);
  const fee = new Decimal(order.serviceFee);
  const changes: ProposedChange[] = [];
  if (target === undefined) {
    manualReviewReasons.push(
      issue("AMBIGUOUS_CANONICAL_RECEIVABLE", `The order has ${rows.length} current receivables; exactly one is required.`),
    );
  } else {
    const dependencies = (await loadReceivableDependencies(db, companyId, [target.id])).get(target.id)!;
    if (target.status !== "outstanding" || !hasNoOperationalActivity(dependencies)) {
      manualReviewReasons.push(
        issue(
          "RECEIVABLE_HAS_FINANCIAL_ACTIVITY",
          `${target.receivableNumber} already carries collections, settlement offsets, credits or money (${dependencies.collectionCount} allocation(s), ${dependencies.offsetCount} offset(s), ${dependencies.traderCreditCount} credit(s), AED ${money(dependencies.amountCollected)} collected). Changing its amount would change what was already paid; re-amounting needs review.`,
        ),
      );
    } else if (!hasNoFinancialDependencies(dependencies)) {
      blockers.push(...recognisedCancelBlocker(dependencies, target.receivableNumber));
    }
    if (!evaluation.amountProvable) manualReviewReasons.push(EXPECTED_AMOUNT_NOT_PROVABLE);
    if (order.paymentCondition !== "customer_pays_cod_trader_pays_fee" || !due.greaterThan(0)) {
      manualReviewReasons.push(
        issue("RECEIVABLE_NOT_REQUIRED", "The order rules require no Trader receivable; which record should remain needs review."),
      );
    }
    if (!fee.equals(due)) {
      blockers.push(
        issue(
          "REPAIR_AMOUNT_DIFFERS_FROM_FINANCIAL_MODEL",
          `The certified re-creation bills the order's service fee (AED ${money(fee.toString())}), but the order financial model says the Trader owes AED ${money(due.toString())}.`,
        ),
      );
    }
    if (graph.accountingEnabled) {
      blockers.push(
        issue(
          "PLATFORM_ACTOR_CANNOT_POST_JOURNAL",
          "GL Accounting is ON: the re-created receivable's recognition event would have no Company actor, and the posting pipeline refuses events without one. Correct it from the Company portal instead.",
        ),
      );
    }
    blockers.push(...processingBlockers(graph, [order.id, target.id]));
    changes.push(
      {
        action: "update",
        description: `Cancel ${target.receivableNumber} (AED ${money(target.amountDue)}, outstanding, never collected, offset, credited or recognised): status outstanding -> cancelled; the row is kept`,
        details: { from: "outstanding", to: "cancelled" },
        entityNumber: target.receivableNumber,
        entityType: "trader_receivable",
      },
      {
        action: "create",
        description: `Re-create the current receivable with the certified Repair Trader Receivable for AED ${money(fee.toString())} (the amount the order financial model says the Trader owes)`,
        details: { amountDue: money(fee.toString()), status: "outstanding" },
        entityNumber: null,
        entityType: "trader_receivable",
      },
      {
        action: "create",
        description: "Audit row 'trader_receivable.cancel' and order event 'trader_receivable.created_from_order' (no Company actor; role Platform Repair Center)",
        details: {},
        entityNumber: null,
        entityType: "audit_event",
      },
      {
        action: "create",
        description: "One immutable Platform repair audit record (actor, reason, before/after fingerprints)",
        details: { table: "platform_repair_executions" },
        entityNumber: null,
        entityType: "platform_repair_execution",
      },
      {
        action: "none",
        description: "GL Accounting is OFF: no accounting event and no journal",
        details: {},
        entityNumber: null,
        entityType: "accounting_event",
      },
    );
  }
  return {
    blockers,
    explanation:
      "Replaces a receivable that nothing has ever touched (no collection, offset, credit, money or GL recognition) and whose amount disagrees with the order: the certified cancel, then the certified Repair Trader Receivable for the proven amount. Nothing is re-amounted in place or deleted.",
    manualReviewReasons,
    preservedHistory: preservedHistory(graph),
    proposedChanges: changes,
    requiredInputs: [],
    requiredPermission: "users_roles.manage",
    title: "Replace unused Trader Receivable",
    warnings: [
      ...commonWarnings(graph),
      issue("CANCEL_ONLY_NO_DELETE", "The wrong-amount receivable stays visible as cancelled history."),
    ],
  };
}

async function executeReplaceUnusedReceivable(context: RepairExecutionContext): Promise<RepairExecutionOutcome> {
  // GL Accounting must stay OFF until commit: a share lock on the
  // configuration row makes a concurrent switch-on wait for this repair.
  const accounting = (
    await sql<{ enabled: boolean }>`
      select accounting_enabled as enabled from accounting_configurations
       where company_id = ${context.companyId}::uuid for share
    `.execute(context.transaction)
  ).rows[0];
  if (accounting?.enabled === true) {
    throw new ApplicationException(
      "repair_requires_company_accounting_actor",
      "GL Accounting is ON; the receivable must be corrected from the Company portal",
      HttpStatus.CONFLICT,
    );
  }
  const rows = await lockCurrentReceivables(context);
  const target = rows.length === 1 ? rows[0]! : undefined;
  const dependencies =
    target === undefined
      ? undefined
      : (await loadReceivableDependencies(context.transaction, context.companyId, [target.id])).get(target.id);
  if (target === undefined || dependencies === undefined || target.status !== "outstanding" || !hasNoFinancialDependencies(dependencies)) {
    throw new ApplicationException(
      "repair_receivable_not_unused",
      "The receivable is no longer unused; refresh the Order details",
      HttpStatus.CONFLICT,
    );
  }
  await context.traderReceivables.cancelReceivableInTransaction(
    context.transaction,
    context.companyId,
    target.id,
    "Unused receivable with an amount that does not match the order (Platform Repair Center)",
    context.correlationId,
    { actorAccountId: null, actorRole: PLATFORM_ROLE },
  );
  const created = await context.operations.repairTraderReceivableInTransaction(
    context.transaction,
    context.companyId,
    context.orderId,
    context.correlationId,
    { actorAccountId: null, actorRole: PLATFORM_ROLE },
  );
  return {
    changed: created.created,
    summary: { amount: created.amount, cancelledReceivableId: target.id, created: created.created },
  };
}

// ------------------------------------------------------------------ registry

export const REPAIR_CAPABILITIES: readonly RepairCapability[] = [
  {
    accountingModeRestrictions:
      "Both modes. ON: the receivable capture trigger enqueues 'trader_receivable_recognized'. OFF: no accounting.",
    auditRequirement: "Order event 'trader_receivable.created_from_order' (the operation writes no audit_events row).",
    capabilityCode: "REPAIR_TRADER_RECEIVABLE",
    decision: "deterministic",
    description: "Create the missing current Trader receivable for an Order whose Trader owes the fee.",
    domain: "TRADER_RECEIVABLE",
    executionHandler: "OperationsService.repairTraderReceivableInTransaction",
    idempotencyStrategy:
      "Active-receivable guard under FOR UPDATE: a repeat finds the created receivable and returns created=false.",
    knownBlockers: [
      "PLATFORM_ACTOR_CANNOT_POST_JOURNAL",
      "UNSUPPORTED_PAYMENT_CONDITION",
      "ACTIVE_RECEIVABLE_EXISTS",
      "REPAIR_AMOUNT_NOT_POSITIVE",
      "REPAIR_AMOUNT_DIFFERS_FROM_FINANCIAL_MODEL",
      "EXPECTED_AMOUNT_NOT_PROVABLE",
      "ACCOUNTING_EVENT_PROCESSING",
      "CROSS_COMPANY_DEPENDENCY",
    ],
    preview: previewRepairReceivable,
    execution: { available: true, execute: executeRepairReceivable },
    requiredInputs: [],
    requiredPermission: "users_roles.manage",
    supportedReasonCodes: ["MISSING_RECEIVABLE", "REVERSED_NEEDS_REPAIR"],
  },
  {
    accountingModeRestrictions:
      "Both modes, identically: a status change between outstanding / partially_collected / collected enqueues no accounting event and needs no journal.",
    auditRequirement: "Audit 'trader_receivable.status_reconciled' (from / to, amounts, rule) plus the immutable Platform repair execution.",
    capabilityCode: "RECONCILE_TRADER_RECEIVABLE",
    decision: "deterministic",
    description:
      "Set a current receivable's status to the domain status rule's value for its own recorded collected amount, when that amount already equals its effective collections and offsets.",
    domain: "TRADER_RECEIVABLE",
    executionHandler: "TraderReceivableService.reconcileReceivableStatusInTransaction",
    idempotencyStrategy:
      "Receivable row lock; a receivable already in the rule's status returns changed=false (repair_no_change); the repair idempotency key replays the first result.",
    knownBlockers: [
      "AMBIGUOUS_HISTORY",
      "RECORDED_AMOUNT_DOES_NOT_RECONCILE",
      "INCONSISTENT_CLEARING_RECORDS",
      "NOTHING_TO_RECONCILE",
      "ACCOUNTING_EVENT_PROCESSING",
      "CROSS_COMPANY_DEPENDENCY",
    ],
    preview: previewReconcileReceivable,
    execution: { available: true, execute: executeReconcileReceivable },
    requiredInputs: [],
    requiredPermission: "trader_receivables.reverse",
    supportedReasonCodes: [
      "RECEIVABLE_MARKED_COLLECTED_WITHOUT_EFFECTIVE_SETTLEMENT",
      "FINANCIALLY_SETTLED_BUT_RECEIVABLE_STATE_OPEN",
      "RECEIVABLE_PARTIAL_STATE_MISMATCH",
    ],
  },
  {
    accountingModeRestrictions:
      "Both modes. ON: recognition reversal via the capture trigger; the Credit's event only when the clearing settlement belongs to the ledger.",
    auditRequirement: "Audit 'trader_receivable.physical_delete' or 'trader_receivable.reverse_offset', with the mandatory reason.",
    capabilityCode: "RESET_TRADER_RECEIVABLE",
    decision: "requires_review",
    description:
      "Delete an unused Trader receivable, or financially reverse a settlement-offset receivable with a compensating Trader Credit.",
    domain: "TRADER_RECEIVABLE",
    executionHandler: "OrderMaintenanceService.resetTraderReceivableInTransaction",
    idempotencyStrategy:
      "Preview race check (receivable id + path), receivable status check, one live Credit per receivable (unique index), accounting event uniqueness.",
    knownBlockers: [
      "AMBIGUOUS_HISTORY",
      "PHYSICAL_COLLECTION_EXISTS",
      "UNSUPPORTED_SETTLEMENT_STATE",
      "SETTLEMENT_ACCOUNTING_NOT_POSTED",
      "UNSUPPORTED_RECEIVABLE_STATE",
      "ACCOUNTING_EVENT_PROCESSING",
      "CROSS_COMPANY_DEPENDENCY",
    ],
    preview: previewResetReceivable,
    execution: {
      available: false,
      reason: "Reset is shown for manual review only; it is not executable from the Repair Center.",
    },
    requiredInputs: [{ description: "Mandatory reason", name: "reason", required: true }],
    requiredPermission: "trader_receivables.reverse",
    supportedReasonCodes: ["RECEIVABLE_NOT_REQUIRED_BUT_ACTIVE"],
  },
  {
    accountingModeRestrictions: "Accounting ON only.",
    auditRequirement: "The reprocess records its reason on the Event history.",
    capabilityCode: "REPROCESS_ACCOUNTING_EVENT",
    decision: "deterministic",
    description: "Re-queue a failed order accounting event after the certified precheck passes.",
    domain: "ACCOUNTING",
    executionHandler: "PlatformAccountingRepairAdapter.reprocessInTransaction",
    idempotencyStrategy:
      "Repair idempotency key per (Company, capability, Event); the event row lock, the certified readiness guard and the 'posted' state prevent a second journal.",
    knownBlockers: [
      "accounting_event_mapping_*",
      "accounting_event_period_closed",
      "accounting_event_fiscal_year_closed",
      "accounting_event_actor_missing",
      "automatic_posting_disabled",
      "operational_area_disabled",
      "ACCOUNTING_EVENT_PROCESSING",
    ],
    preview: previewReprocessAccounting,
    execution: {
      available: false,
      reason:
        "Executes from Repair Center -> Accounting Health (event-scoped preview and fingerprint), not from the Order route.",
    },
    requiredInputs: [{ description: "Mandatory reason", name: "reason", required: true }],
    requiredPermission: "accounting.post",
    supportedReasonCodes: ["ACCOUNTING_EVENT_FAILED"],
  },
  {
    accountingModeRestrictions:
      "Both modes, only for a duplicate never recognised in the GL (no accounting event or journal): the cancel then enqueues nothing. A recognised duplicate is BLOCKED (its reversal would be attributed to its Company creator).",
    auditRequirement: "Audit 'trader_receivable.cancel' (no Company actor, role Platform Repair Center) plus the immutable Platform repair execution.",
    capabilityCode: "CANCEL_DUPLICATE_TRADER_RECEIVABLE",
    decision: "deterministic",
    description:
      "Cancel the one current receivable of an Order that no collection, offset, credit or money has ever touched, when the Order's other current receivable carries its financial activity and reconciles.",
    domain: "TRADER_RECEIVABLE",
    executionHandler: "TraderReceivableService.cancelReceivableInTransaction",
    idempotencyStrategy:
      "Receivable row locks; the selection is re-proven under the locks; a cancelled duplicate is no longer current, so a repeat finds no finding (repair_finding_not_current); the repair idempotency key replays the first result.",
    knownBlockers: [
      "AMBIGUOUS_CANONICAL_RECEIVABLE",
      "BOTH_RECEIVABLES_FINANCIALLY_ACTIVE",
      "CANONICAL_AMOUNT_DIFFERS",
      "CANONICAL_RECEIVABLE_INCONSISTENT",
      "RECEIVABLE_NOT_REQUIRED",
      "PLATFORM_ACTOR_CANNOT_POST_JOURNAL",
      "ACCOUNTING_EVENT_PROCESSING",
      "CROSS_COMPANY_DEPENDENCY",
    ],
    preview: previewCancelDuplicateReceivable,
    execution: { available: true, execute: executeCancelDuplicateReceivable },
    requiredInputs: [],
    requiredPermission: "trader_receivables.create",
    supportedReasonCodes: ["MULTIPLE_ACTIVE_RECEIVABLES"],
  },
  {
    accountingModeRestrictions:
      "Accounting OFF only (the re-created receivable's recognition would need a Company actor): BLOCKED with PLATFORM_ACTOR_CANNOT_POST_JOURNAL while GL Accounting is ON.",
    auditRequirement:
      "Audit 'trader_receivable.cancel' and order event 'trader_receivable.created_from_order' (no Company actor) plus the immutable Platform repair execution.",
    capabilityCode: "REPLACE_UNUSED_TRADER_RECEIVABLE",
    decision: "deterministic",
    description:
      "Cancel a never-used receivable whose amount disagrees with the order, and re-create it with the certified Repair Trader Receivable for the proven amount.",
    domain: "TRADER_RECEIVABLE",
    executionHandler:
      "TraderReceivableService.cancelReceivableInTransaction + OperationsService.repairTraderReceivableInTransaction",
    idempotencyStrategy:
      "Accounting configuration share lock, receivable row lock, zero-dependency re-check under the lock; afterwards the amount matches, so a repeat finds no finding; the repair idempotency key replays the first result.",
    knownBlockers: [
      "RECEIVABLE_HAS_FINANCIAL_ACTIVITY",
      "EXPECTED_AMOUNT_NOT_PROVABLE",
      "RECEIVABLE_NOT_REQUIRED",
      "REPAIR_AMOUNT_DIFFERS_FROM_FINANCIAL_MODEL",
      "PLATFORM_ACTOR_CANNOT_POST_JOURNAL",
      "ACCOUNTING_EVENT_PROCESSING",
      "CROSS_COMPANY_DEPENDENCY",
    ],
    preview: previewReplaceUnusedReceivable,
    execution: { available: true, execute: executeReplaceUnusedReceivable },
    requiredInputs: [],
    requiredPermission: "users_roles.manage",
    supportedReasonCodes: ["RECEIVABLE_AMOUNT_MISMATCH"],
  },
];

export function capabilityFor(reasonCode: OrderHealthReasonCode): RepairCapability | undefined {
  return REPAIR_CAPABILITIES.find((capability) => capability.supportedReasonCodes.includes(reasonCode));
}
