import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { PlatformAccountingRepairAdapter } from "../accounting/platform-accounting-repair.adapter.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import {
  CompanyOrderHealthService,
  ORDER_HEALTH_REASONS,
  type OrderHealthEvaluation,
  type OrderHealthReasonCode,
} from "./company-order-health.service.js";
import { OrderMaintenanceService } from "./order-maintenance.service.js";
import { ReceivableOffsetReversalService } from "./receivable-offset-reversal.service.js";
import {
  capabilityFor,
  type CapabilityCode,
  type PreservedRecord,
  type ProposedChange,
  type RepairPlan,
  type RequiredInput,
} from "./repair-capability.registry.js";
import { previewFinding } from "./repair-finding-preview.js";
import { manualReviewExplanation } from "./repair-manual-review.js";
import {
  FINDING_DEFINITIONS,
  findingIdOf,
  type RepairFinding,
  type RepairIssue,
  type Repairability,
  severityOf,
  stateFingerprint,
} from "./repair-center.model.js";
import {
  fingerprintState,
  loadOrderDependencyGraph,
  type OrderDependencyGraph,
} from "./repair-dependency-graph.js";

/**
 * REPAIR CENTER -- FINDING DETAILS + REPAIR PLAN PREVIEW (read-only).
 *
 * Everything is recomputed from the database on every call, inside ONE
 * PostgreSQL read-only transaction: the finding (the Company Health
 * evaluation narrowed to this Order), the Order's dependency graph, and each
 * applicable capability's plan from the domain's own read paths. Nothing the
 * browser sends is trusted except WHICH of the recomputed findings to preview.
 * Nothing is executed and nothing is persisted.
 */

export interface DependencyNode {
  readonly entityType: string;
  readonly entityId: string;
  readonly entityNumber: string | null;
  readonly status: string;
  readonly amount: string | null;
  readonly relation: string;
}

export interface OrderRepairAnalysis {
  readonly companyId: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly deliveryStatus: string;
  readonly health: OrderHealthEvaluation["health"];
  readonly accountingMode: { readonly enabled: boolean };
  readonly findings: readonly RepairFinding[];
  readonly dependencies: {
    readonly current: readonly DependencyNode[];
    readonly historical: readonly DependencyNode[];
  };
  readonly previewVersion: string;
  readonly generatedAt: string;
}

export interface RepairPreview {
  readonly companyId: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly finding: RepairFinding;
  readonly otherFindings: readonly RepairFinding[];
  readonly repairability: Repairability;
  readonly proposedRepair: {
    readonly capabilityCode: CapabilityCode;
    readonly title: string;
    readonly explanation: string;
    readonly executionHandler: string;
    /** True when shown for a person to judge (MANUAL_REVIEW), not to run. */
    readonly candidateOnly: boolean;
  } | null;
  readonly currentState: Readonly<Record<string, string | number | boolean | null>>;
  readonly proposedChanges: readonly ProposedChange[];
  readonly preservedHistory: readonly PreservedRecord[];
  readonly dependencies: OrderRepairAnalysis["dependencies"];
  readonly blockers: readonly RepairIssue[];
  readonly warnings: readonly RepairIssue[];
  readonly requiredInputs: readonly RequiredInput[];
  readonly requiredPermission: string | null;
  readonly idempotencyKeyBasis: string | null;
  readonly accountingMode: { readonly enabled: boolean };
  readonly previewVersion: string;
  /**
   * Whether the Repair Center may EXECUTE this repair (Prompt 3): true only
   * for a READY finding of an executable certified capability. Advisory for
   * the UI; execution re-proves everything server-side.
   */
  readonly execution: {
    readonly available: boolean;
    readonly reason: string;
    readonly requiredPlatformPermission: string;
  };
  readonly generatedAt: string;
}

const STATEMENT_TIMEOUT = "30s";

/**
 * Mirrors PLATFORM_REPAIR_CENTER_EXECUTE (platform-authorization.ts); kept
 * here as a literal so operations/ does not import the platform module.
 */
export const PLATFORM_REPAIR_CENTER_EXECUTE_PERMISSION = "platform.companies.repair_center.execute";

@Injectable()
export class RepairPreviewService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(CompanyOrderHealthService) private readonly health: CompanyOrderHealthService,
    @Inject(OrderMaintenanceService) private readonly maintenance: OrderMaintenanceService,
    @Inject(ReceivableOffsetReversalService)
    private readonly reversals: ReceivableOffsetReversalService,
    @Inject(PlatformAccountingRepairAdapter)
    private readonly accounting: PlatformAccountingRepairAdapter,
  ) {}

  /** Finding Details: every finding of the Order, its graph and fingerprint. */
  public async analyze(companyId: string, orderId: string): Promise<OrderRepairAnalysis> {
    return this.readOnly(async (db) => (await this.compute(db, companyId, orderId)).analysis);
  }

  /** Repair Plan Preview for one recomputed finding (default: the primary). */
  public async preview(
    companyId: string,
    orderId: string,
    input: { readonly reasonCode?: string | undefined } = {},
  ): Promise<RepairPreview> {
    return this.readOnly(async (db) => {
      const { analysis, evaluation, graph, plans } = await this.compute(db, companyId, orderId);
      const finding =
        input.reasonCode === undefined
          ? analysis.findings[0]!
          : analysis.findings.find((item) => item.reasonCode === input.reasonCode);
      if (finding === undefined) {
        // The caller named a finding the database does not show (any more).
        throw new ApplicationException(
          "repair_finding_not_current",
          "That finding is not current for this order; refresh the Order details",
          HttpStatus.CONFLICT,
        );
      }
      const capability = capabilityFor(finding.reasonCode);
      const plan = finding.repairability === "NOT_REQUIRED" ? undefined : plans.get(finding.reasonCode);
      return {
        accountingMode: analysis.accountingMode,
        blockers: plan?.blockers ?? finding.blockers,
        companyId,
        currentState: {
          activeReceivables: evaluation.activeReceivableCount,
          codAmount: graph.order.codAmount,
          deliveryStatus: graph.order.deliveryStatus,
          driverCashStatus: graph.order.driverReconciliationStatus,
          effectiveOffsetAmount: evaluation.activeOffset,
          health: evaluation.health,
          historicalReceivables: graph.receivables.filter((row) => !row.current).length,
          paymentCondition: graph.order.paymentCondition,
          physicalCollectionAmount: evaluation.activePhysical,
          serviceFee: graph.order.serviceFee,
          traderOwes: evaluation.traderDue,
          traderSettlementStatus: graph.order.traderSettlementStatus,
        },
        dependencies: analysis.dependencies,
        execution: this.executionOf(finding.repairability, capability),
        finding,
        generatedAt: analysis.generatedAt,
        idempotencyKeyBasis:
          plan === undefined || capability === undefined
            ? null
            : `repair:${capability.capabilityCode}:${companyId}:${orderId}:${analysis.previewVersion}`,
        orderId,
        orderNumber: analysis.orderNumber,
        otherFindings: analysis.findings.filter((item) => item.findingId !== finding.findingId),
        preservedHistory: plan?.preservedHistory ?? [],
        previewVersion: analysis.previewVersion,
        proposedChanges: plan?.proposedChanges ?? [],
        proposedRepair:
          plan === undefined || capability === undefined
            ? null
            : {
                candidateOnly: finding.repairability === "MANUAL_REVIEW",
                capabilityCode: capability.capabilityCode,
                executionHandler: capability.executionHandler,
                explanation: plan.explanation,
                title: plan.title,
              },
        repairability: finding.repairability,
        requiredInputs: plan?.requiredInputs ?? [],
        requiredPermission: plan?.requiredPermission ?? null,
        warnings: plan?.warnings ?? finding.warnings,
      };
    });
  }

  /**
   * The full recomputation (finding, graph, plans, fingerprint) on the
   * caller's connection or transaction. Used by repair EXECUTION to re-prove
   * the preview inside its own locked transaction; it writes nothing.
   */
  public computeIn(db: Kysely<DatabaseSchema>, companyId: string, orderId: string) {
    return this.compute(db, companyId, orderId);
  }

  // --------------------------------------------------------------- internals

  private executionOf(
    repairability: Repairability,
    capability: ReturnType<typeof capabilityFor>,
  ): RepairPreview["execution"] {
    const requiredPlatformPermission = PLATFORM_REPAIR_CENTER_EXECUTE_PERMISSION;
    if (capability === undefined) {
      return { available: false, reason: "No certified repair exists for this finding.", requiredPlatformPermission };
    }
    if (!capability.execution.available) {
      return { available: false, reason: capability.execution.reason, requiredPlatformPermission };
    }
    return repairability === "READY"
      ? {
          available: true,
          reason: "READY: the certified repair can be executed; the server re-checks everything first.",
          requiredPlatformPermission,
        }
      : {
          available: false,
          reason: `Only a READY finding can be executed (this one is ${repairability}).`,
          requiredPlatformPermission,
        };
  }

  private async readOnly<T>(work: (db: Kysely<DatabaseSchema>) => Promise<T>): Promise<T> {
    return this.database.transaction().execute(async (transaction) => {
      await sql`set transaction read only`.execute(transaction);
      await sql`select set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true),
                       set_config('jit', 'off', true)`.execute(transaction);
      return work(transaction);
    });
  }

  private async compute(db: Kysely<DatabaseSchema>, companyId: string, orderId: string) {
    const context = await this.health.companyContext(db, companyId);
    const evaluation = await this.health.orderEvaluation(db, companyId, orderId);
    const graph = evaluation === undefined ? undefined : await loadOrderDependencyGraph(db, companyId, orderId);
    if (evaluation === undefined || graph === undefined) {
      // Never by Order number, never across Companies: (Company, Order id) only.
      throw new ApplicationException("order_not_found", "Order not found", HttpStatus.NOT_FOUND);
    }
    const detectedAt = new Date().toISOString();
    const codes: readonly OrderHealthReasonCode[] =
      evaluation.findingCodes.length > 0 ? evaluation.findingCodes : [evaluation.financialCode];
    const plans = new Map<OrderHealthReasonCode, RepairPlan>();
    const findings: RepairFinding[] = [];
    for (const reasonCode of codes) {
      const reason = ORDER_HEALTH_REASONS[reasonCode];
      const definition = FINDING_DEFINITIONS[reasonCode];
      // THE repairability rule, shared with Verify First (repair-finding-preview.ts).
      const { capability, plan, repairability } = await previewFinding(
        {
          companyId,
          db,
          evaluation,
          graph,
          accounting: this.accounting,
          maintenance: this.maintenance,
          reversals: this.reversals,
        },
        reasonCode,
      );
      if (plan !== undefined) plans.set(reasonCode, plan);
      const entity = this.entityOf(reasonCode, graph);
      findings.push({
        blockers: plan?.blockers ?? [],
        companyId,
        detectedAt,
        detectedState: this.detectedState(reasonCode, evaluation, graph),
        domain: definition.domain,
        entityId: entity.id,
        entityNumber: entity.number,
        entityType: entity.type,
        evidence: {
          activeReceivables: evaluation.activeReceivableCount,
          effectiveOffsetAmount: evaluation.activeOffset,
          historicalOffsets: graph.offsets.filter((row) => !row.current).length,
          historicalReceivables: graph.receivables.filter((row) => !row.current).length,
          physicalCollectionAmount: evaluation.activePhysical,
          receivables: evaluation.receivableCount,
          traderOwes: evaluation.traderDue,
        },
        expectedState: definition.expectedState,
        findingId: findingIdOf(companyId, orderId, reasonCode),
        health: reason.health,
        manualReview:
          repairability === "MANUAL_REVIEW" && definition.domain !== "DRIVER_CASH" && definition.domain !== "ACCOUNTING"
            ? manualReviewExplanation(reasonCode, evaluation, graph, capability, plan)
            : null,
        orderId,
        reasonCode,
        recommendedAction: reason.recommendedAction,
        repairCapability: capability?.capabilityCode ?? null,
        repairability,
        severity: severityOf(reason.health),
        summary: reason.reason,
        title: definition.title,
        warnings:
          repairability === "MANUAL_REVIEW" && capability === undefined && reason.health !== "HEALTHY"
            ? [
                {
                  code: "NO_CERTIFIED_REPAIR",
                  message: "No certified repair operation exists for this finding; it needs manual review.",
                },
              ]
            : (plan?.warnings ?? []),
      });
    }
    const analysis: OrderRepairAnalysis = {
      accountingMode: context.accountingMode,
      companyId,
      deliveryStatus: graph.order.deliveryStatus,
      dependencies: this.dependencies(graph),
      findings,
      generatedAt: detectedAt,
      health: evaluation.health,
      orderId,
      orderNumber: graph.order.orderNumber,
      previewVersion: stateFingerprint(fingerprintState(graph)),
    };
    return { analysis, evaluation, graph, plans };
  }

  private entityOf(
    reasonCode: OrderHealthReasonCode,
    graph: OrderDependencyGraph,
  ): { type: "order" | "trader_receivable"; id: string; number: string } {
    const current = graph.receivables.filter((row) => row.current);
    const receivableScoped: readonly OrderHealthReasonCode[] = [
      "MULTIPLE_EFFECTIVE_SETTLEMENTS",
      "RECEIVABLE_OVER_COLLECTED",
      "RECEIVABLE_COLLECTED_AMOUNT_MISMATCH",
      "RECEIVABLE_NOT_REQUIRED_BUT_ACTIVE",
      "RECEIVABLE_AMOUNT_MISMATCH",
      "RECEIVABLE_AMOUNT_NOT_PROVABLE",
      "COLLECTION_ALLOCATION_MISMATCH",
      "SETTLEMENT_OFFSET_MISMATCH",
      "RECEIVABLE_MARKED_COLLECTED_WITHOUT_EFFECTIVE_SETTLEMENT",
      "FINANCIALLY_SETTLED_BUT_RECEIVABLE_STATE_OPEN",
      "RECEIVABLE_PARTIAL_STATE_MISMATCH",
      "HEALTHY_ACTIVE_RECEIVABLE",
      "ALREADY_PHYSICALLY_COLLECTED",
      "SETTLED_BY_COLLECTION_AND_OFFSET",
      "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION",
    ];
    if (receivableScoped.includes(reasonCode) && current.length === 1) {
      return { id: current[0]!.id, number: current[0]!.receivableNumber, type: "trader_receivable" };
    }
    return { id: graph.order.id, number: graph.order.orderNumber, type: "order" };
  }

  private detectedState(
    reasonCode: OrderHealthReasonCode,
    evaluation: OrderHealthEvaluation,
    graph: OrderDependencyGraph,
  ): string {
    const owes = evaluation.amountProvable
      ? `Trader owes AED ${evaluation.traderDue}`
      : `Trader would owe AED ${evaluation.traderDue} under today's rules (not provable for this older order)`;
    const receivables = `${evaluation.activeReceivableCount} current receivable(s), ${graph.receivables.length - evaluation.activeReceivableCount} historical`;
    switch (reasonCode) {
      case "RECEIVABLE_AMOUNT_MISMATCH":
      case "RECEIVABLE_AMOUNT_NOT_PROVABLE": {
        const currentRows = graph.receivables.filter((row) => row.current);
        return `${owes}; ${receivables}; current receivable amount AED ${currentRows.map((row) => row.amountDue).join(", ")}.`;
      }
      case "COLLECTION_ALLOCATION_MISMATCH":
      case "ORPHAN_COLLECTION_ALLOCATION":
      case "SETTLEMENT_OFFSET_MISMATCH":
      case "RECEIVABLE_MARKED_COLLECTED_WITHOUT_EFFECTIVE_SETTLEMENT":
      case "FINANCIALLY_SETTLED_BUT_RECEIVABLE_STATE_OPEN":
      case "RECEIVABLE_PARTIAL_STATE_MISMATCH": {
        const states = graph.receivables.map(
          (row) => `${row.receivableNumber} ${row.status} (due AED ${row.amountDue}, recorded collected AED ${row.amountCollected})`,
        );
        return `${owes}; ${states.join("; ")}; effective physical collections AED ${evaluation.activePhysical}; effective offsets AED ${evaluation.activeOffset}.`;
      }
      case "MISSING_RECEIVABLE":
      case "REVERSED_NEEDS_REPAIR":
      case "HEALTHY_ACTIVE_RECEIVABLE":
      case "NO_TRADER_RECEIVABLE_REQUIRED":
      case "MULTIPLE_ACTIVE_RECEIVABLES":
      case "RECEIVABLE_NOT_REQUIRED_BUT_ACTIVE":
      case "RECEIVABLE_STATE_INCONSISTENT":
        return `${owes}; ${receivables}.`;
      case "ALREADY_PHYSICALLY_COLLECTED":
      case "SETTLED_BY_COLLECTION_AND_OFFSET":
      case "OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION":
      case "MULTIPLE_EFFECTIVE_SETTLEMENTS":
      case "RECEIVABLE_OVER_COLLECTED":
      case "RECEIVABLE_COLLECTED_AMOUNT_MISMATCH":
        return `${owes}; physical collections AED ${evaluation.activePhysical}; effective offsets AED ${evaluation.activeOffset}; ${graph.offsets.filter((row) => row.effective).length} effective offset row(s).`;
      case "ORDER_MISSING_ACCOUNTING_EVENT":
        return `Order is ${graph.order.deliveryStatus} with no order accounting event.`;
      case "ACCOUNTING_EVENT_FAILED": {
        const statuses = graph.events
          .filter((event) => event.sourceEntityType === "order")
          .map((event) => `${event.eventType} ${event.processingStatus}`);
        return `Order accounting event(s): ${statuses.join(", ") || "none"}.`;
      }
      case "DRIVER_CASH_RECONCILED_WITHOUT_RECONCILIATION":
      case "DRIVER_CASH_RECONCILIATION_NOT_REFLECTED":
        return `Driver cash status '${graph.order.driverReconciliationStatus}'; ${graph.reconciliations.filter((row) => row.current).length} effective reconciliation(s).`;
    }
  }

  private dependencies(graph: OrderDependencyGraph): OrderRepairAnalysis["dependencies"] {
    const current: DependencyNode[] = [];
    const historical: DependencyNode[] = [];
    const place = (isCurrent: boolean, node: DependencyNode) => (isCurrent ? current : historical).push(node);
    const receivableNumber = new Map(graph.receivables.map((row) => [row.id, row.receivableNumber]));
    const currentEntities = new Set<string>([graph.order.id]);
    for (const row of graph.receivables) {
      if (row.current) currentEntities.add(row.id);
      place(row.current, {
        amount: row.amountDue,
        entityId: row.id,
        entityNumber: row.receivableNumber,
        entityType: "trader_receivable",
        relation: row.createdByPlatformRepair
          ? "Order service-charge receivable (created by Platform Repair)"
          : "Order service-charge receivable",
        status: row.status,
      });
    }
    for (const row of graph.allocations) {
      place(row.current, {
        amount: row.amount,
        entityId: row.id,
        entityNumber: row.collectionNumber,
        entityType: "trader_collection_allocation",
        relation: `Physical collection of ${receivableNumber.get(row.receivableId) ?? "a receivable"}`,
        status: row.collectionStatus,
      });
    }
    for (const row of graph.offsets) {
      if (row.current) currentEntities.add(row.settlementId);
      place(row.current, {
        amount: row.amount,
        entityId: row.id,
        entityNumber: row.settlementNumber,
        entityType: "trader_settlement_offset",
        relation: `Settlement offset of ${receivableNumber.get(row.receivableId) ?? "a receivable"}${row.effective ? "" : row.reversedBySettlementNumber === null ? " (settlement not effective)" : ` (reversed by ${row.reversedBySettlementNumber})`}`,
        status: row.effective ? "effective" : "historical",
      });
    }
    for (const row of graph.credits) {
      if (row.current) currentEntities.add(row.id);
      place(row.current, {
        amount: row.amount,
        entityId: row.id,
        entityNumber: row.creditNumber,
        entityType: "trader_credit",
        relation: "Trader Credit linked to the receivable",
        status: row.status,
      });
    }
    for (const row of graph.events) {
      const isCurrent = currentEntities.has(row.sourceEntityId);
      place(isCurrent, {
        amount: null,
        entityId: row.id,
        entityNumber: null,
        entityType: "accounting_event",
        relation: `${row.eventType} for ${row.sourceEntityType}`,
        status: row.processingStatus,
      });
      if (row.journalId !== null) {
        place(isCurrent, {
          amount: null,
          entityId: row.journalId,
          entityNumber: row.journalNumber,
          entityType: "journal_entry",
          relation: `Journal of ${row.eventType}`,
          status: row.journalStatus ?? "unknown",
        });
      }
    }
    for (const row of graph.reconciliations) {
      place(row.current, {
        amount: null,
        entityId: row.reconciliationId,
        entityNumber: row.reconciliationNumber,
        entityType: "driver_reconciliation",
        relation: row.isReversal ? "Driver reconciliation reversal" : "Driver cash reconciliation",
        status: row.reversed ? "reversed" : row.status,
      });
    }
    return { current, historical };
  }
}
