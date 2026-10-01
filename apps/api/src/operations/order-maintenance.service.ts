import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql, type Transaction } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "./operations-history.writer.js";
import { ReceivableOffsetReversalService } from "./receivable-offset-reversal.service.js";
import { calculateOrderFinancials, type VatPolicy } from "./order-financial-model.js";

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

/**
 * Every financial fact that can hang off a Trader Receivable. A Receivable may
 * be PHYSICALLY deleted only when every one of these is zero -- otherwise it
 * has financial history, and Delete / Reset must take the financial reversal
 * path, which preserves that history.
 */
export interface TraderReceivableDependencies {
  /** `trader_collection_allocations` -- physical Trader Collections. */
  readonly collectionCount: number;
  /** `trader_settlement_receivable_offsets` -- Settlement netting. */
  readonly offsetCount: number;
  /** `accounting_events` whose source is this Receivable. */
  readonly accountingEventCount: number;
  /** Journals sourced from, or journal lines sub-ledgered to, this Receivable. */
  readonly journalCount: number;
  /** `trader_credits` that name this Receivable (any status). */
  readonly traderCreditCount: number;
  /** `amount_collected` > 0: money has been applied to it by any route. */
  readonly amountCollected: string;
}

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

/** Zero financial dependencies of any kind -- the ONLY case a DELETE is allowed. */
export function hasNoFinancialDependencies(row: TraderReceivableDependencies): boolean {
  return (
    row.collectionCount === 0 &&
    row.offsetCount === 0 &&
    row.accountingEventCount === 0 &&
    row.journalCount === 0 &&
    row.traderCreditCount === 0 &&
    new Decimal(row.amountCollected).isZero()
  );
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

    if (row.action === "financial_reset") {
      if (row.offsetCount === 0) {
        throw new ApplicationException(
          "trader_receivable_reset_unsupported",
          "This processed receivable has no supported reset path",
          HttpStatus.CONFLICT,
        );
      }
      // Receivable-scoped: the Order is derived server-side from the Receivable.
      await this.offsetReversals.execute(row.receivableId, trimmedReason, correlationId);
      return this.classify(await this.resetRow(this.database, companyId, orderId, false));
    }

    const identity = this.identities.current();
    return this.transactions.execute(async (tx) => {
      const locked = this.classify(await this.resetRow(tx, companyId, orderId, true));
      if (locked.receivableId !== row.receivableId || locked.action !== "physical_delete") {
        throw new ApplicationException(
          "trader_receivable_reset_race",
          "The receivable changed; preview it again",
          HttpStatus.CONFLICT,
        );
      }
      await sql`
        delete from trader_receivables
         where company_id = ${companyId}::uuid and id = ${locked.receivableId}::uuid
      `.execute(tx);
      await this.historyWriter.audit(tx, {
        action: "trader_receivable.physical_delete",
        actorId: identity.identityId,
        after: { reason: trimmedReason, receivableNumber: locked.receivableNumber },
        companyId,
        correlationId,
        subjectId: locked.receivableId,
        subjectType: "trader_receivable",
      });
      return locked;
    });
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
             r.amount_collected::text as "amountCollected",
             o.id as "orderId", o.order_number as "orderNumber",
             (select count(*)::int from trader_collection_allocations a
               where a.company_id=r.company_id and a.receivable_id=r.id) as "collectionCount",
             (select count(*)::int from trader_settlement_receivable_offsets x
               where x.company_id=r.company_id and x.receivable_id=r.id) as "offsetCount",
             (select count(*)::int from accounting_events e
               where e.company_id=r.company_id and e.source_entity_type='trader_receivable'
                 and e.source_entity_id=r.id) as "accountingEventCount",
             (select count(*)::int from journal_entries j
               where j.company_id=r.company_id
                 and ((j.source_entity_type='trader_receivable' and j.source_entity_id=r.id)
                   or exists(select 1 from journal_lines l
                              where l.company_id=j.company_id and l.journal_entry_id=j.id
                                and l.subledger_id=r.id))) as "journalCount",
             (select count(*)::int from trader_credits c
               where c.company_id=r.company_id and c.source_receivable_id=r.id) as "traderCreditCount"
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
      );
    }
    return row;
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
    const expected = this.expectedReceivableDue(order, vatPolicy);
    const expectedAlternate = this.expectedReceivableDueAlternate(order, vatPolicy);
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
                   and o.company_id = r.company_id) as "clearedBySettlements",
               least(
                 (select min(s.confirmed_at)
                    from trader_settlement_receivable_offsets o
                    join trader_settlements s
                      on s.id = o.settlement_id and s.company_id = o.company_id
                   where o.receivable_id = r.id and o.company_id = r.company_id),
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
  private expectedReceivableDue(order: OrderSnapshotRow, vatPolicy: VatPolicy): Decimal {
    const input = {
      additionalFees: new Decimal(order.additionalFees ?? 0),
      codAmount: new Decimal(order.codAmount),
      driverCost: new Decimal(0),
      paymentCondition: order.paymentCondition as
        | "customer_pays_cod_and_fee"
        | "customer_pays_cod_trader_pays_fee",
      serviceFee: new Decimal(order.serviceFee),
      vatPolicy,
    };
    return calculateOrderFinancials({ ...input, prospective: true }).traderReceivableDue;
  }

  private expectedReceivableDueAlternate(
    order: OrderSnapshotRow,
    vatPolicy: VatPolicy,
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
