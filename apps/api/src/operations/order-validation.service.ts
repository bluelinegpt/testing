import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { Decimal } from "decimal.js";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import { calculateOrderFinancials } from "./order-financial-model.js";
import { closeSettlementComplete } from "./order-close-eligibility.js";
import { effectiveSettlement } from "./effective-settlement-offsets.js";
import { expectedReceivableStatus } from "./trader-receivable-reconciliation.js";

export type ValidationSeverity = "pass" | "info" | "warning" | "fail";
export interface OrderValidationCheck {
  readonly code: string;
  readonly severity: ValidationSeverity;
  readonly titleKey: string;
  readonly stored: unknown;
  readonly expected: unknown;
  readonly refs: readonly string[];
}
export interface OrderValidationResult {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly referenceNumber: string | null;
  readonly version: number;
  readonly checks: readonly OrderValidationCheck[];
}

interface OrderSnapshot {
  id: string; orderNumber: string; referenceNumber: string | null; version: number;
  deliveryStatus: string; traderSettlementStatus: string; driverReconciliationStatus: string;
  assignedDriverId: string | null; deliveredAt: string | null; closedAt: string | null;
  codAmount: string; serviceFee: string; additionalFees: string; driverCost: string;
  paymentCondition: "customer_pays_cod_and_fee" | "customer_pays_cod_trader_pays_fee";
  customerAmountDue: string; traderGrossPayable: string; traderPaidServiceFee: string;
  amountCollected: string;
  traderDeductions: string; totalDeductions: string; traderNetPayable: string;
  companyRevenue: string; vatAmount: string; financialModelVersion: string | null;
  vatEnabled: boolean; vatRate: string; vatPriceMode: "inclusive" | "exclusive" | null;
  accountingStatus: string; traderId: string;
}

@Injectable()
export class OrderValidationService {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  public async validate(companyId: string, orderId: string, version: number): Promise<OrderValidationResult> {
    const order = await this.order(companyId, orderId, version);
    const checks: OrderValidationCheck[] = [];
    checks.push(await this.lifecycleHistory(companyId, order));
    checks.push(this.lifecycleTimestamps(order));
    checks.push(await this.assignment(companyId, order));
    checks.push(this.financialModel(order));
    checks.push(await this.settlement(companyId, order));
    checks.push(this.close(order));
    checks.push(await this.receivable(companyId, order));
    checks.push(await this.driverCash(companyId, order));
    checks.push(...await this.accounting(companyId, order));
    checks.push(await this.v1(order));
    checks.push(await this.v2(companyId, order));
    return { orderId: order.id, orderNumber: order.orderNumber, referenceNumber: order.referenceNumber, version: order.version, checks };
  }

  private async order(companyId: string, orderId: string, version: number): Promise<OrderSnapshot> {
    const result = await sql<OrderSnapshot>`
      select id, order_number as "orderNumber", reference_number as "referenceNumber", version,
        delivery_status as "deliveryStatus", trader_settlement_status as "traderSettlementStatus",
        driver_reconciliation_status as "driverReconciliationStatus", assigned_driver_id as "assignedDriverId",
        delivered_at as "deliveredAt", closed_at as "closedAt", cod_amount::text as "codAmount",
        service_fee::text as "serviceFee", coalesce(additional_fees,0)::text as "additionalFees",
        driver_cost::text as "driverCost", payment_condition as "paymentCondition",
        customer_amount_due::text as "customerAmountDue", trader_gross_payable::text as "traderGrossPayable",
        amount_collected::text as "amountCollected",
        trader_paid_service_fee::text as "traderPaidServiceFee", trader_deductions::text as "traderDeductions",
        total_deductions::text as "totalDeductions", trader_net_payable::text as "traderNetPayable",
        company_revenue::text as "companyRevenue", vat_amount::text as "vatAmount",
        financial_model_version as "financialModelVersion", coalesce(vat_enabled_snapshot,false) as "vatEnabled",
        coalesce(vat_rate_snapshot,0)::text as "vatRate", vat_price_mode_snapshot as "vatPriceMode",
        accounting_status as "accountingStatus", trader_id as "traderId"
      from orders where company_id=${companyId}::uuid and id=${orderId}::uuid and version=${version}
    `.execute(this.database);
    const row = result.rows[0];
    if (!row) throw new NotFoundException({ code: "order_changed_since_lookup", message: "Order no longer has the requested version." });
    return row;
  }

  private pass(code: string, stored: unknown, expected: unknown, refs: readonly string[], severity: ValidationSeverity = "pass"): OrderValidationCheck {
    return { code, severity, titleKey: `platform.orderValidation.${code}`, stored, expected, refs };
  }

  private async lifecycleHistory(companyId: string, order: OrderSnapshot): Promise<OrderValidationCheck> {
    const result = await sql<{ toStatus: string | null; eventStatus: string | null }>`
      select (select h.to_status from order_status_history h where h.company_id=${companyId}::uuid and h.order_id=${order.id}::uuid and h.status_dimension='delivery' order by h.occurred_at desc limit 1) as "toStatus",
        null::text as "eventStatus"
    `.execute(this.database);
    const row = result.rows[0]!;
    const ok = row.toStatus === order.deliveryStatus && (row.eventStatus === null || row.eventStatus === order.deliveryStatus);
    return this.pass("L1", { deliveryStatus: order.deliveryStatus, history: row.toStatus, event: row.eventStatus }, order.deliveryStatus, [order.orderNumber], ok ? "pass" : "fail");
  }

  private lifecycleTimestamps(order: OrderSnapshot): OrderValidationCheck {
    const ok = (order.deliveryStatus !== "delivered" && order.deliveryStatus !== "closed" || order.deliveredAt !== null) && (order.deliveryStatus === "closed" ? order.closedAt !== null : order.closedAt === null);
    return this.pass("L2", { deliveredAt: order.deliveredAt, closedAt: order.closedAt }, "delivered_at for delivered/closed; closed_at iff closed", [order.orderNumber], ok ? "pass" : "fail");
  }

  private async assignment(companyId: string, order: OrderSnapshot): Promise<OrderValidationCheck> {
    const result = await sql<{ driverId: string | null }>`select driver_id as "driverId" from order_assignments where company_id=${companyId}::uuid and order_id=${order.id}::uuid and ended_at is null order by assigned_at desc limit 1`.execute(this.database);
    const driverId = result.rows[0]?.driverId ?? null;
    return this.pass("L3", driverId, order.assignedDriverId, [order.orderNumber], driverId === order.assignedDriverId ? "pass" : "fail");
  }

  private financialModel(order: OrderSnapshot): OrderValidationCheck {
    const calculated = calculateOrderFinancials({ prospective: true, codAmount: new Decimal(order.codAmount), serviceFee: new Decimal(order.serviceFee), additionalFees: new Decimal(order.additionalFees), driverCost: new Decimal(order.driverCost), paymentCondition: order.paymentCondition, vatPolicy: { enabled: order.vatEnabled, rate: new Decimal(order.vatRate), priceMode: order.vatPriceMode } });
    const stored = { customerAmountDue: order.customerAmountDue, traderGrossPayable: order.traderGrossPayable, traderPaidServiceFee: order.traderPaidServiceFee, traderDeductions: order.traderDeductions, totalDeductions: order.totalDeductions, traderNetPayable: order.traderNetPayable, companyRevenue: order.companyRevenue, vatAmount: order.vatAmount };
    const expected = { customerAmountDue: calculated.customerAmountDue.toFixed(2), traderGrossPayable: new Decimal(order.codAmount).toFixed(2), traderPaidServiceFee: calculated.traderPaidServiceFee.toFixed(2), traderDeductions: calculated.traderDeductions.toFixed(2), totalDeductions: calculated.totalDeductions.toFixed(2), traderNetPayable: calculated.traderNetPayable.toFixed(2), companyRevenue: calculated.companyRevenue.toFixed(2), vatAmount: calculated.vatAmount.toFixed(2) };
    const ok = Object.keys(expected).every((key) => new Decimal(String(stored[key as keyof typeof stored])).eq(expected[key as keyof typeof expected]));
    return this.pass("F1", stored, expected, [order.orderNumber], ok ? "pass" : "fail");
  }

  private async settlement(companyId: string, order: OrderSnapshot): Promise<OrderValidationCheck> {
    const result = await sql<{ paid: string; count: number }>`select coalesce(sum(l.net_payable),0)::text as paid, count(distinct l.settlement_id)::int as count from trader_settlement_orders l join trader_settlements s on s.company_id=l.company_id and s.id=l.settlement_id where l.company_id=${companyId}::uuid and l.order_id=${order.id}::uuid and ${effectiveSettlement("s")}`.execute(this.database);
    const paid = new Decimal(result.rows[0]?.paid ?? "0");
    const expectedStatus = new Decimal(order.traderNetPayable).isZero() ? "not_eligible" : order.traderSettlementStatus;
    const ok = (new Decimal(order.traderNetPayable).isZero() ? order.traderSettlementStatus === "not_eligible" : order.traderSettlementStatus !== "not_eligible") && paid.lte(new Decimal(order.traderNetPayable));
    return this.pass("F2", { status: order.traderSettlementStatus, paid: paid.toFixed(2) }, { status: expectedStatus, outstanding: new Decimal(order.traderNetPayable).minus(paid).toFixed(2) }, [order.orderNumber], ok ? "pass" : "fail");
  }

  private close(order: OrderSnapshot): OrderValidationCheck {
    const ok = order.deliveryStatus !== "closed" || closeSettlementComplete({ settlementStatus: order.traderSettlementStatus, traderNetPayable: order.traderNetPayable });
    return this.pass("F3", order.traderSettlementStatus, "closeSettlementComplete", [order.orderNumber], ok ? "pass" : "fail");
  }

  private async receivable(companyId: string, order: OrderSnapshot): Promise<OrderValidationCheck> {
    if (order.paymentCondition !== "customer_pays_cod_trader_pays_fee") return this.pass("F4", "not applicable", "Trader-pays-fee only", [order.orderNumber]);
    const result = await sql<{ id: string; due: string; paid: string; status: string }>`select id, original_amount_due::text as due, amount_collected::text as paid, status from trader_receivables where company_id=${companyId}::uuid and source_type='service_charge' and source_reference=${order.orderNumber} limit 1`.execute(this.database);
    const row = result.rows[0];
    const ok = row !== undefined && row.status === expectedReceivableStatus(row.paid, row.due);
    return this.pass("F4", row ?? null, "matching service_charge receivable with expected status", [order.orderNumber, ...(row ? [row.id] : [])], ok ? "pass" : "fail");
  }

  private async driverCash(companyId: string, order: OrderSnapshot): Promise<OrderValidationCheck> {
    if (order.driverReconciliationStatus !== "reconciled") return this.pass("D1", "not reconciled", "No driver cash comparison required", [order.orderNumber]);
    const result = await sql<{ amount: string; status: string; number: string }>`select r.customer_collection_amount::text as amount, reconciliation.status, reconciliation.reconciliation_number as number from driver_reconciliation_orders r join driver_reconciliations reconciliation on reconciliation.company_id=r.company_id and reconciliation.id=r.reconciliation_id where r.company_id=${companyId}::uuid and r.order_id=${order.id}::uuid order by reconciliation.created_at desc limit 1`.execute(this.database);
    const row = result.rows[0]; const ok = row?.status === "confirmed" && row.amount === order.customerAmountDue;
    return this.pass("D1", row ?? null, { amount: order.customerAmountDue, status: "confirmed" }, [order.orderNumber, ...(row ? [row.number] : [])], ok ? "pass" : "fail");
  }

  private async accounting(companyId: string, order: OrderSnapshot): Promise<OrderValidationCheck[]> {
    const enabled = await sql<{ enabled: boolean }>`select accounting_capture_enabled(${companyId}::uuid) as enabled`.execute(this.database);
    if (!enabled.rows[0]?.enabled) return ["A1", "A2", "A3", "A4", "A5"].map((code) => this.pass(code, "Accounting not enabled", "Accounting not enabled", [order.orderNumber], "info"));
    const events = await sql<{ status: string; eventType: string; version: number; journalId: string | null; sourceReference: string | null }>`select processing_status as status,event_type as "eventType",event_version as version,journal_id as "journalId",source_reference as "sourceReference" from accounting_events where company_id=${companyId}::uuid and source_entity_id=${order.id}::uuid order by event_version`.execute(this.database);
    const recognition = events.rows.filter((event) => event.eventType === "order_delivered" && event.status === "posted");
    const reversed = events.rows.some((event) => event.eventType === "order_recognition_reversed" && event.status === "posted");
    const failed = events.rows.filter((event) => ["failed", "retry_pending", "blocked_configuration"].includes(event.status));
    return [
      this.pass("A1", recognition.length, new Decimal(order.customerAmountDue).isZero() ? "0" : "1 effective recognition", [order.orderNumber, ...recognition.flatMap((e) => e.journalId ? [e.journalId] : [])], recognition.length === (new Decimal(order.customerAmountDue).isZero() ? 0 : 1) ? "pass" : "fail"),
      this.pass("A2", recognition[recognition.length - 1]?.journalId ?? null, "OperationalSourceLoader.order() journal", [order.orderNumber], "info"),
      this.pass("A3", failed.map((e) => e.status), "no failed accounting event", [order.orderNumber], failed.length === 0 ? "pass" : "fail"),
      this.pass("A4", { reversed, recognition: recognition.length }, "a later recognition after reversal", [order.orderNumber], reversed && recognition.length === 0 ? "fail" : "pass"),
      this.pass("A5", order.accountingStatus, recognition.length > 0 ? "posted" : "unposted", [order.orderNumber], "info"),
    ];
  }

  private async v1(order: OrderSnapshot): Promise<OrderValidationCheck> {
    const applies = new Decimal(order.codAmount).isZero() && new Decimal(order.additionalFees).gt(0) && order.paymentCondition === "customer_pays_cod_and_fee";
    return this.pass("V1", { cod: order.codAmount, additionalFees: order.additionalFees, serviceFee: order.serviceFee }, "review additional fee as possible goods value", [order.orderNumber], applies ? "warning" : "pass");
  }

  private async v2(companyId: string, order: OrderSnapshot): Promise<OrderValidationCheck> {
    const result = await sql<{ previous: string | null }>`select previous_value->>'codAmount' as previous from order_events where company_id=${companyId}::uuid and order_id=${order.id}::uuid and event_type='order.updated' order by occurred_at desc limit 1`.execute(this.database);
    const applies = result.rows[0]?.previous !== null && result.rows[0]?.previous !== undefined && new Decimal(result.rows[0].previous).gt(0) && new Decimal(order.codAmount).isZero() && new Decimal(order.amountCollected).isZero();
    return this.pass("V2", result.rows[0]?.previous ?? null, "COD was not removed before delivery", [order.orderNumber], applies ? "warning" : "pass");
  }
}
