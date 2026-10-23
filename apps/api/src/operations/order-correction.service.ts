import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql, type Transaction } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { DriverCashReconciliationService } from "./driver-cash-reconciliation.service.js";
import { OperationsHistoryWriter } from "./operations-history.writer.js";
import { OperationsService } from "./operations.service.js";
import {
  collectionLineActiveSql,
  settlementLineActiveSql,
  zeroDueLineActiveSql,
} from "./order-correction-sql.js";
import { TraderSettlementService } from "./trader-settlement.service.js";

/**
 * Order corrections (DCX), Aiman 23 Oct 2026.
 *
 * "Correct a wrongly delivered Order": an Order marked Delivered by mistake
 * (Lahthza ORD-000212, ref 4353, never delivered) can sit inside a confirmed
 * Driver collection and a posted Trader settlement together with many other
 * Orders. Both are immutable, and reversing either whole would undo every
 * other Order on it. A correction takes ONLY this Order out, in one
 * transaction, and records everything in `order_corrections` (DCX-000001):
 *
 *   1. Driver collection: the line is marked removed and its money taken back
 *      (it was never received): an Accounting Event (Dr COD Receivable /
 *      Cr Cash or Bank) and a Cash/Bank withdrawal Movement.
 *   2. Trader settlement: each line is marked removed. The Trader was already
 *      paid for it, so a Trader receivable ("overpayment recovery", RCV-...)
 *      is opened per line; the next settlement deducts it like any fee.
 *   3. A 0-due line ("Nothing to pay", printed at 0.00) is marked removed.
 *   4. The Order is reopened to Out for Delivery (the existing controlled
 *      reopen), so the user then cancels, returns or redelivers it with the
 *      normal screens. Cancelling it also reverses the Driver's delivery fee,
 *      as it always does.
 *
 * The original documents are never changed: they print "amended" by default
 * and can still be printed exactly as they were ("original").
 *
 * Settlements whose money has NOT reached the Trader yet are better un-posted
 * (Un-post) and posted again without the Order; the preview says so.
 */

export interface OrderCorrectionIssue {
  readonly code: string;
  readonly message: string;
}

export interface OrderCorrectionPreview {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly serialNumber: string;
  readonly referenceNumber: string | null;
  readonly deliveryStatus: string;
  readonly traderName: string;
  readonly driverName: string | null;
  readonly canCorrect: boolean;
  readonly blockers: readonly OrderCorrectionIssue[];
  readonly warnings: readonly OrderCorrectionIssue[];
  readonly collection: {
    readonly reconciliationId: string;
    readonly reconciliationNumber: string;
    readonly amount: string;
    readonly paymentMethod: "cash" | "visa" | "none";
    readonly otherOrderCount: number;
    readonly receivedAsConfirmed: string;
    readonly receivedAfterCorrection: string;
  } | null;
  readonly settlements: readonly {
    readonly settlementId: string;
    readonly settlementNumber: string;
    readonly amountPaid: string;
    readonly otherOrderCount: number;
  }[];
  readonly zeroDueDocuments: readonly string[];
  readonly recoveryTotal: string;
  readonly driverFee: {
    readonly amount: string;
    readonly paid: string;
    readonly status: string;
  } | null;
  readonly newDeliveryStatus: "out_for_delivery";
}

export interface OrderCorrectionResult {
  readonly correctionId: string;
  readonly correctionNumber: string;
  readonly collectionAmount: string;
  readonly movementNumber: string | null;
  readonly recoveryReceivableNumbers: readonly string[];
  readonly recoveredAmount: string;
}

export interface OrderCorrectionHistoryRow {
  readonly correctionId: string;
  readonly correctionNumber: string;
  readonly correctedAt: string;
  readonly correctedBy: string;
  readonly reason: string;
  readonly previousDeliveryStatus: string;
  readonly collectionAmount: string;
  readonly recoveredAmount: string;
  readonly lines: readonly {
    readonly kind: "driver_collection" | "trader_settlement" | "zero_due";
    readonly documentId: string | null;
    readonly documentNumber: string | null;
    readonly amount: string;
    readonly recoveryReceivableNumber: string | null;
  }[];
}

interface CollectionPlan {
  readonly amount: Decimal;
  readonly bankAccountId: string | null;
  readonly cashAccountId: string | null;
  readonly driverPayableDeduction: Decimal;
  readonly lineId: string;
  readonly method: "cash" | "visa" | "none";
  readonly otherOrderCount: number;
  readonly receivedAsConfirmed: Decimal;
  readonly reconciliationId: string;
  readonly reconciliationNumber: string;
}

interface SettlementPlanLine {
  readonly allocated: Decimal;
  readonly lineId: string;
  readonly otherOrderCount: number;
  readonly settlementId: string;
  readonly settlementNumber: string;
}

interface ZeroDuePlanLine {
  readonly documentNumber: string;
  readonly lineId: string;
  readonly settlementId: string | null;
  readonly zeroInvoiceId: string | null;
}

interface OrderRow {
  readonly assignedDriverId: string | null;
  readonly deliveryStatus: string;
  readonly driverName: string | null;
  readonly driverReconciliationStatus: string;
  readonly id: string;
  readonly orderNumber: string;
  readonly referenceNumber: string | null;
  readonly serialNumber: string;
  readonly traderId: string;
  readonly traderName: string;
  readonly traderPaidAmount: string;
  readonly traderSettlementStatus: string;
}

interface Plan {
  readonly blockers: OrderCorrectionIssue[];
  readonly collection: CollectionPlan | null;
  readonly driverFee: OrderCorrectionPreview["driverFee"];
  readonly order: OrderRow;
  readonly settlements: readonly SettlementPlanLine[];
  readonly warnings: OrderCorrectionIssue[];
  readonly zeroDue: readonly ZeroDuePlanLine[];
}

const money = (value: Decimal.Value) => new Decimal(value).toFixed(2);

@Injectable()
export class OrderCorrectionService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
    @Inject(OperationsService) private readonly operations: OperationsService,
    @Inject(DriverCashReconciliationService)
    private readonly reconciliations: DriverCashReconciliationService,
    @Inject(TraderSettlementService) private readonly settlements: TraderSettlementService,
  ) {}

  /** What a correction of this Order would do. Read-only. */
  public async preview(orderId: string): Promise<OrderCorrectionPreview> {
    this.assertAdministrator();
    const { companyId } = this.tenants.current();
    const plan = await this.plan(this.database, companyId, orderId, false);
    return this.toPreview(plan);
  }

  /** Every correction ever made to this Order, newest first. */
  public async correctionsForOrder(orderId: string): Promise<readonly OrderCorrectionHistoryRow[]> {
    const { companyId } = this.tenants.current();
    const rows = await sql<
      Omit<OrderCorrectionHistoryRow, "lines"> & {
        readonly lines: OrderCorrectionHistoryRow["lines"] | null;
      }
    >`
      select c.id as "correctionId", c.correction_number as "correctionNumber",
             c.created_at::text as "correctedAt", coalesce(actor.username, 'Unknown') as "correctedBy",
             c.reason, c.previous_delivery_status as "previousDeliveryStatus",
             c.collection_amount::text as "collectionAmount",
             c.recovered_amount::text as "recoveredAmount",
             (select jsonb_agg(jsonb_build_object(
                       'kind', line.line_kind,
                       'documentId', coalesce(line.reconciliation_id, line.settlement_id, line.zero_invoice_id),
                       'documentNumber', coalesce(r.reconciliation_number, s.settlement_number, zi.invoice_number),
                       'amount', line.amount::text,
                       'recoveryReceivableNumber', rcv.receivable_number)
                     order by line.created_at, line.id)
                from order_correction_lines line
                left join driver_reconciliations r
                  on r.id = line.reconciliation_id and r.company_id = line.company_id
                left join trader_settlements s
                  on s.id = line.settlement_id and s.company_id = line.company_id
                left join trader_zero_invoices zi
                  on zi.id = line.zero_invoice_id and zi.company_id = line.company_id
                left join trader_receivables rcv
                  on rcv.id = line.trader_receivable_id and rcv.company_id = line.company_id
               where line.company_id = c.company_id and line.correction_id = c.id) as lines
        from order_corrections c
        left join accounts actor
          on actor.id = c.created_by_account_id and actor.company_id = c.company_id
       where c.company_id = ${companyId}::uuid and c.order_id = ${orderId}::uuid
       order by c.created_at desc
    `.execute(this.database);
    return rows.rows.map((row) => ({
      ...row,
      collectionAmount: money(row.collectionAmount),
      lines: (row.lines ?? []).map((line) => ({ ...line, amount: money(line.amount) })),
      recoveredAmount: money(row.recoveredAmount),
    }));
  }

  /** Make the correction. One transaction: all of it, or nothing. */
  public async correct(
    orderId: string,
    reason: string,
    correlationId: string,
  ): Promise<OrderCorrectionResult> {
    this.assertAdministrator();
    const trimmedReason = reason.trim();
    if (trimmedReason === "") {
      throw new ApplicationException(
        "order_correction_reason_required",
        "A reason is required to correct an Order",
        HttpStatus.BAD_REQUEST,
      );
    }
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    return this.transactions.execute(async (transaction) => {
      // Same lock order as a whole-document reversal (document header, then
      // its Orders): a reversal racing this correction waits for it and then
      // sees the correction, instead of undoing the same money a second time.
      await sql`
        select r.id from driver_reconciliations r
         where r.company_id = ${companyId}::uuid
           and r.id in (select link.reconciliation_id from driver_reconciliation_orders link
                         where link.company_id = ${companyId}::uuid and link.order_id = ${orderId}::uuid)
         order by r.id
         for update
      `.execute(transaction);
      await sql`
        select s.id from trader_settlements s
         where s.company_id = ${companyId}::uuid
           and s.id in (select link.settlement_id from trader_settlement_orders link
                         where link.company_id = ${companyId}::uuid and link.order_id = ${orderId}::uuid
                        union
                        select z.settlement_id from trader_settlement_zero_due_orders z
                         where z.company_id = ${companyId}::uuid and z.order_id = ${orderId}::uuid
                           and z.settlement_id is not null)
         order by s.id
         for update
      `.execute(transaction);
      await sql`
        select zi.id from trader_zero_invoices zi
         where zi.company_id = ${companyId}::uuid
           and zi.id in (select z.zero_invoice_id from trader_settlement_zero_due_orders z
                          where z.company_id = ${companyId}::uuid and z.order_id = ${orderId}::uuid
                            and z.zero_invoice_id is not null)
         order by zi.id
         for update
      `.execute(transaction);
      const plan = await this.plan(transaction, companyId, orderId, true);
      const blocker = plan.blockers[0];
      if (blocker !== undefined) {
        throw new ApplicationException(blocker.code, blocker.message, HttpStatus.CONFLICT);
      }
      const { order } = plan;
      const correctionNumber = await this.history.nextReferenceNumber(
        transaction,
        companyId,
        "order_correction",
        "DCX",
      );
      const businessDate = (
        await sql<{ today: string }>`select ((now() at time zone 'Asia/Dubai')::date)::text as today`.execute(
          transaction,
        )
      ).rows[0]!.today;
      const collection = plan.collection;
      const collectionMoney = collection !== null && collection.method !== "none" && collection.amount.greaterThan(0);
      const recoveredTotal = plan.settlements.reduce(
        (sum, line) => sum.plus(line.allocated),
        new Decimal(0),
      );

      // Stored report lines, so the original documents can still print this
      // Order exactly as they did, whatever later happens to the Order.
      const collectionReportRow =
        collection === null
          ? null
          : ((
              await this.reconciliations.reportOrderRows(
                transaction,
                companyId,
                collection.reconciliationId,
                order.id,
              )
            )[0] ?? null);
      const settlementReportLines = new Map<string, unknown>();
      for (const line of plan.settlements) {
        const reportLine = (
          await this.settlements.activeSettlementLines(
            transaction,
            companyId,
            line.settlementId,
            order.id,
          )
        )[0];
        settlementReportLines.set(line.lineId, reportLine ?? null);
      }
      const zeroReportLine = plan.zeroDue.length === 0 ? null : await this.zeroDueReportLine(transaction, companyId, order.id);

      const correctionId = randomUUID();
      await sql`
        insert into order_corrections (
          id, company_id, correction_number, order_id, correction_type, reason, business_date,
          trader_id, driver_id, reconciliation_id, collection_amount, collection_payment_method,
          collection_bank_account_id, recovered_amount, previous_delivery_status, order_snapshot, correlation_id,
          created_by_account_id
        ) values (
          ${correctionId}::uuid, ${companyId}::uuid, ${correctionNumber}, ${order.id}::uuid,
          'wrong_delivery', ${trimmedReason}, ${businessDate}::date,
          ${order.traderId}::uuid, ${order.assignedDriverId}::uuid,
          ${collection?.reconciliationId ?? null}::uuid,
          ${collectionMoney ? money(collection.amount) : "0.00"},
          ${collectionMoney ? collection.method : null},
          ${collectionMoney && collection.method === "visa" ? collection.bankAccountId : null}::uuid,
          ${money(recoveredTotal)}, ${order.deliveryStatus},
          ${JSON.stringify({
            collection:
              collection === null
                ? null
                : {
                    amount: money(collection.amount),
                    method: collection.method,
                    reconciliationNumber: collection.reconciliationNumber,
                  },
            order,
            settlements: plan.settlements.map((line) => ({
              allocated: money(line.allocated),
              settlementNumber: line.settlementNumber,
            })),
            zeroDue: plan.zeroDue.map((line) => line.documentNumber),
          })}::jsonb,
          ${correlationId}, ${identity.identityId}::uuid
        )
      `.execute(transaction);

      if (collection !== null) {
        await sql`
          insert into order_correction_lines (
            company_id, correction_id, order_id, line_kind, driver_reconciliation_order_id,
            reconciliation_id, amount, snapshot
          ) values (
            ${companyId}::uuid, ${correctionId}::uuid, ${order.id}::uuid, 'driver_collection',
            ${collection.lineId}::uuid, ${collection.reconciliationId}::uuid,
            ${collectionMoney ? money(collection.amount) : "0.00"},
            ${JSON.stringify({ reportRow: collectionReportRow })}::jsonb
          )
        `.execute(transaction);
      }

      const recoveryNumbers: string[] = [];
      const recoveryByLine = new Map<string, string>();
      for (const line of plan.settlements) {
        let receivableId: string | null = null;
        if (line.allocated.greaterThan(0)) {
          const receivableNumber = await this.history.nextReferenceNumber(
            transaction,
            companyId,
            "trader_receivable",
            "RCV",
          );
          const recoveryReason = `Paid on ${line.settlementNumber} for ${order.serialNumber}${
            order.referenceNumber === null ? "" : ` (ref ${order.referenceNumber})`
          }, removed by ${correctionNumber}: ${trimmedReason}`;
          receivableId = randomUUID();
          await sql`
            insert into trader_receivables (
              id, company_id, receivable_number, trader_id, source_type, source_reference,
              business_date, original_amount_due, amount_collected, status, reason, notes,
              created_by_account_id
            ) values (
              ${receivableId}::uuid, ${companyId}::uuid, ${receivableNumber}, ${order.traderId}::uuid,
              'overpayment_recovery', ${order.orderNumber}, ${businessDate}::date,
              ${money(line.allocated)}, 0, 'outstanding', ${recoveryReason},
              ${`Created by order correction ${correctionNumber}. Deduct it on the Trader's next settlement or collect it.`},
              ${identity.identityId}::uuid
            )
          `.execute(transaction);
          await this.history.audit(transaction, {
            action: "trader_receivable.create",
            actorId: identity.identityId,
            after: {
              amountDue: money(line.allocated),
              businessDate,
              correctionNumber,
              reason: recoveryReason,
              receivableNumber,
              sourceReference: order.orderNumber,
              sourceType: "overpayment_recovery",
              traderId: order.traderId,
            },
            companyId,
            correlationId,
            subjectId: receivableId,
            subjectType: "trader_receivable",
          });
          recoveryNumbers.push(receivableNumber);
          recoveryByLine.set(line.lineId, receivableNumber);
        }
        await sql`
          insert into order_correction_lines (
            company_id, correction_id, order_id, line_kind, trader_settlement_order_id,
            settlement_id, amount, trader_receivable_id, snapshot
          ) values (
            ${companyId}::uuid, ${correctionId}::uuid, ${order.id}::uuid, 'trader_settlement',
            ${line.lineId}::uuid, ${line.settlementId}::uuid, ${money(line.allocated)},
            ${receivableId}::uuid,
            ${JSON.stringify({ reportLine: settlementReportLines.get(line.lineId) ?? null })}::jsonb
          )
        `.execute(transaction);
      }
      for (const line of plan.zeroDue) {
        await sql`
          insert into order_correction_lines (
            company_id, correction_id, order_id, line_kind, zero_due_order_id,
            settlement_id, zero_invoice_id, amount, snapshot
          ) values (
            ${companyId}::uuid, ${correctionId}::uuid, ${order.id}::uuid, 'zero_due',
            ${line.lineId}::uuid, ${line.settlementId}::uuid, ${line.zeroInvoiceId}::uuid, 0,
            ${JSON.stringify({ reportLine: zeroReportLine })}::jsonb
          )
        `.execute(transaction);
      }

      // The cash the collection recorded for this Order leaves the drawer
      // again: the operational mirror of the correction's Accounting Event.
      let movementNumber: string | null = null;
      if (collectionMoney) {
        movementNumber = await this.collectionMovement(transaction, {
          actorId: identity.identityId,
          amount: collection.amount,
          bankAccountId: collection.bankAccountId,
          businessDate,
          cashAccountId: collection.cashAccountId,
          companyId,
          correctionId,
          correctionNumber,
          method: collection.method === "visa" ? "visa" : "cash",
          orderNumber: order.serialNumber,
          reconciliationNumber: collection.reconciliationNumber,
        });
      }

      const actorRole = await this.history.actorRole(transaction, companyId, identity.identityId);
      const historyReason = `${correctionNumber}: ${trimmedReason}`;
      // Order-level effects, each with its own history row and event.
      if (plan.settlements.length > 0) {
        const newPaid = Decimal.max(new Decimal(order.traderPaidAmount).minus(recoveredTotal), 0);
        await sql`
          update orders set trader_paid_amount = ${money(newPaid)},
                            trader_settlement_status = 'unsettled',
                            updated_at = now(), version = version + 1
           where id = ${order.id}::uuid and company_id = ${companyId}::uuid
        `.execute(transaction);
        if (order.traderSettlementStatus !== "unsettled") {
          await this.history.statusHistory(transaction, {
            actorId: identity.identityId,
            companyId,
            from: order.traderSettlementStatus,
            orderId: order.id,
            reason: historyReason,
            statusDimension: "trader_settlement",
            suppressTraderNotification: true,
            to: "unsettled",
          });
        }
        for (const line of plan.settlements) {
          await this.history.orderEvent(transaction, {
            actorId: identity.identityId,
            actorRole,
            category: "financial_change",
            companyId,
            correlationId,
            eventType: "order_correction.removed_from_settlement",
            fieldName: "trader_settlement_status",
            newValue: {
              amountPaid: money(line.allocated),
              correctionNumber,
              recoveredAs: recoveryByLine.get(line.lineId) ?? null,
              settlementNumber: line.settlementNumber,
            },
            orderId: order.id,
            previousValue: order.traderSettlementStatus,
            reason: historyReason,
            relatedSettlementId: line.settlementId,
            source: "web_portal",
          });
        }
      }
      if (collection !== null) {
        await sql`
          update orders set driver_reconciliation_status = 'not_applicable',
                            updated_at = now(), version = version + 1
           where id = ${order.id}::uuid and company_id = ${companyId}::uuid
        `.execute(transaction);
        if (order.driverReconciliationStatus === "reconciled") {
          await this.history.statusHistory(transaction, {
            actorId: identity.identityId,
            companyId,
            from: "reconciled",
            orderId: order.id,
            reason: historyReason,
            statusDimension: "driver_reconciliation",
            to: "reversed",
          });
          await this.history.statusHistory(transaction, {
            actorId: identity.identityId,
            companyId,
            from: "reversed",
            orderId: order.id,
            reason: historyReason,
            statusDimension: "driver_reconciliation",
            to: "not_applicable",
          });
        }
        await this.history.orderEvent(transaction, {
          actorId: identity.identityId,
          actorRole,
          category: "financial_change",
          companyId,
          correlationId,
          eventType: "order_correction.removed_from_driver_collection",
          fieldName: "driver_reconciliation_status",
          newValue: {
            amount: collectionMoney ? money(collection.amount) : "0.00",
            correctionNumber,
            movementNumber,
            reconciliationNumber: collection.reconciliationNumber,
          },
          orderId: order.id,
          previousValue: order.driverReconciliationStatus,
          reason: historyReason,
          relatedDriverId: order.assignedDriverId,
          relatedReconciliationId: collection.reconciliationId,
          source: "web_portal",
        });
      }

      // Back to Out for Delivery through the existing controlled reopen: it
      // writes its own delivery history, event and audit, and its status
      // change reverses the Order's delivery accounting.
      await this.operations.reopenDeliveredOrder(order.id, historyReason, correlationId, transaction);

      await this.history.orderEvent(transaction, {
        actorId: identity.identityId,
        actorRole,
        category: "user_action",
        companyId,
        correlationId,
        eventType: "order_correction.created",
        fieldName: "delivery_status",
        newValue: {
          collectionAmount: collectionMoney ? money(collection.amount) : "0.00",
          correctionNumber,
          recoveredAmount: money(recoveredTotal),
          recoveryReceivableNumbers: recoveryNumbers,
          status: "out_for_delivery",
        },
        orderId: order.id,
        previousValue: order.deliveryStatus,
        reason: trimmedReason,
        source: "web_portal",
      });
      await this.history.audit(transaction, {
        action: "order_correction.create",
        actorId: identity.identityId,
        after: {
          collection:
            collection === null
              ? null
              : {
                  amount: collectionMoney ? money(collection.amount) : "0.00",
                  method: collection.method,
                  movementNumber,
                  reconciliationNumber: collection.reconciliationNumber,
                },
          correctionNumber,
          orderNumber: order.orderNumber,
          reason: trimmedReason,
          recoveredAmount: money(recoveredTotal),
          recoveryReceivableNumbers: recoveryNumbers,
          settlements: plan.settlements.map((line) => ({
            amountPaid: money(line.allocated),
            settlementNumber: line.settlementNumber,
          })),
          zeroDue: plan.zeroDue.map((line) => line.documentNumber),
        },
        companyId,
        correlationId,
        subjectId: correctionId,
        subjectType: "order_correction",
      });

      return {
        collectionAmount: collectionMoney ? money(collection.amount) : "0.00",
        correctionId,
        correctionNumber,
        movementNumber,
        recoveredAmount: money(recoveredTotal),
        recoveryReceivableNumbers: recoveryNumbers,
      };
    });
  }

  // ------------------------------------------------------------------ plan

  private async plan(
    executor: Kysely<DatabaseSchema>,
    companyId: string,
    orderId: string,
    lock: boolean,
  ): Promise<Plan> {
    const order = (
      await sql<OrderRow>`
        select o.id, o.order_number as "orderNumber",
               coalesce(o.serial_number, o.order_number) as "serialNumber",
               o.reference_number as "referenceNumber", o.delivery_status as "deliveryStatus",
               o.trader_id as "traderId", t.name_en as "traderName",
               o.assigned_driver_id as "assignedDriverId", d.name_en as "driverName",
               o.driver_reconciliation_status as "driverReconciliationStatus",
               o.trader_settlement_status as "traderSettlementStatus",
               o.trader_paid_amount::text as "traderPaidAmount"
          from orders o
          join traders t on t.id = o.trader_id and t.company_id = o.company_id
          left join drivers d on d.id = o.assigned_driver_id and d.company_id = o.company_id
         where o.id = ${orderId}::uuid and o.company_id = ${companyId}::uuid
         ${lock ? sql`for update of o` : sql``}
      `.execute(executor)
    ).rows[0];
    if (order === undefined) {
      throw new ApplicationException("order_not_found", "Order not found", HttpStatus.NOT_FOUND);
    }
    const blockers: OrderCorrectionIssue[] = [];
    const warnings: OrderCorrectionIssue[] = [];
    if (order.deliveryStatus !== "delivered") {
      blockers.push({
        code: "order_correction_requires_delivered",
        message:
          order.deliveryStatus === "closed"
            ? "This Order is Closed. Only a Delivered Order can be corrected here."
            : "Only a Delivered Order can be corrected as a wrong delivery.",
      });
    }
    if (order.assignedDriverId === null) {
      blockers.push({
        code: "order_driver_required_for_delivery",
        message: "The Order has no Driver. A Driver must stay assigned so it can go back to Out for Delivery.",
      });
    }

    const collectionRow = (
      await sql<{
        amount: string;
        driverPayableDeduction: string;
        headerMethod: string | null;
        lineId: string;
        lineMethod: string | null;
        otherOrderCount: number;
        receivedAsConfirmed: string;
        reconciliationId: string;
        reconciliationNumber: string;
      }>`
        select link.id as "lineId", r.id as "reconciliationId",
               r.reconciliation_number as "reconciliationNumber",
               link.customer_collection_amount::text as amount,
               link.driver_payable_deduction::text as "driverPayableDeduction",
               link.collection_payment_method as "lineMethod",
               r.collection_payment_method as "headerMethod",
               (select count(*)::int from driver_reconciliation_orders other
                 where other.company_id = r.company_id and other.reconciliation_id = r.id
                   and other.id <> link.id and ${collectionLineActiveSql("other")}) as "otherOrderCount",
               ((select coalesce(sum(case when p.direction = 'out' then -p.amount else p.amount end), 0)
                   from driver_reconciliation_payments p
                  where p.company_id = r.company_id and p.reconciliation_id = r.id)
                - coalesce((select sum(x.amount) from order_correction_lines x
                             where x.company_id = r.company_id and x.reconciliation_id = r.id
                               and x.line_kind = 'driver_collection'), 0))::text as "receivedAsConfirmed"
          from driver_reconciliation_orders link
          join driver_reconciliations r on r.id = link.reconciliation_id and r.company_id = link.company_id
         where link.company_id = ${companyId}::uuid and link.order_id = ${orderId}::uuid
           and ${collectionLineActiveSql("link")}
           and r.status = 'confirmed' and r.reversal_of_id is null
           and not exists (select 1 from driver_reconciliations rv
                            where rv.company_id = r.company_id and rv.reversal_of_id = r.id)
         order by r.confirmed_at desc
         limit 1
         ${lock ? sql`for update of link` : sql``}
      `.execute(executor)
    ).rows[0];
    let collection: CollectionPlan | null = null;
    if (collectionRow !== undefined) {
      const amount = new Decimal(collectionRow.amount);
      const method: CollectionPlan["method"] = amount.isZero()
        ? "none"
        : (collectionRow.lineMethod ?? collectionRow.headerMethod) === "visa"
          ? "visa"
          : "cash";
      const accounts = await this.collectionAccounts(
        executor,
        companyId,
        collectionRow.reconciliationId,
        method,
      );
      collection = {
        amount,
        bankAccountId: accounts.bankAccountId,
        cashAccountId: accounts.cashAccountId,
        driverPayableDeduction: new Decimal(collectionRow.driverPayableDeduction),
        lineId: collectionRow.lineId,
        method,
        otherOrderCount: collectionRow.otherOrderCount,
        receivedAsConfirmed: new Decimal(collectionRow.receivedAsConfirmed),
        reconciliationId: collectionRow.reconciliationId,
        reconciliationNumber: collectionRow.reconciliationNumber,
      };
      if (collection.driverPayableDeduction.greaterThan(0)) {
        blockers.push({
          code: "order_correction_driver_fee_offset",
          message: `${collection.reconciliationNumber} deducted a Driver fee on this Order. This case is not supported yet; contact support.`,
        });
      }
      if (method === "cash" && accounts.cashAccountId === null) {
        blockers.push({
          code: "order_correction_cash_account_missing",
          message: `No Cash account was found for ${collection.reconciliationNumber}.`,
        });
      }
      if (method === "visa" && accounts.bankAccountId === null) {
        blockers.push({
          code: "order_correction_bank_account_missing",
          message: `No Bank account was found for the Visa money of ${collection.reconciliationNumber}.`,
        });
      }
    } else if (order.driverReconciliationStatus === "reconciled") {
      blockers.push({
        code: "order_correction_collection_not_found",
        message: "The Order shows as collected but its Driver collection could not be found. Contact support.",
      });
    }

    const settlements = (
      await sql<{
        allocated: string;
        lineId: string;
        otherOrderCount: number;
        settlementId: string;
        settlementNumber: string;
      }>`
        select link.id as "lineId", s.id as "settlementId", s.settlement_number as "settlementNumber",
               link.allocated_amount::text as allocated,
               (select count(*)::int from trader_settlement_orders other
                 where other.company_id = s.company_id and other.settlement_id = s.id
                   and other.id <> link.id and ${settlementLineActiveSql("other")}) as "otherOrderCount"
          from trader_settlement_orders link
          join trader_settlements s on s.id = link.settlement_id and s.company_id = link.company_id
         where link.company_id = ${companyId}::uuid and link.order_id = ${orderId}::uuid
           and ${settlementLineActiveSql("link")}
           and s.status = 'confirmed' and s.reversal_of_id is null
           and not exists (select 1 from trader_settlements rv
                            where rv.company_id = s.company_id and rv.reversal_of_id = s.id)
         order by s.created_at
         ${lock ? sql`for update of link` : sql``}
      `.execute(executor)
    ).rows.map((row) => ({ ...row, allocated: new Decimal(row.allocated) }));
    const paidTotal = settlements.reduce((sum, line) => sum.plus(line.allocated), new Decimal(0));
    if (!paidTotal.equals(new Decimal(order.traderPaidAmount))) {
      blockers.push({
        code: "order_correction_paid_amount_mismatch",
        message: `The Order shows ${money(order.traderPaidAmount)} paid to the Trader but its settlements add up to ${money(paidTotal)}. Run Order Maintenance first.`,
      });
    }
    if (settlements.length > 0) {
      warnings.push({
        code: "order_correction_settlement_unsent",
        message:
          "If the settlement money has NOT reached the Trader yet, use Un-post on the settlement instead and post it again without this Order.",
      });
    }

    const zeroDue = (
      await sql<{
        documentNumber: string;
        lineId: string;
        settlementId: string | null;
        zeroInvoiceId: string | null;
      }>`
        select z.id as "lineId", z.settlement_id as "settlementId",
               z.zero_invoice_id as "zeroInvoiceId",
               coalesce(s.settlement_number, zi.invoice_number) as "documentNumber"
          from trader_settlement_zero_due_orders z
          left join trader_settlements s on s.id = z.settlement_id and s.company_id = z.company_id
          left join trader_zero_invoices zi on zi.id = z.zero_invoice_id and zi.company_id = z.company_id
         where z.company_id = ${companyId}::uuid and z.order_id = ${orderId}::uuid
           and ${zeroDueLineActiveSql("z")}
           and (
             (s.id is not null and s.status = 'confirmed' and s.reversal_of_id is null
              and not exists (select 1 from trader_settlements rv
                               where rv.company_id = s.company_id and rv.reversal_of_id = s.id))
             or (zi.id is not null and zi.reversed_at is null)
           )
      `.execute(executor)
    ).rows;

    // The Order's own service fee charged to the Trader: an outstanding one is
    // cancelled automatically when the Order is cancelled; one already
    // collected or deducted needs a decision this tool does not make.
    const fees = (
      await sql<{ amountCollected: string; receivableNumber: string; status: string }>`
        select r.receivable_number as "receivableNumber", r.status,
               r.amount_collected::text as "amountCollected"
          from trader_receivables r
          join orders o on o.company_id = r.company_id and o.order_number = r.source_reference
         where r.company_id = ${companyId}::uuid and o.id = ${orderId}::uuid
           and r.source_type = 'service_charge'
           and r.status not in ('cancelled', 'reversed')
      `.execute(executor)
    ).rows;
    for (const fee of fees) {
      if (new Decimal(fee.amountCollected).greaterThan(0)) {
        blockers.push({
          code: "order_correction_fee_already_collected",
          message: `The Trader fee ${fee.receivableNumber} for this Order was already collected or deducted. This case is not supported yet; contact support.`,
        });
      } else {
        warnings.push({
          code: "order_correction_fee_outstanding",
          message: `The Trader fee ${fee.receivableNumber} for this Order is cancelled automatically when you cancel or return the Order.`,
        });
      }
    }

    const driverFee = (
      await sql<{ amount: string; paid: string; status: string }>`
        select earned_amount::text as amount, paid_amount::text as paid, status
          from outsourced_driver_fee_accruals
         where company_id = ${companyId}::uuid and order_id = ${orderId}::uuid
           and earning_type = 'delivery' and status not in ('reversed', 'recovery_required')
         order by created_at desc limit 1
      `.execute(executor)
    ).rows[0];
    if (driverFee !== undefined) {
      warnings.push({
        code: "order_correction_driver_fee",
        message: new Decimal(driverFee.paid).greaterThan(0)
          ? `The Driver was already paid ${money(driverFee.paid)} for this delivery. Cancelling the Order marks it to recover from the Driver.`
          : `The Driver's delivery fee (${money(driverFee.amount)}) is reversed automatically when you cancel or return the Order.`,
      });
    }

    // A saved (not posted) settlement draft that still lists this Order would
    // refuse to post once the Order is no longer delivered.
    const drafts = (
      await sql<{ traderName: string }>`
        select t.name_en as "traderName"
          from trader_settlement_drafts d
          join traders t on t.id = d.trader_id and t.company_id = d.company_id
         where d.company_id = ${companyId}::uuid and d.status = 'draft'
           and jsonb_typeof(d.payload -> 'allocations') = 'array'
           and exists (select 1 from jsonb_array_elements(d.payload -> 'allocations') item
                        where item ->> 'orderId' = ${orderId})
      `.execute(executor)
    ).rows;
    if (drafts.length > 0) {
      warnings.push({
        code: "order_correction_in_draft",
        message: `A saved settlement draft for ${drafts[0]!.traderName} includes this Order. Untick it in that draft before posting it.`,
      });
    }

    const employeeDriver = (
      await sql<{ employee: boolean }>`
        select d.driver_type = 'employee' as employee from drivers d
         where d.company_id = ${companyId}::uuid and d.id = ${order.assignedDriverId}::uuid
      `.execute(executor)
    ).rows[0]?.employee === true;
    if (employeeDriver && collection !== null) {
      warnings.push({
        code: "order_correction_employee_collection_earning",
        message:
          "The Driver is an employee: a collection earning already counted for this collection is not changed.",
      });
    }

    return {
      blockers,
      collection,
      driverFee:
        driverFee === undefined
          ? null
          : { amount: money(driverFee.amount), paid: money(driverFee.paid), status: driverFee.status },
      order,
      settlements,
      warnings,
      zeroDue,
    };
  }

  private toPreview(plan: Plan): OrderCorrectionPreview {
    const { collection, order } = plan;
    const removedMoney =
      collection !== null && collection.method !== "none" ? collection.amount : new Decimal(0);
    return {
      blockers: plan.blockers,
      canCorrect: plan.blockers.length === 0,
      collection:
        collection === null
          ? null
          : {
              amount: money(collection.amount),
              otherOrderCount: collection.otherOrderCount,
              paymentMethod: collection.method,
              receivedAfterCorrection: money(collection.receivedAsConfirmed.minus(removedMoney)),
              receivedAsConfirmed: money(collection.receivedAsConfirmed),
              reconciliationId: collection.reconciliationId,
              reconciliationNumber: collection.reconciliationNumber,
            },
      deliveryStatus: order.deliveryStatus,
      driverFee: plan.driverFee,
      driverName: order.driverName,
      newDeliveryStatus: "out_for_delivery",
      orderId: order.id,
      orderNumber: order.orderNumber,
      recoveryTotal: money(
        plan.settlements.reduce((sum, line) => sum.plus(line.allocated), new Decimal(0)),
      ),
      referenceNumber: order.referenceNumber,
      serialNumber: order.serialNumber,
      settlements: plan.settlements.map((line) => ({
        amountPaid: money(line.allocated),
        otherOrderCount: line.otherOrderCount,
        settlementId: line.settlementId,
        settlementNumber: line.settlementNumber,
      })),
      traderName: order.traderName,
      warnings: plan.warnings,
      zeroDueDocuments: plan.zeroDue.map((line) => line.documentNumber),
    };
  }

  /** Where the collection put the money: the account its Movement or payment row recorded. */
  private async collectionAccounts(
    executor: Kysely<DatabaseSchema>,
    companyId: string,
    reconciliationId: string,
    method: "cash" | "visa" | "none",
  ): Promise<{ readonly bankAccountId: string | null; readonly cashAccountId: string | null }> {
    if (method === "none") return { bankAccountId: null, cashAccountId: null };
    const row = (
      await sql<{ bankAccountId: string | null; cashAccountId: string | null }>`
        select
          coalesce(
            (select m.destination_cash_account_id from cash_bank_movements m
              where m.company_id = r.company_id and m.correlation_id = r.id::text
                and m.movement_type = 'cash_deposit' and m.status = 'confirmed'
              order by m.created_at limit 1),
            (select p.company_cash_account_id from driver_reconciliation_payments p
              where p.company_id = r.company_id and p.reconciliation_id = r.id
                and p.payment_method = 'cash' and p.direction = 'in'
                and p.company_cash_account_id is not null
              order by p.created_at limit 1),
            (select c.id from company_cash_accounts c
              where c.company_id = r.company_id and c.is_active and c.cash_account_type = 'main_cash'
              order by c.created_at limit 1)
          ) as "cashAccountId",
          coalesce(
            (select m.destination_bank_account_id from cash_bank_movements m
              where m.company_id = r.company_id and m.correlation_id = r.id::text
                and m.movement_type = 'bank_deposit' and m.status = 'confirmed'
              order by m.created_at limit 1),
            (select p.company_bank_account_id from driver_reconciliation_payments p
              where p.company_id = r.company_id and p.reconciliation_id = r.id
                and p.payment_method = 'bank_transfer' and p.direction = 'in'
                and p.company_bank_account_id is not null
              order by p.created_at limit 1)
          ) as "bankAccountId"
          from driver_reconciliations r
         where r.company_id = ${companyId}::uuid and r.id = ${reconciliationId}::uuid
      `.execute(executor)
    ).rows[0];
    return {
      bankAccountId: method === "visa" ? (row?.bankAccountId ?? null) : null,
      cashAccountId: method === "cash" ? (row?.cashAccountId ?? null) : null,
    };
  }

  /** The withdrawal Movement mirroring the correction's money, linked to its Accounting Event. */
  private async collectionMovement(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly actorId: string;
      readonly amount: Decimal;
      readonly bankAccountId: string | null;
      readonly businessDate: string;
      readonly cashAccountId: string | null;
      readonly companyId: string;
      readonly correctionId: string;
      readonly correctionNumber: string;
      readonly method: "cash" | "visa";
      readonly orderNumber: string;
      readonly reconciliationNumber: string;
    },
  ): Promise<string> {
    const ownership = (
      await sql<{ accountingEnabled: boolean; eventId: string | null }>`
        select
          (select e.id from accounting_events e
            where e.company_id = ${input.companyId}::uuid
              and e.source_entity_type = 'order_correction'
              and e.source_entity_id = ${input.correctionId}::uuid
              and e.event_type = 'driver_collection_corrected') as "eventId",
          exists (select 1 from accounting_configurations c
                   where c.company_id = ${input.companyId}::uuid and c.accounting_enabled) as "accountingEnabled"
      `.execute(transaction)
    ).rows[0];
    if (ownership?.accountingEnabled === true && ownership.eventId === null) {
      throw new ApplicationException(
        "order_correction_accounting_event_missing",
        "The correction could not be linked to Accounting",
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    const movementNumber = await this.history.nextReferenceNumber(
      transaction,
      input.companyId,
      "cash_bank_movement",
      "CBM",
    );
    const isCash = input.method === "cash";
    await sql`
      insert into cash_bank_movements (
        id, company_id, movement_number, movement_type, movement_date, accounting_date,
        source_cash_account_id, source_bank_account_id, destination_cash_account_id,
        destination_bank_account_id, amount, fee_amount, payment_method, reference_number,
        description, status, correlation_id, idempotency_identity, accounting_event_id,
        confirmed_by_account_id, confirmed_at, created_by_account_id, created_at
      ) values (
        ${randomUUID()}::uuid, ${input.companyId}::uuid, ${movementNumber},
        ${isCash ? "cash_withdrawal" : "bank_withdrawal"},
        ${input.businessDate}::date, ${input.businessDate}::date,
        ${isCash ? input.cashAccountId : null}::uuid, ${isCash ? null : input.bankAccountId}::uuid,
        null::uuid, null::uuid, ${money(input.amount)}::numeric, '0'::numeric,
        ${isCash ? "cash" : "visa"}, ${input.correctionNumber},
        ${`Order correction ${input.correctionNumber}: ${input.orderNumber} was not collected (${input.reconciliationNumber})`},
        'confirmed', ${input.correctionId}, ${`${input.correctionNumber}_${movementNumber}`},
        ${ownership?.eventId ?? null}::uuid, ${input.actorId}::uuid, now(),
        ${input.actorId}::uuid, now()
      )
    `.execute(transaction);
    return movementNumber;
  }

  /** The 0-due report line for this Order, as the Trader Invoice prints it. */
  private async zeroDueReportLine(
    executor: Kysely<DatabaseSchema>,
    companyId: string,
    orderId: string,
  ): Promise<Record<string, unknown> | null> {
    const row = (
      await sql<Record<string, string | null>>`
        select o.order_number as "orderNumber", o.order_type as "orderType",
               coalesce(o.serial_number, o.order_number) as "serialNumber",
               o.reference_number as "referenceNumber", o.delivered_at::text as "deliveryDate",
               o.customer_name as "customerName", o.customer_mobile_number as "customerMobileNumber",
               e.name_en as "emirateName", e.name_ar as "emirateNameAr",
               coalesce(o.customer_area_name_snapshot, a.name_en, '') as "areaName", a.name_ar as "areaNameAr",
               to_char(o.cod_amount, 'FM999999999990.00') as "codAmount",
               to_char(o.service_fee, 'FM999999999990.00') as "serviceFee",
               to_char(coalesce(o.additional_fees, 0), 'FM999999999990.00') as "additionalFees",
               to_char(coalesce(o.vat_amount, 0), 'FM999999999990.00') as "vatAmount",
               to_char(coalesce(o.total_deductions, 0), 'FM999999999990.00') as "totalDeductions",
               o.trader_settlement_status as "orderSettlementStatus"
          from orders o
          left join areas a on a.id = o.area_id and a.company_id = o.company_id
          left join emirates e on e.id = a.emirate_id
         where o.company_id = ${companyId}::uuid and o.id = ${orderId}::uuid
      `.execute(executor)
    ).rows[0];
    if (row === undefined) return null;
    return {
      ...row,
      amountPaidNow: "0.00",
      originalTraderPayable: "0.00",
      paidBeforeThisPayment: "0.00",
      previouslyPaid: "0.00",
      remainingAfterThisPayment: "0.00",
      remainingOutstanding: "0.00",
    };
  }

  private assertAdministrator(): void {
    if (!this.identities.current().permissions.has("users_roles.manage")) {
      throw new ApplicationException(
        "order_correction_admin_required",
        "Only an administrator can correct a delivered Order",
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
