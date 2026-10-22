import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql, type Transaction } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import {
  effectiveOffset,
  effectiveOffsetTotal,
  effectiveSettlement,
} from "./effective-settlement-offsets.js";
import {
  CompanyOrderHealthService,
  ORDER_HEALTH_REASONS,
  type OrderHealthReasonCode,
} from "./company-order-health.service.js";
import { OperationsHistoryWriter } from "./operations-history.writer.js";
import { ReceivableOffsetReversalService } from "./receivable-offset-reversal.service.js";
import type {
  FinancialVerificationClassification,
  OrderFinancialHealth,
} from "./order-financial-classification.js";
import { traderPaysCodShortfall } from "./cod-shortfall.js";
import { calculateOrderFinancials, type VatPolicy } from "./order-financial-model.js";
import type { CapabilityCode } from "./repair-capability.registry.js";
import type { Repairability } from "./repair-center.model.js";
import { loadOrderDependencyGraph } from "./repair-dependency-graph.js";
import { previewTraderReceivableFinding } from "./repair-finding-preview.js";
import {
  hasNoFinancialDependencies,
  receivableDependencyColumnsSql,
  type TraderReceivableDependencies,
} from "./trader-receivable-dependencies.js";
import {
  correlatedReceivableInputs,
  receivableAnomalySql,
} from "./trader-receivable-reconciliation.js";

/**
 * Order Maintenance: diagnose one Order completely, in one request.
 *
 * The reason this exists is a measured one. Working out what was wrong with a
 * single Order -- ORD-000108, which turned out to be entirely correct -- took
 * three hours of reading code and running ad-hoc SQL. Every question asked
 * along the way ("is there a receivable?", "who set that status?", "why is
 * the amount zero?") is answerable from data the system already holds. This
 * service asks all of them at once and reports the answers together.
 *
 * PHASE 1 IS READ-ONLY. Nothing here changes an Order, a Receivable or a
 * Settlement. It writes exactly one thing: rows in
 * `order_maintenance_findings`, which is a diagnosis log, not an accounting
 * record. Repairs come later, per check, once the diagnosis has been trusted
 * against real data -- the same detector-first discipline
 * `IntegrityCheckService` already follows.
 *
 * The checks run in TypeScript over a snapshot gathered by a handful of
 * queries, rather than as ten separate SQL checks. That is deliberate: the
 * same snapshot becomes the copy-paste diagnostic below, so a problem this
 * service cannot name can still be handed to someone who can, complete,
 * instead of being rediscovered question by question.
 */

export type OrderMaintenanceSeverity = "error" | "warning" | "info";

export interface OrderMaintenanceFinding {
  readonly checkCode: string;
  readonly severity: OrderMaintenanceSeverity;
  readonly title: string;
  /** What the check compared, in the operator's terms. */
  readonly detail: string;
  readonly evidence: Readonly<Record<string, string | number | null>>;
  /** True only where a repair is unambiguous. Always false in phase 1. */
  readonly fixable: boolean;
}

interface OrderSnapshotRow {
  readonly additionalFees: string | null;
  readonly amountCollected: string | null;
  readonly codAmount: string;
  readonly createdAt: string;
  readonly customerAmountDue: string | null;
  readonly deliveredAt: string | null;
  readonly deliveryStatus: string;
  readonly driverReconciliationStatus: string;
  readonly id: string;
  readonly isFreeOrder: boolean | null;
  readonly operationalCompletedAt: string | null;
  readonly orderDate: string | null;
  readonly orderNumber: string;
  readonly paymentCondition: string;
  readonly referenceNumber: string | null;
  readonly returnStatus: string;
  readonly serialNumber: string | null;
  readonly serviceFee: string;
  readonly traderId: string | null;
  readonly traderName: string | null;
  readonly traderNetPayable: string | null;
  readonly traderSettlementStatus: string;
  readonly updatedAt: string;
}

interface HistoryRow {
  readonly changedBy: string | null;
  readonly fromStatus: string | null;
  readonly occurredAt: string;
  readonly reason: string | null;
  readonly statusDimension: string;
  readonly toStatus: string;
}

interface EventRow {
  readonly actor: string | null;
  readonly eventType: string;
  readonly fieldName: string | null;
  readonly newValue: string | null;
  readonly occurredAt: string;
  readonly previousValue: string | null;
  readonly reason: string | null;
  readonly source: string | null;
}

interface ReceivableRow {
  readonly amountCollected: string;
  readonly clearedByCollections: string | null;
  readonly clearedBySettlements: string | null;
  readonly createdAt: string;
  readonly earliestClearedAt: string | null;
  readonly id: string;
  readonly originalAmountDue: string;
  readonly outstandingAmount: string;
  readonly receivableNumber: string;
  readonly status: string;
}

interface SettlementRow {
  readonly allocatedAmount: string | null;
  readonly businessDate: string | null;
  readonly confirmedAt: string | null;
  readonly netPayable: string | null;
  readonly settlementNumber: string;
  readonly status: string;
}

export interface OrderMaintenanceReport {
  readonly order: OrderSnapshotRow;
  readonly history: readonly HistoryRow[];
  readonly events: readonly EventRow[];
  readonly receivables: readonly ReceivableRow[];
  readonly settlements: readonly SettlementRow[];
  readonly expectedTraderReceivableDue: string;
  readonly findings: readonly OrderMaintenanceFinding[];
  /** The whole snapshot as text, for pasting into a support conversation. */
  readonly diagnostic: string;
}

// The financial-dependency rule lives in trader-receivable-dependencies.ts
// (shared with the Repair Center); re-exported here for existing importers.
export {
  hasNoFinancialDependencies,
  type TraderReceivableDependencies,
} from "./trader-receivable-dependencies.js";

export interface TraderReceivableResetPreview extends TraderReceivableDependencies {
  readonly receivableId: string;
  readonly receivableNumber: string;
  readonly receivableStatus: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly amount: string;
  readonly physicalDeletePossible: boolean;
  readonly action: "physical_delete" | "financial_reset";
  /**
   * Permission the backend will demand to EXECUTE this action. A processed
   * Receivable is a financial reversal and needs `trader_receivables.reverse`
   * specifically; the broad maintenance permission does not substitute.
   */
  readonly requiredPermission: "users_roles.manage" | "trader_receivables.reverse";
}

// The classification vocabulary lives in a dependency-free module so that
// Company Health (which makes the decision) and Verify First (which reads it)
// share it without an import cycle. Re-exported here for existing importers.
export {
  type FinancialVerificationClassification,
  ORDER_FINANCIAL_HEALTH,
  type OrderFinancialHealth,
  orderFinancialHealth,
} from "./order-financial-classification.js";

/** One settlement offset of the Order's Receivables, effective or historical. */
export interface FinancialVerificationOffset {
  readonly settlementNumber: string;
  readonly receivableNumber: string;
  /** Status of the Receivable the offset cleared (e.g. `reversed`). */
  readonly receivableStatus: string;
  readonly amount: string;
  /**
   * True when the offset currently counts (its Settlement is confirmed, not a
   * reversal and not reversed -- effective-settlement-offsets.ts). False for
   * a HISTORICAL offset of a reversed Settlement: shown, never counted.
   */
  readonly effective: boolean;
}

/**
 * Verify First (Repair Center Phase 3, Prompt 2: ONE FINANCIAL TRUTH).
 *
 * Every decision field below is READ from the shared evaluation
 * (`CompanyOrderHealthService.orderEvaluation`, built on the receivable
 * reconciliation of trader-receivable-reconciliation.ts) and the shared
 * repairability rule (repair-finding-preview.ts). Verify First has no
 * classification chain of its own, so it cannot disagree with Company / Order
 * Health or the Repair Preview.
 */
export interface FinancialVerification {
  /**
   * The Trader receivable reason code -- the SAME code Company Health and the
   * Repair Center use (`OrderHealthEvaluation.financialCode`), healthy or not.
   */
  readonly reasonCode: OrderHealthReasonCode;
  /**
   * `reasonCode` when the classification is RECEIVABLE_INCONSISTENT or
   * NEEDS_REVIEW (the exact reconciliation finding), else null.
   */
  readonly anomalyCode: OrderHealthReasonCode | null;
  readonly classification: FinancialVerificationClassification;
  /** The Trader receivable finding's health (see ORDER_FINANCIAL_HEALTH). */
  readonly health: OrderFinancialHealth;
  /** False exactly when `health` is HEALTHY: nothing to reset, repair or review. */
  readonly actionRequired: boolean;
  /**
   * The Repair Center's repairability of the Trader receivable finding,
   * computed by the same rule and the same capability preview as the Repair
   * Preview: NOT_REQUIRED (healthy), READY, BLOCKED or MANUAL_REVIEW.
   */
  readonly repairability: Repairability;
  /** The certified Repair Center capability for the finding, if any. */
  readonly repairCapability: CapabilityCode | null;
  /** The Order's overall Company Health (it may also carry accounting / Driver Cash findings). */
  readonly orderHealth: OrderFinancialHealth;
  /** Every non-healthy finding of the Order, most severe first (Company Health). */
  readonly findingCodes: readonly OrderHealthReasonCode[];
  readonly reason: string;
  readonly order: Readonly<Record<string, string | null>>;
  readonly traderOwes: string;
  readonly receivables: readonly Readonly<Record<string, string | null>>[];
  readonly physicalCollectionAmount: string;
  /**
   * EFFECTIVE settlement offsets of the Order's CURRENT (not reversed, not
   * cancelled) Receivables. Historical offsets are never counted, and the
   * offset of a Receivable that was itself reversed (compensated by a Trader
   * Credit) is listed in `settlementOffsets` but is not current state.
   */
  readonly settlementOffsetAmount: string;
  /** Settlements whose offsets are currently effective. */
  readonly settlementNumbers: readonly string[];
  /** Offsets of reversed Settlements: history, not current financial state. */
  readonly historicalSettlementOffsetAmount: string;
  readonly historicalSettlementNumbers: readonly string[];
  /** Every offset, effective and historical, flagged. */
  readonly settlementOffsets: readonly FinancialVerificationOffset[];
  readonly journals: readonly Readonly<Record<string, string | null>>[];
  /**
   * The Company-side action: `repair` only for a missing / only-reversed
   * receivable (MISSING_RECEIVABLE, REVERSED_NEEDS_REPAIR). Everything else is
   * `none`. A receivable settled by an effective offset is HEALTHY and is
   * NEVER reset (`reset_then_repair` was removed in Phase 3 Prompt 2).
   */
  readonly recommendedAction: "none" | "repair";
}

@Injectable()
export class OrderMaintenanceService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(OperationsHistoryWriter) private readonly historyWriter: OperationsHistoryWriter,
    @Inject(ReceivableOffsetReversalService) private readonly offsetReversals: ReceivableOffsetReversalService,
    @Inject(CompanyOrderHealthService) private readonly orderHealth: CompanyOrderHealthService,
  ) {}

  /**
   * Delete / Reset Trader Receivable -- preview. Read-only.
   *
   * Reports which of the two paths the action will take:
   *   - `physical_delete`  only for a Receivable with ZERO financial
   *     dependencies (see `hasNoFinancialDependencies`);
   *   - `financial_reset`  for anything else, executed by the receivable-scoped
   *     settlement-offset reversal, which never deletes and never touches the
   *     Settlement.
   */
  public async receivableResetPreview(orderId: string): Promise<TraderReceivableResetPreview> {
    this.assertAnyPermission(["users_roles.manage", "trader_receivables.reverse"]);
    const { companyId } = this.tenants.current();
    return this.classify(await this.resetRow(this.database, companyId, orderId, false));
  }

  /**
   * The SAME Delete / Reset classification `receivableResetPreview` returns,
   * for the Platform Repair Center's read-only repair preview. It takes the
   * caller's (read-only) transaction and an explicit Company, and performs NO
   * permission check of its own: it only reads, and it never authorizes the
   * reset itself -- execution still goes through `resetTraderReceivable`,
   * which demands the exact domain permission. Throws
   * `trader_receivable_not_found` when the Order has no Receivable.
   */
  public async resetPlanFor(
    database: Kysely<DatabaseSchema>,
    companyId: string,
    orderId: string,
  ): Promise<TraderReceivableResetPreview> {
    return this.classify(await this.resetRow(database, companyId, orderId, false));
  }

  /**
   * Read-only financial verification for one already company-scoped Order.
   *
   * Phase 3 Prompt 2: the classification, reason code, health, action and
   * repairability all come from the shared evaluation
   * (`CompanyOrderHealthService.orderEvaluation`) and the shared repairability
   * rule (`previewTraderReceivableFinding`). The queries below only gather the
   * evidence shown to the administrator. Everything runs in ONE read-only
   * transaction, so the evidence and the decision describe the same state.
   */
  public async financialVerification(orderId: string): Promise<FinancialVerification> {
    const { companyId } = this.tenants.current();
    return this.database.transaction().execute(async (db) => {
      await sql`set transaction read only`.execute(db);
      return this.verifyIn(db, companyId, orderId);
    });
  }

  private async verifyIn(
    db: Kysely<DatabaseSchema>,
    companyId: string,
    orderId: string,
  ): Promise<FinancialVerification> {
    const orderResult = await sql<Record<string, string | null>>`
      select o.id::text as "orderId", o.order_number as "orderNumber",
             o.serial_number as "serialNumber", o.delivery_status as "deliveryStatus",
             o.service_fee::text as "serviceFee", o.payment_condition as "paymentCondition",
             o.cod_amount::text as "codAmount", o.additional_fees::text as "additionalFees",
             o.trader_id::text as "traderId", t.name_en as trader,
             o.delivered_at::text as "deliveredAt"
        from orders o left join traders t on t.id=o.trader_id and t.company_id=o.company_id
       where o.company_id=${companyId}::uuid and o.id=${orderId}::uuid
    `.execute(db);
    const order = orderResult.rows[0];
    if (!order) throw new ApplicationException("order_not_found", "Order not found", HttpStatus.NOT_FOUND);
    // THE decision: the Company Health evaluation narrowed to this Order.
    const evaluation = await this.orderHealth.orderEvaluation(db, companyId, orderId);
    if (evaluation === undefined) {
      throw new ApplicationException("order_not_found", "Order not found", HttpStatus.NOT_FOUND);
    }
    const receivableResult = await sql<Record<string, string | null>>`
      select r.id::text as id, r.receivable_number as "receivableNumber",
             r.original_amount_due::text as amount, r.outstanding_amount::text as outstanding,
             r.amount_collected::text as "amountCollected", r.status,
             coalesce((select sum(a.amount_allocated) from trader_collection_allocations a
               join trader_collections c on c.id=a.collection_id and c.company_id=a.company_id
              where a.company_id=r.company_id and a.receivable_id=r.id and c.status='confirmed'),0)::text as "physicalAmount",
             -- EFFECTIVE offsets only: SET-A -> SET-A reversal -> SET-B is one
             -- settlement of this Receivable, not two. The single domain rule
             -- lives in effective-settlement-offsets.ts.
             ${effectiveOffsetTotal("r")}::text as "offsetAmount",
             (select count(distinct x.settlement_id)::int from trader_settlement_receivable_offsets x
               where x.company_id=r.company_id and x.receivable_id=r.id
                 and ${effectiveOffset("x")})::text as "effectiveSettlementCount",
             -- Evidence only: which receivable carries the shared
             -- reconciliation finding (trader-receivable-reconciliation.ts).
             ${receivableAnomalySql(correlatedReceivableInputs("r"))} as anomaly
        from trader_receivables r
       where r.company_id=${companyId}::uuid and r.source_type='service_charge'
         and r.source_reference=${order.orderNumber}
       order by r.created_at
    `.execute(db);
    const receivables = receivableResult.rows;
    const physical = receivables.reduce((sum, row) => sum.plus(row.physicalAmount ?? 0), new Decimal(0));
    // Every offset of this Order's Receivables, flagged effective or
    // historical. Historical offsets stay visible but are never counted.
    const offsetResult = await sql<{
      settlementNumber: string;
      receivableNumber: string;
      receivableStatus: string;
      amount: string;
      effective: boolean;
    }>`
      select s.settlement_number as "settlementNumber", r.receivable_number as "receivableNumber",
             r.status as "receivableStatus",
             x.amount_allocated::text as amount, ${effectiveSettlement("s")} as effective
        from trader_settlement_receivable_offsets x
        join trader_settlements s on s.id=x.settlement_id and s.company_id=x.company_id
        join trader_receivables r on r.id=x.receivable_id and r.company_id=x.company_id
       where x.company_id=${companyId}::uuid
         and r.source_type='service_charge' and r.source_reference=${order.orderNumber}
         and s.status='confirmed'
       order by s.settlement_number, r.receivable_number
    `.execute(db);
    const settlementOffsets: FinancialVerificationOffset[] = offsetResult.rows.map((row) => ({
      amount: new Decimal(row.amount).toFixed(2),
      effective: row.effective,
      receivableNumber: row.receivableNumber,
      receivableStatus: row.receivableStatus,
      settlementNumber: row.settlementNumber,
    }));
    const distinctNumbers = (effective: boolean) => [
      ...new Set(settlementOffsets.filter((x) => x.effective === effective).map((x) => x.settlementNumber)),
    ];
    const historicalOffset = settlementOffsets
      .filter((x) => !x.effective)
      .reduce((sum, x) => sum.plus(x.amount), new Decimal(0));
    const journals = await sql<Record<string, string | null>>`
      select distinct j.journal_number as "journalNumber", j.status,
             e.event_type as "eventType", r.receivable_number as "receivableNumber"
        from trader_receivables r
        join accounting_events e on e.company_id=r.company_id and e.source_entity_type='trader_receivable' and e.source_entity_id=r.id
        left join journal_entries j on j.company_id=e.company_id and j.accounting_event_id=e.id
       where r.company_id=${companyId}::uuid and r.source_type='service_charge'
         and r.source_reference=${order.orderNumber}
       order by r.receivable_number, e.event_type
    `.execute(db);
    // Repairability: the Repair Preview's own rule and capability preview.
    const reasonCode = evaluation.financialCode;
    const graph = await loadOrderDependencyGraph(db, companyId, orderId);
    if (graph === undefined) {
      throw new ApplicationException("order_not_found", "Order not found", HttpStatus.NOT_FOUND);
    }
    const finding = await previewTraderReceivableFinding(
      { companyId, db, evaluation, graph, maintenance: this, reversals: this.offsetReversals },
      reasonCode,
    );
    const classification = evaluation.financialClassification;
    const health = finding.health;
    const traderOwes = evaluation.owes ? new Decimal(evaluation.traderDue) : new Decimal(0);
    return {
      actionRequired: health !== "HEALTHY",
      anomalyCode:
        classification === "RECEIVABLE_INCONSISTENT" || classification === "NEEDS_REVIEW" ? reasonCode : null,
      classification,
      findingCodes: evaluation.findingCodes,
      health,
      historicalSettlementNumbers: distinctNumbers(false),
      historicalSettlementOffsetAmount: historicalOffset.toFixed(2),
      journals: journals.rows,
      order,
      orderHealth: evaluation.health,
      physicalCollectionAmount: physical.toFixed(2),
      reason: this.verificationReason(reasonCode, receivables, traderOwes),
      reasonCode,
      receivables,
      recommendedAction:
        reasonCode === "MISSING_RECEIVABLE" || reasonCode === "REVERSED_NEEDS_REPAIR" ? "repair" : "none",
      repairCapability: finding.capability?.capabilityCode ?? null,
      repairability: finding.repairability,
      settlementNumbers: distinctNumbers(true),
      settlementOffsetAmount: new Decimal(evaluation.activeOffset).toFixed(2),
      settlementOffsets,
      traderOwes: traderOwes.toFixed(2),
    };
  }

  /**
   * The administrator sentence for the shared reason code, with this Order's
   * evidence. Wording only: the code itself was decided by the evaluation.
   */
  private verificationReason(
    reasonCode: OrderHealthReasonCode,
    receivables: readonly Readonly<Record<string, string | null>>[],
    traderOwes: Decimal,
  ): string {
    const flagged = receivables.find((row) => row.anomaly === reasonCode);
    if (flagged !== undefined) return this.anomalyMessage(flagged);
    const active = receivables.filter((r) => r.status !== "reversed" && r.status !== "cancelled");
    switch (reasonCode) {
      case "NO_TRADER_RECEIVABLE_REQUIRED":
        return "The current order rules do not require a Trader receivable.";
      case "HEALTHY_ACTIVE_RECEIVABLE":
        return "Receivable is active — Collect from Trader.";
      case "ALREADY_PHYSICALLY_COLLECTED":
        return "Trader payment already physically collected.";
      case "SETTLED_BY_COLLECTION_AND_OFFSET":
        return "Trader payment settled by a physical collection and a settlement offset. No action is required.";
      case "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION":
        return "Receivable was settled by an effective settlement offset. A physical Trader collection is not required; no action is required.";
      case "REVERSED_NEEDS_REPAIR":
        return "Historical receivable is already reversed. Repair Trader Receivable is required.";
      case "MISSING_RECEIVABLE":
        return "Trader Receivable is missing.";
      case "MULTIPLE_ACTIVE_RECEIVABLES":
        return `The Order has ${active.length} active Trader receivables; only one is expected.`;
      case "RECEIVABLE_NOT_REQUIRED_BUT_ACTIVE":
        return "An active Trader receivable exists although the Order's COD already covers the fee.";
      case "RECEIVABLE_AMOUNT_MISMATCH": {
        const current = active[0];
        return current === undefined
          ? ORDER_HEALTH_REASONS[reasonCode].reason
          : `${current.receivableNumber} is for AED ${new Decimal(current.amount ?? 0).toFixed(2)}, but the order requires AED ${traderOwes.toFixed(2)}.`;
      }
      default:
        return ORDER_HEALTH_REASONS[reasonCode].reason;
    }
  }

  /** Administrator sentence for a receivable reconciliation anomaly (Phase 3). */
  private anomalyMessage(r: Readonly<Record<string, string | null>>): string {
    const money = (value: string | number | null | undefined) => Number(value ?? 0).toFixed(2);
    const due = Number(r.amount ?? 0);
    const settled = Number(r.physicalAmount ?? 0) + Number(r.offsetAmount ?? 0);
    switch (r.anomaly) {
      case "MULTIPLE_EFFECTIVE_SETTLEMENTS":
        return `${r.receivableNumber} is offset by more than one effective Settlement (AED ${money(r.offsetAmount)} against AED ${money(due)} due).`;
      case "RECEIVABLE_OVER_COLLECTED":
        return `${r.receivableNumber} has effective collections and offsets of AED ${money(settled)} against AED ${money(due)} due.`;
      case "COLLECTION_ALLOCATION_MISMATCH":
        return `${r.receivableNumber} has a Trader Collection allocation from another Trader or beyond the money that Collection received.`;
      case "ORPHAN_COLLECTION_ALLOCATION":
        return `${r.receivableNumber} is ${r.status ?? ""} but a confirmed Trader Collection is still allocated to it.`;
      case "SETTLEMENT_OFFSET_MISMATCH":
        return `${r.receivableNumber} has an effective settlement offset that does not match it (another Trader, a cancelled receivable, or a reversal without its compensating Trader Credit).`;
      case "RECEIVABLE_COLLECTED_AMOUNT_MISMATCH":
        return `${r.receivableNumber} records AED ${money(r.amountCollected)} collected, but its effective collections and offsets total AED ${money(settled)}.`;
      case "RECEIVABLE_MARKED_COLLECTED_WITHOUT_EFFECTIVE_SETTLEMENT":
        return `${r.receivableNumber} is marked collected, but effective collections and offsets total only AED ${money(settled)} of AED ${money(due)}.`;
      case "FINANCIALLY_SETTLED_BUT_RECEIVABLE_STATE_OPEN":
        return `${r.receivableNumber} is fully settled (AED ${money(settled)} of AED ${money(due)}) but is still ${r.status ?? ""}.`;
      case "RECEIVABLE_PARTIAL_STATE_MISMATCH":
        return `${r.receivableNumber} is ${r.status ?? ""}, but effective collections and offsets total AED ${money(settled)} of AED ${money(due)}.`;
      default:
        return "The receivable and clearing records are inconsistent.";
    }
  }

  /**
   * Delete / Reset Trader Receivable -- execute.
   *
   * The path is decided from the database, never from the caller:
   *
   *   PROCESSED (any financial dependency) -> requires
   *     `trader_receivables.reverse` (the maintenance permission alone is NOT
   *     enough) and delegates to `ReceivableOffsetReversalService.execute`,
   *     which runs in its own transaction: Receivable -> `reversed`,
   *     compensating Trader Credit, `trader_credit_issued` enqueued, audit.
   *     Nothing is deleted. Only the settlement-offset case is supported; any
   *     other processed shape is refused rather than guessed at.
   *
   *   UNUSED (zero dependencies) -> requires `users_roles.manage`, and the
   *     zero-dependency check is RE-RUN under a row lock inside the delete's
   *     own transaction, so a dependency created between preview and execute
   *     turns the delete into a refusal, not a destroyed history.
   */
  public async resetTraderReceivable(
    orderId: string,
    reason: string,
    correlationId: string,
  ): Promise<TraderReceivableResetPreview> {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      throw new ApplicationException(
        "trader_receivable_reset_reason_required",
        "A reason is required",
        HttpStatus.BAD_REQUEST,
      );
    }
    const { companyId } = this.tenants.current();
    const row = this.classify(await this.resetRow(this.database, companyId, orderId, false));
    this.assertExactPermission(row.requiredPermission);
    return this.transactions.execute(async (tx) => {
      return this.resetTraderReceivableInTransaction(tx, companyId, orderId, trimmedReason, correlationId, row);
    });
  }

  public async resetTraderReceivableInTransaction(
    tx: Transaction<DatabaseSchema>,
    companyId: string,
    orderId: string,
    reason: string,
    correlationId: string,
    preview?: TraderReceivableResetPreview,
  ): Promise<TraderReceivableResetPreview> {
    const locked = this.classify(await this.resetRow(tx, companyId, orderId, true));
    if (preview !== undefined && (locked.receivableId !== preview.receivableId || locked.action !== preview.action)) {
      throw new ApplicationException("trader_receivable_reset_race", "The receivable changed; preview it again", HttpStatus.CONFLICT);
    }
    if (locked.action === "financial_reset") {
      if (locked.offsetCount === 0) {
        throw new ApplicationException("trader_receivable_reset_unsupported", "This processed receivable has no supported reset path", HttpStatus.CONFLICT);
      }
      await this.offsetReversals.executeInTransaction(tx, locked.receivableId, reason, correlationId);
      return this.classify(await this.resetRow(tx, companyId, orderId, false));
    }
    const identity = this.identities.current();
    await sql`delete from trader_receivables where company_id=${companyId}::uuid and id=${locked.receivableId}::uuid`.execute(tx);
    await this.historyWriter.audit(tx, {
      action: "trader_receivable.physical_delete", actorId: identity.identityId,
      after: { reason, receivableNumber: locked.receivableNumber }, companyId,
      correlationId, subjectId: locked.receivableId, subjectType: "trader_receivable",
    });
    return locked;
  }

  private classify(
    row: Omit<TraderReceivableResetPreview, "action" | "physicalDeletePossible" | "requiredPermission">,
  ): TraderReceivableResetPreview {
    const physicalDeletePossible = hasNoFinancialDependencies(row);
    return {
      ...row,
      action: physicalDeletePossible ? "physical_delete" : "financial_reset",
      physicalDeletePossible,
      requiredPermission: physicalDeletePossible ? "users_roles.manage" : "trader_receivables.reverse",
    };
  }

  private async resetRow(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    companyId: string,
    orderId: string,
    forUpdate: boolean,
  ): Promise<Omit<TraderReceivableResetPreview, "action" | "physicalDeletePossible" | "requiredPermission">> {
    const result = await sql<
      Omit<TraderReceivableResetPreview, "action" | "physicalDeletePossible" | "requiredPermission">
    >`
      select r.id as "receivableId", r.receivable_number as "receivableNumber",
             r.status as "receivableStatus", r.original_amount_due::text as amount,
             o.id as "orderId", o.order_number as "orderNumber",
             -- THE dependency rule (trader-receivable-dependencies.ts).
             ${receivableDependencyColumnsSql("r")}
        from trader_receivables r
        join orders o on o.company_id=r.company_id and o.order_number=r.source_reference
       where r.company_id=${companyId}::uuid and o.id=${orderId}::uuid
       order by r.created_at desc
       limit 1
       ${forUpdate ? sql`for update of r` : sql``}
    `.execute(database);
    const row = result.rows[0];
    if (!row) {
      throw new ApplicationException(
        "trader_receivable_not_found",
        "Trader receivable not found",
        HttpStatus.NOT_FOUND,
        undefined,
        await this.notFoundDiagnostics(database, companyId, orderId),
        true,
      );
    }
    return row;
  }

  private async notFoundDiagnostics(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    companyId: string,
    orderId: string,
  ): Promise<Readonly<Record<string, boolean | number | string | null>>> {
    const orderResult = await sql<{ id: string; orderNumber: string; companyId: string }>`
      select id, order_number as "orderNumber", company_id as "companyId"
        from orders where id=${orderId}::uuid
    `.execute(database);
    const order = orderResult.rows[0];
    if (!order) return {
      orderUuid: orderId, requestCompanyId: companyId, orderFound: false,
      orderId: null, orderNumber: null, orderCompanyId: null,
      receivableMatchCount: 0, referenceMatchCount: 0, companyReferenceMatchCount: 0,
    };
    const counts = await sql<{ referenceMatchCount: number; companyReferenceMatchCount: number }>`
      select
        (select count(*)::int from trader_receivables where source_reference=${order.orderNumber}) as "referenceMatchCount",
        (select count(*)::int from trader_receivables
          where company_id=${companyId}::uuid and source_reference=${order.orderNumber}) as "companyReferenceMatchCount"
    `.execute(database);
    const row = counts.rows[0]!;
    return {
      orderUuid: orderId, requestCompanyId: companyId, orderFound: true,
      orderId: order.id, orderNumber: order.orderNumber, orderCompanyId: order.companyId,
      receivableMatchCount: row.companyReferenceMatchCount,
      referenceMatchCount: row.referenceMatchCount,
      companyReferenceMatchCount: row.companyReferenceMatchCount,
    };
  }

  /**
   * Exactly this permission. Unlike `assertAnyPermission`, `users_roles.manage`
   * is NOT an implicit override here: a financial reversal needs the financial
   * permission.
   */
  private assertExactPermission(permission: string): void {
    if (!this.identities.current().permissions.has(permission)) {
      throw new ApplicationException(
        "permission_denied",
        "The authenticated account does not have permission for this operation",
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /**
   * Diagnose one Order by Order Number, Serial Number or Reference Number.
   * Read-only against operational data; records the findings so the same
   * problem is still on a worklist tomorrow.
   */
  public async diagnose(reference: string): Promise<OrderMaintenanceReport> {
    this.assertAnyPermission(["orders.update", "users_roles.manage"]);
    const { companyId } = this.tenants.current();
    const trimmed = reference.trim();
    if (trimmed === "") {
      throw new ApplicationException(
        "order_reference_required",
        "An Order Number, Serial Number or Reference Number is required",
        HttpStatus.BAD_REQUEST,
      );
    }
    const order = await this.findOrder(companyId, trimmed);
    const [history, events, receivables, settlements, vatPolicy] = await Promise.all([
      this.history(companyId, order.id),
      this.events(companyId, order.id),
      this.receivables(companyId, order.orderNumber),
      this.settlements(companyId, order.id),
      this.vatPolicy(companyId),
    ]);
    // A shortfall charge already made stays owed if the Company later turns
    // the switch off (rollback): the rule then still holds for this Order.
    const shortfallSwitch =
      (await traderPaysCodShortfall(this.database, companyId)) ||
      receivables.some((row) => row.status !== "cancelled" && row.status !== "reversed");
    const expected = this.expectedReceivableDue(order, vatPolicy, shortfallSwitch);
    const expectedAlternate = this.expectedReceivableDueAlternate(order, vatPolicy, shortfallSwitch);
    const findings = this.evaluate(
      order,
      history,
      receivables,
      settlements,
      expected,
      expectedAlternate,
    );
    await this.recordFindings(companyId, order, findings);
    return {
      diagnostic: this.diagnostic(order, history, events, receivables, settlements, expected, findings),
      events,
      expectedTraderReceivableDue: expected.toFixed(2),
      findings,
      history,
      order,
      receivables,
      settlements,
    };
  }

  // ---------------------------------------------------------------- gathering

  private async findOrder(companyId: string, reference: string): Promise<OrderSnapshotRow> {
    const result = await sql<OrderSnapshotRow>`
      select o.id, o.order_number as "orderNumber", o.serial_number as "serialNumber",
             o.reference_number as "referenceNumber", o.order_date::text as "orderDate",
             o.trader_id as "traderId", t.name_en as "traderName",
             o.delivery_status as "deliveryStatus",
             o.trader_settlement_status as "traderSettlementStatus",
             o.driver_reconciliation_status as "driverReconciliationStatus",
             o.return_status as "returnStatus", o.payment_condition as "paymentCondition",
             o.cod_amount::text as "codAmount", o.service_fee::text as "serviceFee",
             o.additional_fees::text as "additionalFees",
             o.customer_amount_due::text as "customerAmountDue",
             o.trader_net_payable::text as "traderNetPayable",
             o.amount_collected::text as "amountCollected",
             o.is_free_order as "isFreeOrder",
             o.delivered_at::text as "deliveredAt",
             o.operational_completed_at::text as "operationalCompletedAt",
             o.created_at::text as "createdAt", o.updated_at::text as "updatedAt"
        from orders o
        left join traders t on t.id = o.trader_id and t.company_id = o.company_id
       where o.company_id = ${companyId}::uuid
         and (o.order_number = ${reference}
              or o.serial_number = ${reference}
              or o.reference_number = ${reference})
       order by o.created_at desc
       limit 1
    `.execute(this.database);
    const order = result.rows[0];
    if (order === undefined) {
      throw new ApplicationException("order_not_found", "Order not found", HttpStatus.NOT_FOUND);
    }
    return order;
  }

  private async history(companyId: string, orderId: string): Promise<readonly HistoryRow[]> {
    return (
      await sql<HistoryRow>`
        select h.status_dimension as "statusDimension", h.from_status as "fromStatus",
               h.to_status as "toStatus", h.reason, h.occurred_at::text as "occurredAt",
               a.username as "changedBy"
          from order_status_history h
          left join accounts a on a.id = h.changed_by_account_id and a.company_id = h.company_id
         where h.company_id = ${companyId}::uuid and h.order_id = ${orderId}::uuid
         order by h.occurred_at
      `.execute(this.database)
    ).rows;
  }

  private async events(companyId: string, orderId: string): Promise<readonly EventRow[]> {
    return (
      await sql<EventRow>`
        select e.event_type as "eventType", e.field_name as "fieldName",
               e.previous_value #>> '{}' as "previousValue",
               e.new_value #>> '{}' as "newValue",
               e.reason, e.source, e.occurred_at::text as "occurredAt",
               a.username as actor
          from order_events e
          left join accounts a on a.id = e.actor_account_id and a.company_id = e.company_id
         where e.company_id = ${companyId}::uuid and e.order_id = ${orderId}::uuid
         order by e.occurred_at
      `.execute(this.database)
    ).rows;
  }

  /**
   * Receivables raised against this Order, each with the documents that
   * cleared it. A Receivable cleared by settlement netting has no Collection
   * at all, so both routes have to be looked up or a fully-paid fee looks
   * like it was never paid.
   */
  private async receivables(
    companyId: string,
    orderNumber: string,
  ): Promise<readonly ReceivableRow[]> {
    return (
      await sql<ReceivableRow>`
        select r.id, r.receivable_number as "receivableNumber", r.status,
               r.original_amount_due::text as "originalAmountDue",
               r.amount_collected::text as "amountCollected",
               r.outstanding_amount::text as "outstandingAmount",
               r.created_at::text as "createdAt",
               (select string_agg(distinct c.collection_number, ', ')
                  from trader_collection_allocations alloc
                  join trader_collections c
                    on c.id = alloc.collection_id and c.company_id = alloc.company_id
                 where alloc.receivable_id = r.id
                   and alloc.company_id = r.company_id) as "clearedByCollections",
               (select string_agg(distinct s.settlement_number, ', ')
                  from trader_settlement_receivable_offsets o
                  join trader_settlements s
                    on s.id = o.settlement_id and s.company_id = o.company_id
                 where o.receivable_id = r.id
                   and o.company_id = r.company_id
                   -- Effective offsets only: a reversed Settlement no longer
                   -- clears the Receivable (effective-settlement-offsets.ts).
                   and ${effectiveSettlement("s")}) as "clearedBySettlements",
               least(
                 (select min(s.confirmed_at)
                    from trader_settlement_receivable_offsets o
                    join trader_settlements s
                      on s.id = o.settlement_id and s.company_id = o.company_id
                   where o.receivable_id = r.id and o.company_id = r.company_id
                     and ${effectiveSettlement("s")}),
                 (select min(c.created_at)
                    from trader_collection_allocations alloc
                    join trader_collections c
                      on c.id = alloc.collection_id and c.company_id = alloc.company_id
                   where alloc.receivable_id = r.id and alloc.company_id = r.company_id)
               )::text as "earliestClearedAt"
          from trader_receivables r
         where r.company_id = ${companyId}::uuid
           and r.source_type = 'service_charge'
           and r.source_reference = ${orderNumber}
         order by r.created_at
      `.execute(this.database)
    ).rows;
  }

  private async settlements(companyId: string, orderId: string): Promise<readonly SettlementRow[]> {
    return (
      await sql<SettlementRow>`
        select s.settlement_number as "settlementNumber", s.status,
               s.business_date::text as "businessDate",
               s.confirmed_at::text as "confirmedAt",
               so.net_payable::text as "netPayable",
               so.allocated_amount::text as "allocatedAmount"
          from trader_settlement_orders so
          join trader_settlements s on s.id = so.settlement_id and s.company_id = so.company_id
         where so.company_id = ${companyId}::uuid and so.order_id = ${orderId}::uuid
         order by s.business_date, s.settlement_number
      `.execute(this.database)
    ).rows;
  }

  private async vatPolicy(companyId: string): Promise<VatPolicy> {
    const row = (
      await sql<{ vatEnabled: boolean; vatPriceMode: "exclusive" | "inclusive" | null; vatRate: string | null }>`
        select vat_enabled as "vatEnabled", vat_price_mode as "vatPriceMode",
               vat_rate::text as "vatRate"
          from company_settings where company_id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    if (row === undefined || !row.vatEnabled) {
      return { enabled: false, priceMode: null, rate: new Decimal(0) };
    }
    return { enabled: true, priceMode: row.vatPriceMode, rate: new Decimal(row.vatRate ?? 0) };
  }

  // ----------------------------------------------------------------- checking

  /**
   * What this Order says the Trader owes, from the SAME model Order creation
   * and editing use. Both calculation modes are evaluated and the one closest
   * to what is actually stored is taken as the expectation: `prospective`
   * changes intermediate terms, and a maintenance screen raising a false
   * "wrong amount" because it guessed the mode would be worse than useless.
   * A finding is only ever raised when BOTH modes disagree with the stored
   * Receivable.
   */
  private expectedReceivableDue(
    order: OrderSnapshotRow,
    vatPolicy: VatPolicy,
    traderPaysCodShortfall: boolean,
  ): Decimal {
    const input = {
      additionalFees: new Decimal(order.additionalFees ?? 0),
      codAmount: new Decimal(order.codAmount),
      driverCost: new Decimal(0),
      paymentCondition: order.paymentCondition as
        | "customer_pays_cod_and_fee"
        | "customer_pays_cod_trader_pays_fee",
      serviceFee: new Decimal(order.serviceFee),
      traderPaysCodShortfall,
      vatPolicy,
    };
    return calculateOrderFinancials({ ...input, prospective: true }).traderReceivableDue;
  }

  private expectedReceivableDueAlternate(
    order: OrderSnapshotRow,
    vatPolicy: VatPolicy,
    traderPaysCodShortfall: boolean,
  ): Decimal {
    return calculateOrderFinancials({
      additionalFees: new Decimal(order.additionalFees ?? 0),
      codAmount: new Decimal(order.codAmount),
      driverCost: new Decimal(0),
      paymentCondition: order.paymentCondition as
        | "customer_pays_cod_and_fee"
        | "customer_pays_cod_trader_pays_fee",
      prospective: false,
      serviceFee: new Decimal(order.serviceFee),
      traderPaysCodShortfall,
      vatPolicy,
    }).traderReceivableDue;
  }

  private evaluate(
    order: OrderSnapshotRow,
    history: readonly HistoryRow[],
    receivables: readonly ReceivableRow[],
    settlements: readonly SettlementRow[],
    expected: Decimal,
    expectedAlternate: Decimal,
  ): readonly OrderMaintenanceFinding[] {
    const findings: OrderMaintenanceFinding[] = [];
    const active = receivables.filter((r) => !["cancelled", "reversed"].includes(r.status));
    const money = (value: Decimal | string) => new Decimal(value).toFixed(2);

    // --- the log ---------------------------------------------------------
    const deliveryHistory = history.filter((h) => h.statusDimension === "delivery");
    if (deliveryHistory.length === 0) {
      findings.push({
        checkCode: "STATUS_NO_HISTORY",
        detail: `The Order is '${order.deliveryStatus}' but has no delivery history at all, so no one can be identified as having set it.`,
        evidence: { deliveryStatus: order.deliveryStatus },
        fixable: false,
        severity: "error",
        title: "Delivery status has no history",
      });
    } else {
      const last = deliveryHistory[deliveryHistory.length - 1]!;
      if (last.toStatus !== order.deliveryStatus) {
        findings.push({
          checkCode: "STATUS_LOG_DISAGREES",
          detail: `The Order is '${order.deliveryStatus}' but the last logged transition ended at '${last.toStatus}'. Something changed the status without recording it.`,
          evidence: {
            currentStatus: order.deliveryStatus,
            lastLoggedAt: last.occurredAt,
            lastLoggedStatus: last.toStatus,
          },
          fixable: false,
          severity: "error",
          title: "Status disagrees with the log",
        });
      }
    }

    // --- the receivable --------------------------------------------------
    const owed = Decimal.max(expected, expectedAlternate);
    if (owed.greaterThan(0) && active.length === 0) {
      findings.push({
        checkCode: receivables.length === 0 ? "RCV_MISSING" : "RCV_CANCELLED_BUT_DUE",
        detail:
          receivables.length === 0
            ? `This Order says the Trader owes AED ${money(owed)}, but no Receivable exists for it.`
            : `This Order says the Trader owes AED ${money(owed)}, but every Receivable raised for it has been cancelled or reversed. Creating a new one would re-bill a fee somebody deliberately cancelled — that is a decision for a person, never an automatic repair.`,
        evidence: {
          cancelledReceivables: receivables.map((r) => r.receivableNumber).join(", ") || null,
          expectedAmount: money(owed),
        },
        fixable: false,
        severity: "error",
        title: receivables.length === 0 ? "Trader Receivable missing" : "Receivable cancelled while the fee is still owed",
      });
    }
    if (active.length > 1) {
      findings.push({
        checkCode: "RCV_DUPLICATE",
        detail: `${active.length} active Receivables exist for one Order. The Trader is being asked for the fee more than once.`,
        evidence: { receivables: active.map((r) => r.receivableNumber).join(", ") },
        fixable: false,
        severity: "error",
        title: "Duplicate Trader Receivables",
      });
    }
    for (const receivable of active) {
      // Only when BOTH calculation modes disagree with what is stored. The
      // two modes differ in intermediate terms, and a maintenance screen that
      // cried "wrong amount" because it guessed the mode would be worse than
      // having no check at all.
      const stored = new Decimal(receivable.originalAmountDue);
      if (!stored.equals(expected) && !stored.equals(expectedAlternate)) {
        findings.push({
          checkCode: "RCV_WRONG_AMOUNT",
          detail: `${receivable.receivableNumber} is for AED ${money(receivable.originalAmountDue)} but this Order's figures say AED ${money(expected)} is owed.`,
          evidence: {
            expectedAmount: money(expected),
            expectedAmountAlternate: money(expectedAlternate),
            receivable: receivable.receivableNumber,
            storedAmount: money(receivable.originalAmountDue),
          },
          fixable: false,
          severity: "error",
          title: "Receivable amount disagrees with the Order",
        });
      }
      const cleared = ["collected", "partially_collected"].includes(receivable.status);
      const hasSource =
        receivable.clearedByCollections !== null || receivable.clearedBySettlements !== null;
      if (cleared && new Decimal(receivable.amountCollected).greaterThan(0) && !hasSource) {
        findings.push({
          checkCode: "RCV_CLEARED_NO_SOURCE",
          detail: `${receivable.receivableNumber} shows AED ${money(receivable.amountCollected)} collected, but no Collection and no Settlement offset accounts for it. The money has no document behind it.`,
          evidence: {
            amountCollected: money(receivable.amountCollected),
            receivable: receivable.receivableNumber,
            status: receivable.status,
          },
          fixable: false,
          severity: "error",
          title: "Receivable cleared with nothing behind it",
        });
      }
      // The fee was recovered before the goods arrived. Not automatically
      // wrong -- but if that delivery had failed the Trader would already
      // have paid, and only a full Settlement reversal undoes it.
      if (
        receivable.earliestClearedAt !== null &&
        order.deliveredAt !== null &&
        receivable.earliestClearedAt < order.deliveredAt
      ) {
        findings.push({
          checkCode: "SETTLE_BEFORE_DELIVERY",
          detail: `${receivable.receivableNumber} was cleared on ${receivable.earliestClearedAt.slice(0, 16).replace("T", " ")}, before the Order was delivered on ${order.deliveredAt.slice(0, 16).replace("T", " ")}. The Trader paid the fee before the goods arrived.`,
          evidence: {
            clearedAt: receivable.earliestClearedAt,
            deliveredAt: order.deliveredAt,
            receivable: receivable.receivableNumber,
          },
          fixable: false,
          severity: "warning",
          title: "Fee recovered before delivery completed",
        });
      }
    }
    for (const receivable of receivables) {
      if (
        ["cancelled", "reversed"].includes(receivable.status) &&
        new Decimal(receivable.outstandingAmount).greaterThan(0)
      ) {
        findings.push({
          checkCode: "RCV_STATUS_AMOUNT_MISMATCH",
          detail: `${receivable.receivableNumber} is '${receivable.status}' but still reports AED ${money(receivable.outstandingAmount)} outstanding. The column is generated from (amount due - collected), so this cannot be corrected by writing to it; any report that sums it must filter by status instead.`,
          evidence: {
            outstanding: money(receivable.outstandingAmount),
            receivable: receivable.receivableNumber,
            status: receivable.status,
          },
          fixable: false,
          severity: "info",
          title: "Cancelled Receivable still reports an outstanding amount",
        });
      }
    }

    // --- the order's own lifecycle ---------------------------------------
    const moneyResolved =
      active.every((r) => !new Decimal(r.outstandingAmount).greaterThan(0)) &&
      ["not_applicable", "reconciled"].includes(order.driverReconciliationStatus) &&
      !new Decimal(order.traderNetPayable ?? 0).greaterThan(0);
    if (order.deliveryStatus === "delivered" && moneyResolved) {
      findings.push({
        checkCode: "ORD_READY_TO_CLOSE",
        detail:
          "Delivered, with every money leg resolved, but still open. 'closed' is the terminal state; until someone closes it this Order stays on the active list.",
        evidence: { deliveredAt: order.deliveredAt, deliveryStatus: order.deliveryStatus },
        fixable: false,
        severity: "info",
        title: "Ready to close",
      });
    }
    if (settlements.length === 0 && new Decimal(order.traderNetPayable ?? 0).greaterThan(0)) {
      findings.push({
        checkCode: "SETTLE_MISSING",
        detail: `AED ${money(order.traderNetPayable ?? "0")} is payable to the Trader and no Settlement covers this Order.`,
        evidence: { traderNetPayable: money(order.traderNetPayable ?? "0") },
        fixable: false,
        severity: "warning",
        title: "Trader payable not settled",
      });
    }

    /* One row per check code. Two Receivables on one Order can trip the same
       check, and the findings table holds one row per (Order, check) -- so
       emitting the finding twice would quietly double `detection_count` on
       every run and report the same problem twice to the operator. Merge
       instead, keeping every affected record named in the detail. */
    const merged = new Map<string, OrderMaintenanceFinding>();
    for (const finding of findings) {
      const existing = merged.get(finding.checkCode);
      if (existing === undefined) {
        merged.set(finding.checkCode, finding);
        continue;
      }
      merged.set(finding.checkCode, {
        ...existing,
        detail: `${existing.detail} ${finding.detail}`,
        evidence: { ...existing.evidence, ...finding.evidence },
      });
    }
    return [...merged.values()];
  }

  // ------------------------------------------------------------------ logging

  /**
   * Upsert each finding, and mark anything previously open for this Order
   * that no longer reproduces as `cleared`. `cleared` deliberately carries no
   * actor: a problem that stopped reproducing is not a problem somebody
   * fixed, and the table's own constraints keep those two apart.
   */
  private async recordFindings(
    companyId: string,
    order: OrderSnapshotRow,
    findings: readonly OrderMaintenanceFinding[],
  ): Promise<void> {
    for (const finding of findings) {
      await sql`
        insert into order_maintenance_findings (
          company_id, order_id, order_number, check_code, severity, evidence, fixable
        ) values (
          ${companyId}::uuid, ${order.id}::uuid, ${order.orderNumber}, ${finding.checkCode},
          ${finding.severity}, ${JSON.stringify(finding.evidence)}::jsonb, ${finding.fixable}
        )
        on conflict (company_id, order_id, check_code) do update
           set severity = excluded.severity,
               evidence = excluded.evidence,
               fixable = excluded.fixable,
               last_seen_at = now(),
               detection_count = order_maintenance_findings.detection_count + 1,
               -- A finding that had been cleared and has come back is open
               -- again. One that a person resolved stays resolved: reopening
               -- it would erase who dealt with it.
               status = case when order_maintenance_findings.status = 'cleared'
                             then 'open' else order_maintenance_findings.status end
      `.execute(this.database);
    }
    const codes = findings.map((finding) => finding.checkCode);
    await sql`
      update order_maintenance_findings
         set status = 'cleared', last_seen_at = now()
       where company_id = ${companyId}::uuid
         and order_id = ${order.id}::uuid
         and status = 'open'
         and (${codes.length} = 0 or check_code <> all(${codes}::text[]))
    `.execute(this.database);
  }

  // --------------------------------------------------------------- diagnostic

  /**
   * The whole snapshot as plain text. The point is that an Order this service
   * cannot diagnose can still be handed to someone who can, complete and in
   * one paste, instead of being reconstructed question by question.
   */
  private diagnostic(
    order: OrderSnapshotRow,
    history: readonly HistoryRow[],
    events: readonly EventRow[],
    receivables: readonly ReceivableRow[],
    settlements: readonly SettlementRow[],
    expected: Decimal,
    findings: readonly OrderMaintenanceFinding[],
  ): string {
    const when = (value: string | null) =>
      value === null ? "-" : value.slice(0, 16).replace("T", " ");
    const lines: string[] = [];
    lines.push(`ORDER ${order.orderNumber}  (serial ${order.serialNumber ?? "-"}, ref ${order.referenceNumber ?? "-"})`);
    lines.push(`Trader: ${order.traderName ?? "-"}   Order date: ${order.orderDate ?? "-"}`);
    lines.push("");
    lines.push("STATUSES");
    lines.push(`  delivery=${order.deliveryStatus}  settlement=${order.traderSettlementStatus}`);
    lines.push(`  driverCash=${order.driverReconciliationStatus}  return=${order.returnStatus}`);
    lines.push(`  delivered_at=${when(order.deliveredAt)}  operational_completed_at=${when(order.operationalCompletedAt)}`);
    lines.push("");
    lines.push("MONEY");
    lines.push(`  paymentCondition=${order.paymentCondition}  freeOrder=${order.isFreeOrder === true}`);
    lines.push(`  cod=${order.codAmount}  serviceFee=${order.serviceFee}  additionalFees=${order.additionalFees ?? "0.00"}`);
    lines.push(`  customerAmountDue=${order.customerAmountDue ?? "-"}  amountCollected=${order.amountCollected ?? "-"}`);
    lines.push(`  traderNetPayable=${order.traderNetPayable ?? "-"}`);
    lines.push(`  expected Trader receivable due (shared model) = ${expected.toFixed(2)}`);
    lines.push("");
    lines.push(`STATUS HISTORY (${history.length})`);
    for (const row of history) {
      lines.push(`  ${when(row.occurredAt)}  ${row.statusDimension}: ${row.fromStatus ?? "-"} -> ${row.toStatus}  by ${row.changedBy ?? "system"}${row.reason === null ? "" : `  (${row.reason})`}`);
    }
    lines.push("");
    lines.push(`FIELD CHANGES (${events.length})`);
    for (const row of events) {
      const field = row.fieldName === null ? row.eventType : row.fieldName;
      lines.push(`  ${when(row.occurredAt)}  ${field}: ${row.previousValue ?? "-"} -> ${row.newValue ?? "-"}  by ${row.actor ?? "system"} via ${row.source ?? "-"}${row.reason === null ? "" : `  (${row.reason})`}`);
    }
    lines.push("");
    lines.push(`TRADER RECEIVABLES (${receivables.length})`);
    for (const row of receivables) {
      lines.push(`  ${row.receivableNumber}  ${row.status}  due=${row.originalAmountDue} collected=${row.amountCollected} outstanding=${row.outstandingAmount}`);
      lines.push(`      cleared by: settlement=${row.clearedBySettlements ?? "-"}  collection=${row.clearedByCollections ?? "-"}  at ${when(row.earliestClearedAt)}`);
    }
    lines.push("");
    lines.push(`TRADER SETTLEMENTS COVERING THIS ORDER (${settlements.length})`);
    for (const row of settlements) {
      lines.push(`  ${row.settlementNumber}  ${row.status}  date=${row.businessDate ?? "-"}  netPayable=${row.netPayable ?? "-"}  allocated=${row.allocatedAmount ?? "-"}  confirmed=${when(row.confirmedAt)}`);
    }
    lines.push("");
    lines.push(`FINDINGS (${findings.length})`);
    if (findings.length === 0) {
      lines.push("  None. Every check passed for this Order.");
    }
    for (const finding of findings) {
      lines.push(`  [${finding.severity.toUpperCase()}] ${finding.checkCode}: ${finding.title}`);
      lines.push(`      ${finding.detail}`);
    }
    return lines.join("\n");
  }

  private assertAnyPermission(permission: string | readonly string[]): void {
    const permissions = this.identities.current().permissions;
    const required = Array.isArray(permission) ? permission : [permission];
    if (
      !permissions.has("users_roles.manage") &&
      !required.some((candidate) => permissions.has(candidate))
    ) {
      throw new ApplicationException(
        "permission_denied",
        "The authenticated account does not have permission for this operation",
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
