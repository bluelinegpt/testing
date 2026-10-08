import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import type { Kysely } from "kysely";
import { sql } from "kysely";

import type { AccountingEventType } from "../accounting/accounting.constants.js";
import { OperationalSourceLoader } from "../accounting/operational-source.loader.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { effectiveSettlement } from "./effective-settlement-offsets.js";
import { closeSettlementComplete } from "./order-close-eligibility.js";
import { calculateOrderFinancials } from "./order-financial-model.js";
import { expectedReceivableStatus } from "./trader-receivable-reconciliation.js";

/**
 * Repair Center Order Validation (spec §3): every check for ONE Order of ONE
 * Company, read-only.
 *
 * READ-ONLY. Nothing here inserts, updates or deletes. Every query carries
 * `company_id` on every table it touches, including sub-selects, so a check can
 * never read another Company's rows even when ids or numbers collide.
 *
 * Domain rules are not re-derived: the money model is `calculateOrderFinancials`,
 * the close gate is `closeSettlementComplete`, "effective" settlement is
 * `effectiveSettlement`, receivable status is `expectedReceivableStatus`, and
 * the expected recognition journal is `OperationalSourceLoader.load()` -- the
 * same code the accounting worker posts with.
 *
 * `CompanyOrderHealthService` is deliberately NOT used: it is not part of the
 * committed tree yet, and this file must build on its own.
 */

export type ValidationSeverity = "pass" | "info" | "warning" | "fail";
export type ValidationGroup =
  "lifecycle" | "financial" | "driver_cash" | "accounting" | "data_entry";

export const ORDER_VALIDATION_CHECK_CODES = [
  "L1",
  "L2",
  "L3",
  "F1",
  "F2",
  "F3",
  "F4",
  "D1",
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "V1",
  "V2",
] as const;
export type OrderValidationCheckCode = (typeof ORDER_VALIDATION_CHECK_CODES)[number];

export interface OrderValidationCheck {
  readonly code: OrderValidationCheckCode;
  readonly group: ValidationGroup;
  readonly severity: ValidationSeverity;
  /** `platform.orderValidation.<code>.title` (or `.strong.title` for the stronger V1). */
  readonly titleKey: string;
  readonly descriptionKey: string;
  readonly stored: unknown;
  readonly expected: unknown;
  /** ORD-/REC-/SET-/RCV-/JRN- numbers involved. */
  readonly refs: readonly string[];
}

export interface OrderValidationResult {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly referenceNumber: string | null;
  readonly version: number;
  readonly accountingEnabled: boolean;
  readonly checks: readonly OrderValidationCheck[];
}

const GROUP: Record<OrderValidationCheckCode, ValidationGroup> = {
  L1: "lifecycle",
  L2: "lifecycle",
  L3: "lifecycle",
  F1: "financial",
  F2: "financial",
  F3: "financial",
  F4: "financial",
  D1: "driver_cash",
  A1: "accounting",
  A2: "accounting",
  A3: "accounting",
  A4: "accounting",
  A5: "accounting",
  V1: "data_entry",
  V2: "data_entry",
};

const RECOGNIZED_STATUSES = ["delivered", "closed"];
const STUCK_ACCOUNTING_STATUSES = ["failed", "retry_pending", "blocked_configuration"];

interface OrderSnapshot {
  readonly id: string;
  readonly orderNumber: string;
  readonly referenceNumber: string | null;
  readonly version: number;
  readonly deliveryStatus: string;
  readonly traderSettlementStatus: string;
  readonly driverReconciliationStatus: string;
  readonly assignedDriverId: string | null;
  readonly deliveredAt: Date | null;
  readonly closedAt: Date | null;
  readonly codAmount: string;
  readonly serviceFee: string;
  readonly additionalFees: string;
  readonly driverCost: string;
  readonly paymentCondition: "customer_pays_cod_and_fee" | "customer_pays_cod_trader_pays_fee";
  readonly customerAmountDue: string;
  readonly amountCollected: string;
  readonly traderGrossPayable: string;
  readonly traderPaidServiceFee: string;
  readonly traderDeductions: string;
  readonly totalDeductions: string;
  readonly traderNetPayable: string;
  readonly traderPaidAmount: string;
  readonly companyRevenue: string;
  readonly vatAmount: string;
  readonly financialModelVersion: string | null;
  readonly vatEnabled: boolean;
  readonly vatRate: string;
  readonly vatPriceMode: "inclusive" | "exclusive" | null;
  readonly accountingStatus: string;
  readonly isFreeOrder: boolean;
}

interface AccountingEventRow {
  readonly id: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly status: string;
  readonly reversalOfEventId: string | null;
  readonly journalId: string | null;
  readonly journalNumber: string | null;
  readonly journalTotalDebit: string | null;
  readonly sourceReference: string | null;
  readonly effectiveAccountingDate: string;
  readonly eventHash: string;
  readonly correlationId: string;
  readonly actorId: string | null;
  readonly operationalArea: string;
  readonly createdAt: Date;
}

function money(value: Decimal.Value): string {
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function sameMoney(a: Decimal.Value, b: Decimal.Value): boolean {
  return new Decimal(a).eq(new Decimal(b));
}

@Injectable()
export class OrderValidationService {
  private readonly sources = new OperationalSourceLoader();

  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  public async validate(
    companyId: string,
    orderId: string,
    version: number,
  ): Promise<OrderValidationResult> {
    const order = await this.order(companyId, orderId, version);
    const accountingEnabled = await this.accountingEnabled(companyId);
    const checks: OrderValidationCheck[] = [
      await this.l1(companyId, order),
      this.l2(order),
      await this.l3(companyId, order),
      this.f1(order),
      await this.f2(companyId, order),
      this.f3(order),
      await this.f4(companyId, order),
      await this.d1(companyId, order),
      ...(await this.accounting(companyId, order, accountingEnabled)),
      this.v1(order),
      await this.v2(companyId, order),
    ];
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      referenceNumber: order.referenceNumber,
      version: order.version,
      accountingEnabled,
      checks,
    };
  }

  // ---------------------------------------------------------------------------
  // Order snapshot
  // ---------------------------------------------------------------------------

  private async order(companyId: string, orderId: string, version: number): Promise<OrderSnapshot> {
    const result = await sql<OrderSnapshot>`
      select id, order_number as "orderNumber", reference_number as "referenceNumber", version::int as version,
             delivery_status as "deliveryStatus", trader_settlement_status as "traderSettlementStatus",
             driver_reconciliation_status as "driverReconciliationStatus",
             assigned_driver_id as "assignedDriverId", delivered_at as "deliveredAt", closed_at as "closedAt",
             cod_amount::text as "codAmount", service_fee::text as "serviceFee",
             coalesce(additional_fees, 0)::text as "additionalFees", driver_cost::text as "driverCost",
             payment_condition as "paymentCondition", customer_amount_due::text as "customerAmountDue",
             amount_collected::text as "amountCollected", trader_gross_payable::text as "traderGrossPayable",
             trader_paid_service_fee::text as "traderPaidServiceFee",
             trader_deductions::text as "traderDeductions", coalesce(total_deductions, 0)::text as "totalDeductions",
             trader_net_payable::text as "traderNetPayable", trader_paid_amount::text as "traderPaidAmount",
             company_revenue::text as "companyRevenue", vat_amount::text as "vatAmount",
             financial_model_version as "financialModelVersion",
             coalesce(vat_enabled_snapshot, false) as "vatEnabled",
             coalesce(vat_rate_snapshot, 0)::text as "vatRate", vat_price_mode_snapshot as "vatPriceMode",
             accounting_status as "accountingStatus", is_free_order as "isFreeOrder"
        from orders
       where company_id = ${companyId}::uuid and id = ${orderId}::uuid
    `.execute(this.database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException("order_not_found", "Order not found.", HttpStatus.NOT_FOUND);
    }
    if (row.version !== version) {
      throw new ApplicationException(
        "order_changed_since_lookup",
        "This Order changed after it was looked up. Look it up again.",
        HttpStatus.CONFLICT,
      );
    }
    return row;
  }

  private async accountingEnabled(companyId: string): Promise<boolean> {
    const result = await sql<{ enabled: boolean }>`
      select accounting_capture_enabled(${companyId}::uuid) as enabled
    `.execute(this.database);
    return result.rows[0]?.enabled === true;
  }

  private check(
    code: OrderValidationCheckCode,
    severity: ValidationSeverity,
    stored: unknown,
    expected: unknown,
    refs: readonly (string | null | undefined)[],
    variant?: "strong",
  ): OrderValidationCheck {
    const key =
      variant === undefined
        ? `platform.orderValidation.${code}`
        : `platform.orderValidation.${code}.${variant}`;
    return {
      code,
      group: GROUP[code],
      severity,
      titleKey: `${key}.title`,
      descriptionKey: `${key}.description`,
      stored,
      expected,
      refs: [
        ...new Set(refs.filter((ref): ref is string => typeof ref === "string" && ref !== "")),
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** L1: delivery_status = the latest delivery-dimension history row; the latest status event agrees. */
  private async l1(companyId: string, order: OrderSnapshot): Promise<OrderValidationCheck> {
    const history = await sql<{ fromStatus: string | null; toStatus: string; occurredAt: Date }>`
      select h.from_status as "fromStatus", h.to_status as "toStatus", h.occurred_at as "occurredAt"
        from order_status_history h
       where h.company_id = ${companyId}::uuid and h.order_id = ${order.id}::uuid
         and h.status_dimension = 'delivery'
         and h.occurred_at = (
           select max(latest.occurred_at) from order_status_history latest
            where latest.company_id = ${companyId}::uuid and latest.order_id = ${order.id}::uuid
              and latest.status_dimension = 'delivery')
    `.execute(this.database);
    const historyStatus = this.terminalStatus(history.rows);
    const event = await sql<{ status: string | null }>`
      select e.new_value #>> '{}' as status
        from order_events e
       where e.company_id = ${companyId}::uuid and e.order_id = ${order.id}::uuid
         and e.field_name = 'delivery_status'
       order by e.occurred_at desc
       limit 1
    `.execute(this.database);
    const eventStatus = event.rows[0]?.status ?? null;
    const historyAgrees =
      historyStatus === null
        ? order.deliveryStatus === "new"
        : historyStatus === order.deliveryStatus;
    const eventAgrees = eventStatus === null || eventStatus === order.deliveryStatus;
    return this.check(
      "L1",
      historyAgrees && eventAgrees ? "pass" : "fail",
      { deliveryStatus: order.deliveryStatus, history: historyStatus, event: eventStatus },
      { history: order.deliveryStatus, event: order.deliveryStatus },
      [order.orderNumber],
    );
  }

  /**
   * Rows written in one transaction share `occurred_at`. The terminal one is the
   * transition whose `to_status` is not the `from_status` of another tied row.
   */
  private terminalStatus(
    rows: readonly { fromStatus: string | null; toStatus: string }[],
  ): string | null {
    if (rows.length === 0) return null;
    if (rows.length === 1) return rows[0]!.toStatus;
    const froms = new Set(rows.map((row) => row.fromStatus));
    const terminal = rows.filter((row) => !froms.has(row.toStatus));
    return terminal.length === 1 ? terminal[0]!.toStatus : rows[rows.length - 1]!.toStatus;
  }

  /** L2: delivered_at for delivered/closed; closed_at if and only if closed. */
  private l2(order: OrderSnapshot): OrderValidationCheck {
    const needsDelivered = RECOGNIZED_STATUSES.includes(order.deliveryStatus);
    const deliveredOk = !needsDelivered || order.deliveredAt !== null;
    const closedOk = (order.deliveryStatus === "closed") === (order.closedAt !== null);
    return this.check(
      "L2",
      deliveredOk && closedOk ? "pass" : "fail",
      {
        deliveryStatus: order.deliveryStatus,
        deliveredAt: order.deliveredAt,
        closedAt: order.closedAt,
      },
      {
        deliveredAt: needsDelivered ? "set" : "any",
        closedAt: order.deliveryStatus === "closed" ? "set" : "empty",
      },
      [order.orderNumber],
    );
  }

  /** L3: the assigned driver matches the open order_assignments row. */
  private async l3(companyId: string, order: OrderSnapshot): Promise<OrderValidationCheck> {
    const result = await sql<{ driverId: string; count: number }>`
      select a.driver_id as "driverId", count(*) over ()::int as count
        from order_assignments a
       where a.company_id = ${companyId}::uuid and a.order_id = ${order.id}::uuid
         and a.unassigned_at is null
       order by a.assigned_at desc
       limit 1
    `.execute(this.database);
    const open = result.rows[0];
    const openDriver = open?.driverId ?? null;
    const ok = (open?.count ?? 0) <= 1 && openDriver === order.assignedDriverId;
    return this.check(
      "L3",
      ok ? "pass" : "fail",
      { assignedDriverId: order.assignedDriverId, openAssignments: open?.count ?? 0 },
      { openAssignmentDriverId: openDriver },
      [order.orderNumber],
    );
  }

  // ---------------------------------------------------------------------------
  // Financial model
  // ---------------------------------------------------------------------------

  /** F1: every stored amount equals `calculateOrderFinancials({ prospective: true })` from the Order's snapshot. */
  private f1(order: OrderSnapshot): OrderValidationCheck {
    if (order.financialModelVersion !== "trader_deduction_v1") {
      return this.check(
        "F1",
        "info",
        { financialModelVersion: order.financialModelVersion },
        "trader_deduction_v1",
        [order.orderNumber],
      );
    }
    const calculated = calculateOrderFinancials({
      prospective: true,
      additionalFees: new Decimal(order.additionalFees),
      codAmount: new Decimal(order.codAmount),
      driverCost: new Decimal(order.driverCost),
      paymentCondition: order.paymentCondition,
      serviceFee: new Decimal(order.serviceFee),
      vatPolicy: {
        enabled: order.vatEnabled,
        priceMode: order.vatPriceMode,
        rate: new Decimal(order.vatRate),
      },
    });
    const stored = {
      customerAmountDue: money(order.customerAmountDue),
      traderGrossPayable: money(order.traderGrossPayable),
      traderPaidServiceFee: money(order.traderPaidServiceFee),
      traderDeductions: money(order.traderDeductions),
      totalDeductions: money(order.totalDeductions),
      traderNetPayable: money(order.traderNetPayable),
      companyRevenue: money(order.companyRevenue),
      vatAmount: money(order.vatAmount),
    };
    const expected = {
      customerAmountDue: money(calculated.customerAmountDue),
      // The Order write path stores the COD as the gross payable.
      traderGrossPayable: money(calculated.codAmount),
      traderPaidServiceFee: money(calculated.traderPaidServiceFee),
      traderDeductions: money(calculated.traderDeductions),
      totalDeductions: money(calculated.totalDeductions),
      traderNetPayable: money(calculated.traderNetPayable),
      companyRevenue: money(calculated.companyRevenue),
      vatAmount: money(calculated.vatAmount),
    };
    const ok = (Object.keys(expected) as (keyof typeof expected)[]).every(
      (key) => stored[key] === expected[key],
    );
    return this.check("F1", ok ? "pass" : "fail", stored, expected, [order.orderNumber]);
  }

  /** F2: settlement status agrees with the net payable; paid/outstanding agree with the effective settlement lines. */
  private async f2(companyId: string, order: OrderSnapshot): Promise<OrderValidationCheck> {
    const result = await sql<{ paid: string; settlementNumber: string }>`
      select coalesce(l.allocated_amount, l.net_payable)::text as paid, s.settlement_number as "settlementNumber"
        from trader_settlement_orders l
        join trader_settlements s on s.company_id = l.company_id and s.id = l.settlement_id
       where l.company_id = ${companyId}::uuid and s.company_id = ${companyId}::uuid
         and l.order_id = ${order.id}::uuid
         and ${effectiveSettlement("s")}
       order by s.settlement_number
    `.execute(this.database);
    const paid = result.rows.reduce((sum, row) => sum.plus(row.paid), new Decimal(0));
    const net = new Decimal(order.traderNetPayable);
    const statusOk = net.isZero()
      ? order.traderSettlementStatus === "not_eligible"
      : order.traderSettlementStatus !== "not_eligible";
    const paidOk = sameMoney(order.traderPaidAmount, paid) && paid.lte(net);
    return this.check(
      "F2",
      statusOk && paidOk ? "pass" : "fail",
      {
        status: order.traderSettlementStatus,
        paid: money(order.traderPaidAmount),
        outstanding: money(net.minus(order.traderPaidAmount)),
      },
      {
        status: net.isZero() ? "not_eligible" : "not not_eligible",
        paid: money(paid),
        outstanding: money(net.minus(paid)),
      },
      [order.orderNumber, ...result.rows.map((row) => row.settlementNumber)],
    );
  }

  /** F3: a closed Order satisfies the close gate. */
  private f3(order: OrderSnapshot): OrderValidationCheck {
    if (order.deliveryStatus !== "closed") {
      return this.check(
        "F3",
        "pass",
        { deliveryStatus: order.deliveryStatus },
        "Only applies to closed Orders",
        [order.orderNumber],
      );
    }
    const ok = closeSettlementComplete({
      settlementStatus: order.traderSettlementStatus,
      traderNetPayable: order.traderNetPayable,
    });
    return this.check(
      "F3",
      ok ? "pass" : "fail",
      {
        settlementStatus: order.traderSettlementStatus,
        traderNetPayable: money(order.traderNetPayable),
      },
      "settlement complete before close",
      [order.orderNumber],
    );
  }

  /** F4: a Trader-pays-fee Order has a matching service_charge receivable with the expected amounts and status. */
  private async f4(companyId: string, order: OrderSnapshot): Promise<OrderValidationCheck> {
    if (order.paymentCondition !== "customer_pays_cod_trader_pays_fee") {
      return this.check(
        "F4",
        "pass",
        { paymentCondition: order.paymentCondition },
        "Only applies when the Trader pays the fee",
        [order.orderNumber],
      );
    }
    const expectedDue =
      order.financialModelVersion === "trader_deduction_v1"
        ? calculateOrderFinancials({
            prospective: true,
            additionalFees: new Decimal(order.additionalFees),
            codAmount: new Decimal(order.codAmount),
            driverCost: new Decimal(order.driverCost),
            paymentCondition: order.paymentCondition,
            serviceFee: new Decimal(order.serviceFee),
            vatPolicy: {
              enabled: order.vatEnabled,
              priceMode: order.vatPriceMode,
              rate: new Decimal(order.vatRate),
            },
          }).traderReceivableDue
        : null;
    const result = await sql<{ number: string; due: string; collected: string; status: string }>`
      select r.receivable_number as number, r.original_amount_due::text as due,
             r.amount_collected::text as collected, r.status
        from trader_receivables r
       where r.company_id = ${companyId}::uuid and r.source_type = 'service_charge'
         and r.source_reference = ${order.orderNumber}
         and r.status not in ('reversed', 'cancelled')
       order by r.created_at
    `.execute(this.database);
    const active = result.rows;
    const needed = expectedDue === null || expectedDue.gt(0);
    if (!needed) {
      return this.check("F4", active.length === 0 ? "pass" : "fail", active, { receivables: 0 }, [
        order.orderNumber,
        ...active.map((row) => row.number),
      ]);
    }
    const row = active[0];
    const ok =
      active.length === 1 &&
      row !== undefined &&
      (expectedDue === null || sameMoney(row.due, expectedDue)) &&
      row.status === expectedReceivableStatus(row.collected, row.due);
    return this.check(
      "F4",
      ok ? "pass" : "fail",
      active.map((entry) => ({
        number: entry.number,
        due: money(entry.due),
        collected: money(entry.collected),
        status: entry.status,
      })),
      {
        receivables: 1,
        due: expectedDue === null ? null : money(expectedDue),
        status:
          row === undefined ? "outstanding" : expectedReceivableStatus(row.collected, row.due),
      },
      [order.orderNumber, ...active.map((entry) => entry.number)],
    );
  }

  // ---------------------------------------------------------------------------
  // Driver cash
  // ---------------------------------------------------------------------------

  /** D1: a reconciled Order's effective reconciliation line equals the customer amount due and is confirmed. */
  private async d1(companyId: string, order: OrderSnapshot): Promise<OrderValidationCheck> {
    if (order.driverReconciliationStatus !== "reconciled") {
      return this.check(
        "D1",
        "pass",
        { driverReconciliationStatus: order.driverReconciliationStatus },
        "Only applies to reconciled Orders",
        [order.orderNumber],
      );
    }
    const result = await sql<{ amount: string; status: string; number: string }>`
      select l.customer_collection_amount::text as amount, r.status, r.reconciliation_number as number
        from driver_reconciliation_orders l
        join driver_reconciliations r on r.company_id = l.company_id and r.id = l.reconciliation_id
       where l.company_id = ${companyId}::uuid and r.company_id = ${companyId}::uuid
         and l.order_id = ${order.id}::uuid
         and r.reversal_of_id is null
         and not exists (
           select 1 from driver_reconciliations reversal
            where reversal.company_id = ${companyId}::uuid
              and reversal.reversal_of_id = r.id and reversal.status = 'confirmed')
       order by r.created_at desc
    `.execute(this.database);
    const row = result.rows[0];
    const ok =
      result.rows.length === 1 &&
      row !== undefined &&
      row.status === "confirmed" &&
      sameMoney(row.amount, order.customerAmountDue);
    return this.check(
      "D1",
      ok ? "pass" : "fail",
      result.rows.map((entry) => ({
        number: entry.number,
        amount: money(entry.amount),
        status: entry.status,
      })),
      { amount: money(order.customerAmountDue), status: "confirmed", reconciliations: 1 },
      [order.orderNumber, ...result.rows.map((entry) => entry.number)],
    );
  }

  // ---------------------------------------------------------------------------
  // Accounting
  // ---------------------------------------------------------------------------

  private async accounting(
    companyId: string,
    order: OrderSnapshot,
    enabled: boolean,
  ): Promise<OrderValidationCheck[]> {
    const codes = ["A1", "A2", "A3", "A4", "A5"] as const;
    if (!enabled) {
      return codes.map((code) =>
        this.check(code, "info", "Accounting not enabled", "Accounting not enabled", [
          order.orderNumber,
        ]),
      );
    }
    const result = await sql<AccountingEventRow>`
      select e.id, e.event_type as "eventType", e.event_version as "eventVersion",
             e.processing_status as status, e.reversal_of_event_id as "reversalOfEventId",
             e.journal_id as "journalId", j.journal_number as "journalNumber",
             j.total_debit::text as "journalTotalDebit", e.source_reference as "sourceReference",
             e.effective_accounting_date::text as "effectiveAccountingDate", e.event_hash as "eventHash",
             e.correlation_id as "correlationId", e.actor_id as "actorId",
             e.operational_area as "operationalArea", e.created_at as "createdAt"
        from accounting_events e
        left join journal_entries j on j.company_id = e.company_id and j.id = e.journal_id
       where e.company_id = ${companyId}::uuid
         and e.source_entity_type = 'order' and e.source_entity_id = ${order.id}::uuid
       order by e.created_at, e.event_version
    `.execute(this.database);
    const events = result.rows;
    const recognitions = events.filter((event) => event.eventType === "order_delivered");
    const reversals = events.filter((event) => event.eventType === "order_recognition_reversed");
    const reversedIds = new Set(
      reversals
        .filter((event) => event.status === "posted")
        .map((event) => event.reversalOfEventId),
    );
    const effective = recognitions.filter(
      (event) => event.status === "posted" && !reversedIds.has(event.id),
    );
    const recognizable =
      RECOGNIZED_STATUSES.includes(order.deliveryStatus) &&
      new Decimal(order.customerAmountDue).gt(0);
    const journalRefs = (rows: readonly AccountingEventRow[]) =>
      rows.map((event) => event.journalNumber);

    const a1 = this.check(
      "A1",
      effective.length === (recognizable ? 1 : 0) ? "pass" : "fail",
      {
        effectiveRecognitions: effective.map((event) => ({
          version: event.eventVersion,
          journal: event.journalNumber,
        })),
      },
      { effectiveRecognitions: recognizable ? 1 : 0 },
      [order.orderNumber, ...journalRefs(effective)],
    );

    const a2 = await this.a2(companyId, order, effective);

    const stuck = events.filter((event) => STUCK_ACCOUNTING_STATUSES.includes(event.status));
    const a3 = this.check(
      "A3",
      stuck.length === 0 ? "pass" : "fail",
      stuck.map((event) => ({
        eventType: event.eventType,
        version: event.eventVersion,
        status: event.status,
      })),
      "no failed, retry-pending or blocked event",
      [order.orderNumber],
    );

    // A4: the latest recognition was reversed, the Order is recognisable again, and nothing later is posted.
    const latestRecognition = [...recognitions].sort((a, b) => b.eventVersion - a.eventVersion)[0];
    const latestReversed = latestRecognition !== undefined && reversedIds.has(latestRecognition.id);
    const gap = latestReversed && recognizable && effective.length === 0;
    const a4 = this.check(
      "A4",
      gap ? "fail" : "pass",
      {
        latestRecognitionVersion: latestRecognition?.eventVersion ?? null,
        latestRecognitionReversed: latestReversed,
        effectiveRecognitions: effective.length,
      },
      latestReversed && recognizable
        ? "a later posted recognition (next event_version)"
        : "no reversal gap",
      [
        order.orderNumber,
        ...journalRefs(recognitions),
        ...journalRefs(reversals.filter((event) => event.status === "posted")),
      ],
    );

    const journalState =
      effective.length > 0 ? "posted" : reversedIds.size > 0 ? "reversed" : "unposted";
    const a5 = this.check(
      "A5",
      order.accountingStatus === journalState ? "pass" : "info",
      order.accountingStatus,
      journalState,
      [order.orderNumber, ...journalRefs(effective)],
    );
    return [a1, a2, a3, a4, a5];
  }

  /**
   * A2: the effective recognition's stored components equal what the source
   * loader produces from the Order TODAY. A difference means the Order changed
   * after it was posted.
   */
  private async a2(
    companyId: string,
    order: OrderSnapshot,
    effective: readonly AccountingEventRow[],
  ): Promise<OrderValidationCheck> {
    const event = effective.length === 1 ? effective[0]! : undefined;
    if (event === undefined) {
      return this.check(
        "A2",
        "info",
        { effectiveRecognitions: effective.length },
        "exactly one effective recognition to compare",
        [order.orderNumber],
      );
    }
    const stored = await sql<{ componentType: string; entryIntent: string; amount: string }>`
      select c.component_type as "componentType", c.entry_intent as "entryIntent", c.amount::text as amount
        from accounting_event_components c
       where c.company_id = ${companyId}::uuid and c.accounting_event_id = ${event.id}::uuid
       order by c.component_number
    `.execute(this.database);
    let expectedComponents: { componentType: string; entryIntent: string; amount: string }[];
    try {
      const facts = await this.sources.load(this.database, {
        actorId: event.actorId,
        companyId,
        correlationId: event.correlationId,
        effectiveAccountingDate: event.effectiveAccountingDate,
        eventHash: event.eventHash,
        eventType: event.eventType as AccountingEventType,
        eventVersion: event.eventVersion,
        id: event.id,
        operationalArea: event.operationalArea,
        reversalOfEventId: event.reversalOfEventId,
        sourceEntityId: order.id,
        sourceEntityType: "order",
        sourceReference: event.sourceReference,
      });
      expectedComponents = facts.components.map((component) => ({
        componentType: component.componentType,
        entryIntent: component.entryIntent,
        amount: money(component.amount),
      }));
    } catch {
      // The loader refuses an Order it cannot recognise any more (for example
      // one that is no longer delivered). That is itself a mismatch.
      expectedComponents = [];
    }
    const normalise = (
      rows: readonly { componentType: string; entryIntent: string; amount: string }[],
    ) => rows.map((row) => `${row.componentType}|${row.entryIntent}|${money(row.amount)}`).sort();
    const storedKeys = normalise(stored.rows);
    const expectedKeys = normalise(expectedComponents);
    const componentsOk = storedKeys.length > 0 && storedKeys.join(",") === expectedKeys.join(",");
    const expectedDebit = expectedComponents
      .filter((component) => component.entryIntent === "debit")
      .reduce((sum, component) => sum.plus(component.amount), new Decimal(0));
    const journalOk =
      event.journalTotalDebit === null || sameMoney(event.journalTotalDebit, expectedDebit);
    return this.check(
      "A2",
      componentsOk && journalOk ? "pass" : "fail",
      {
        journal: event.journalNumber,
        totalDebit: event.journalTotalDebit === null ? null : money(event.journalTotalDebit),
        components: storedKeys,
      },
      { totalDebit: money(expectedDebit), components: expectedKeys },
      [order.orderNumber, event.journalNumber],
    );
  }

  // ---------------------------------------------------------------------------
  // Data-entry patterns (warnings only, never auto-fixed)
  // ---------------------------------------------------------------------------

  /** V1: COD 0 with an additional fee on a customer-pays Order -- the fee may be the goods value. */
  private v1(order: OrderSnapshot): OrderValidationCheck {
    const cod = new Decimal(order.codAmount);
    const additional = new Decimal(order.additionalFees);
    const applies =
      cod.isZero() && additional.gt(0) && order.paymentCondition === "customer_pays_cod_and_fee";
    const strong = applies && additional.gt(order.serviceFee);
    return this.check(
      "V1",
      applies ? "warning" : "pass",
      {
        codAmount: money(cod),
        additionalFees: money(additional),
        serviceFee: money(order.serviceFee),
        paymentCondition: order.paymentCondition,
      },
      { level: strong ? "strong" : applies ? "review" : "none" },
      [order.orderNumber],
      strong ? "strong" : undefined,
    );
  }

  /** V2: COD was edited from above 0 down to 0 and nothing was collected. */
  private async v2(companyId: string, order: OrderSnapshot): Promise<OrderValidationCheck> {
    const result = await sql<{ previous: string | null; next: string | null; occurredAt: Date }>`
      select e.previous_value #>> '{}' as previous, e.new_value #>> '{}' as next, e.occurred_at as "occurredAt"
        from order_events e
       where e.company_id = ${companyId}::uuid and e.order_id = ${order.id}::uuid
         and e.event_type = 'order.updated' and e.field_name = 'cod_amount'
       order by e.occurred_at
    `.execute(this.database);
    const numeric = (value: string | null) => {
      if (value === null) return null;
      try {
        return new Decimal(value);
      } catch {
        return null;
      }
    };
    const removals = result.rows.filter((row) => {
      const previous = numeric(row.previous);
      const next = numeric(row.next);
      return previous !== null && previous.gt(0) && next !== null && next.isZero();
    });
    const applies =
      removals.length > 0 &&
      new Decimal(order.codAmount).isZero() &&
      new Decimal(order.amountCollected).isZero();
    return this.check(
      "V2",
      applies ? "warning" : "pass",
      {
        codRemovals: removals.map((row) => ({
          from: row.previous,
          to: row.next,
          at: row.occurredAt,
        })),
        amountCollected: money(order.amountCollected),
      },
      "COD not removed before delivery without a collection",
      [order.orderNumber],
    );
  }
}
