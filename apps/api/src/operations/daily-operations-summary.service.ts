import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { accountingXlsx } from "../accounting/accounting-xlsx.js";
import { BusinessDayService, type BusinessDayWindow } from "../company-configuration/business-day.service.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { Clock } from "../shared/time/clock.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import {
  buildDailyOperationsSummaryHtml,
  type ReportLanguage,
} from "./daily-operations-summary-html.js";
import type {
  DailyOperationsSummaryDateMode,
  DailyOperationsSummaryOrdersQueryDto,
  DailyOperationsSummaryQueryDto,
} from "./daily-operations-summary.dto.js";
import { DriverCollectionPdfService } from "./driver-collection-pdf.service.js";

/**
 * Daily Operations Summary — read-only management report.
 *
 * ===========================================================================
 * WHAT THIS ANSWERS, AND WHAT IT DELIBERATELY DOES NOT
 * ===========================================================================
 *
 * "How many Orders did each Driver deliver, how much delivery/service income
 * did the Company earn, what operating expenses were paid, and what is the
 * net operational result" -- for one or more dates, in the selected Date
 * Mode.
 *
 * This is NOT the Cashbook, the Trial Balance, a P&L, or Payment Position.
 * Two money flows are deliberately excluded everywhere in this file, for the
 * exact reason `daily-cash-activity.service.ts` documents at its own top:
 *
 *   - Driver COD collection is NOT income. It settles a receivable already
 *     recognised at delivery; counting it again here would double it.
 *   - Trader settlement is NOT an operating expense. It is the Company
 *     paying out money that always belonged to the Trader.
 *
 * Delivery Income = the Company's own service-fee/additional-fee revenue,
 * using the SAME formula already posted to Accounting for a delivered Order
 * (`operational-source.loader.ts`): `service_fee_net_amount +
 * additional_fees` on the newer financial model, or the legacy
 * `company_revenue` column on Orders never migrated to it. COD and Trader
 * payable never enter this figure, in either Date Mode.
 *
 * "Operationally reportable" = delivered work whose cash responsibility is
 * complete for the report date. Orders that require Driver cash use the
 * confirmed Driver Collection timestamp; Orders with no Driver cash required
 * use `delivered_at`. Trader settlement/payment is intentionally not a gate.
 *
 * ===========================================================================
 * DATE MODE
 * ===========================================================================
 *
 * `dateFrom`/`dateTo` mean one of two things, selected by `dateMode`:
 *
 *   business_day (default) - the Company Business Date, cutoff-shifted, via
 *     `BusinessDayService.window()` -- the same shared Calendar every other
 *     Business-Date report in this codebase uses.
 *   calendar_day - plain Company-local midnight-to-midnight, via
 *     `BusinessDayService.calendarWindow()` -- the SAME engine (effective-
 *     dated rule resolution, DST-safe local-instant arithmetic), just
 *     anchored at 00:00 instead of the configured cutoff. Never a second
 *     timezone implementation.
 *
 * Both resolve to the identical `BusinessDayWindow` shape, so every query
 * below reads only `window.startUtc`/`window.endUtc` and needs no branching
 * of its own -- the mode is decided once, in `resolveWindow()`.
 *
 * `window.spansRuleChange` is surfaced in the metadata rather than silently
 * ignored: a range that crosses a rule change is flagged, matching this
 * report's "audit-visible, never guessed" posture, though (like
 * `daily-cash-activity.service.ts`) filtering still uses the single resolved
 * `startUtc`/`endUtc` envelope.
 *
 * Every date-bearing row (expenses, drill-down Orders) carries BOTH its
 * Business Date and its Calendar Date, regardless of which mode selected the
 * dataset -- so a screen or drill-down can always explain why an instant
 * belongs to one on-screen date under one mode and a different date under
 * the other, per the manual regression case this feature exists to satisfy
 * (an Order delivered 11 Aug 00:09 is Business Date 10 Aug, Calendar Date
 * 11 Aug).
 */

export interface DriverDeliverySummaryRow {
  readonly deliveredOrders: number;
  readonly deliveryIncome: string;
  readonly driverCode: string;
  readonly driverId: string;
  readonly driverName: string;
  readonly driverType: "employee" | "outsourced";
}

export interface OperatingExpenseRow {
  readonly amount: string;
  /** The Company Business Date this payment belongs to -- computed via
   *  `BusinessDayService`, never a raw calendar cast of the payment
   *  timestamp. Always present, regardless of the active Date Mode. */
  readonly businessDate: string;
  /** The payment's own local calendar date, in Company local time -- NOT
   *  Business-Day-cutoff-shifted. Always present, regardless of the active
   *  Date Mode. */
  readonly calendarDate: string;
  readonly description: string;
  readonly payee: string | null;
  readonly reference: string;
  /** The exact source record `reference` identifies, for drill-down. */
  readonly sourceId: string;
  readonly type:
    | "driver_collection_expense"
    | "general_expense"
    | "outsourced_driver_fee"
    | "payroll";
}

export interface TraderPaymentRow {
  readonly amount: string;
  readonly businessDate: string;
  readonly calendarDate: string;
  readonly customerName: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly orderSerialNumber: string | null;
  readonly originalAmountDue: string;
  readonly paymentMethod: "bank_transfer" | "cash";
  readonly previouslyPaid: string;
  readonly reference: string;
  readonly referenceNumber: string | null;
  readonly settlementId: string;
  readonly settlementNumber: string;
  readonly traderName: string;
}

export interface TraderCollectionRow {
  readonly amount: string;
  readonly businessDate: string;
  readonly calendarDate: string;
  readonly collectionId: string;
  readonly collectionNumber: string;
  readonly paymentMethod: "bank_transfer" | "cash";
  readonly reference: string;
  readonly traderName: string;
}

export interface TraderReceivableDueRow {
  readonly amountCollected: string;
  readonly businessDate: string;
  readonly calendarDate: string;
  readonly createdAt: string;
  readonly orderSerialNumber: string | null;
  readonly originalAmountDue: string;
  readonly outstandingAmount: string;
  readonly reason: string;
  readonly receivableId: string;
  readonly receivableNumber: string;
  readonly sourceReference: string | null;
  readonly traderName: string;
}

export interface TraderPayableDueRow {
  readonly businessDate: string;
  readonly calendarDate: string;
  readonly customerName: string;
  readonly deliveredAt: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly orderSerialNumber: string | null;
  readonly originalAmountDue: string;
  readonly outstandingAmount: string;
  readonly previouslyPaid: string;
  readonly referenceNumber: string | null;
  readonly settlementStatus: string;
  readonly traderName: string;
}
export interface DriverOrderRow {
  readonly customerName: string;
  readonly deliveredAt: string;
  /** The Company Business Date the delivery belongs to. Always present,
   *  regardless of the active Date Mode. */
  readonly deliveryBusinessDate: string | null;
  /** The delivery's own local calendar date. Always present, regardless of
   *  the active Date Mode. */
  readonly deliveryCalendarDate: string | null;
  readonly deliveryIncome: string;
  readonly driverName: string;
  readonly id: string;
  readonly orderDate: string;
  readonly orderNumber: string;
  readonly referenceNumber: string | null;
  /** Null for Orders never migrated to the prospective financial model --
   *  the UI falls back to the Order Number alone, never invents a serial. */
  readonly serialNumber: string | null;
  readonly traderName: string;
}

export interface DailyOperationsSummaryReport {
  readonly dateMode: DailyOperationsSummaryDateMode;
  readonly driverSummary: readonly DriverDeliverySummaryRow[];
  readonly expenses: readonly OperatingExpenseRow[];
  readonly metadata: {
    readonly businessDayStart: string;
    readonly dateFrom: string;
    readonly dateTo: string;
    readonly displayEnd: string;
    readonly endUtc: string;
    readonly spansRuleChange: boolean;
    readonly startUtc: string;
    readonly timezone: string;
  };
  readonly netResult: string;
  readonly netStatus: "break_even" | "negative" | "positive";
  readonly includeTraderPayments: boolean;
  readonly includeTraderCollections: boolean;
  readonly includeTraderPayables: boolean;
  readonly includeTraderReceivables: boolean;
  readonly totalDeliveryIncome: string;
  readonly totalExpenses: string;
  readonly totalOrders: number;
  readonly totalTraderPayments: string;
  readonly totalTraderCollections: string;
  readonly totalTraderPayables: string;
  readonly totalTraderReceivables: string;
  readonly traderPayables: readonly TraderPayableDueRow[];
  readonly traderPayments: readonly TraderPaymentRow[];
  readonly traderCollections: readonly TraderCollectionRow[];
  readonly traderReceivables: readonly TraderReceivableDueRow[];
}

@Injectable()
export class DailyOperationsSummaryService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(BusinessDayService) private readonly businessDays: BusinessDayService,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(DriverCollectionPdfService) private readonly pdfRenderer: DriverCollectionPdfService,
    @Inject(Clock) private readonly clock: Clock,
  ) {}

  /**
   * "Right now", resolved in the requested Date Mode -- what the report's own
   * Today quick filter must resolve to, never the viewer's local calendar
   * date. Yesterday is one calendar day earlier in either mode: both
   * Business Dates and Calendar Dates are contiguous sequences by
   * construction, so no second lookup is needed.
   */
  public async currentDate(
    dateMode: DailyOperationsSummaryDateMode = "business_day",
  ): Promise<string> {
    this.assertPermission();
    const now = this.clock.now().toISOString();
    return dateMode === "calendar_day"
      ? this.businessDays.calendarDateOf(now)
      : this.businessDays.businessDateOf(now);
  }

  private assertPermission(): void {
    const identity = this.identities.current();
    if (
      !identity.permissions.has("reports.financial.view") &&
      !identity.permissions.has("reports.export") &&
      !identity.permissions.has("users_roles.manage")
    ) {
      throw new ApplicationException(
        "forbidden",
        "You do not have permission to view this report",
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /**
   * The one place a request's `dateFrom`/`dateTo`/`dateMode` become an actual
   * UTC window. Both modes return the identical `BusinessDayWindow` shape, so
   * every query in this file reads only `window.startUtc`/`window.endUtc`
   * and never branches on mode itself -- picking the engine is the only
   * mode-specific decision in the whole file.
   */
  private resolveWindow(
    dateMode: DailyOperationsSummaryDateMode | undefined,
    dateFrom: string,
    dateTo: string,
  ): Promise<BusinessDayWindow> {
    if (dateTo < dateFrom) {
      throw new ApplicationException(
        "daily_operations_summary_date_range_invalid",
        "Date To must not be before Date From",
        HttpStatus.BAD_REQUEST,
      );
    }
    return dateMode === "calendar_day"
      ? this.businessDays.calendarWindow(dateFrom, dateTo)
      : this.businessDays.window(dateFrom, dateTo);
  }

  public async report(query: DailyOperationsSummaryQueryDto): Promise<DailyOperationsSummaryReport> {
    this.assertPermission();
    const { companyId } = this.tenants.current();
    const dateMode = query.dateMode ?? "business_day";
    const window = await this.resolveWindow(dateMode, query.dateFrom, query.dateTo);
    const driverId = query.driverId ?? null;
    const driverType = query.driverType ?? null;

    const [driverRows, expenseRows, traderPaymentRows, traderCollectionRows, traderReceivableRows, traderPayableRows] = await Promise.all([
      sql<DriverDeliverySummaryRow>`
        with reportable_orders as (
          select o.*, coalesce(cash.confirmed_at, o.delivered_at) as report_activity_at
            from orders o
            left join lateral (
              select r.confirmed_at
                from driver_reconciliation_orders line
                join driver_reconciliations r
                  on r.id = line.reconciliation_id and r.company_id = line.company_id
               where line.company_id = o.company_id
                 and line.order_id = o.id
                 and r.status = 'confirmed'
                 and r.confirmed_at is not null
               order by r.confirmed_at desc
               limit 1
            ) cash on true
           where o.company_id = ${companyId}::uuid
             and o.delivered_at is not null
             and (
               (o.driver_reconciliation_status = 'reconciled' and cash.confirmed_at is not null)
               or o.driver_reconciliation_status = 'not_applicable'
             )
        )
        select d.id as "driverId", d.code as "driverCode", d.name_en as "driverName",
               d.driver_type as "driverType",
               count(*)::int as "deliveredOrders",
               coalesce(sum(
                 case when o.financial_model_version is null then o.company_revenue
                      else coalesce(o.service_fee_net_amount, 0) + coalesce(o.additional_fees, 0)
                 end
               ), 0)::text as "deliveryIncome"
          from reportable_orders o
          join drivers d on d.id = o.assigned_driver_id and d.company_id = o.company_id
         where o.report_activity_at >= ${window.startUtc}::timestamptz
           and o.report_activity_at < ${window.endUtc}::timestamptz
           and (${driverId}::uuid is null or o.assigned_driver_id = ${driverId}::uuid)
           and (${driverType}::text is null or d.driver_type = ${driverType}::text)
         group by d.id, d.code, d.name_en, d.driver_type
         order by lower(d.name_en)
      `.execute(this.database),
      sql<
        Omit<OperatingExpenseRow, "businessDate" | "calendarDate"> & { confirmedAt: string }
      >`
        with expenses as (
          -- General Expense payments, confirmed only. Description is the
          -- Category name (e.g. "Petrol / Fuel"), matching what the operator
          -- actually chose -- never a generic "General Expense" label.
          -- sourceId is the General Expense itself (ge.id), not the
          -- payment row: EXP-000003 must open the General Expense, per §6.
          select 'general_expense' as type, ge.id as "sourceId",
                 coalesce(ge.category_name_en_snapshot, 'General Expense') as description,
                 nullif(ge.payee_name_snapshot, '') as payee, ge.expense_number as reference,
                 (gp.cash_amount + gp.visa_amount)::text as amount,
                 gp.confirmed_at::text as "confirmedAt"
            from general_expense_payments gp
            join general_expenses ge on ge.id = gp.general_expense_id and ge.company_id = gp.company_id
           where gp.company_id = ${companyId}::uuid and gp.status = 'confirmed'
             and gp.confirmed_at >= ${window.startUtc}::timestamptz
             and gp.confirmed_at < ${window.endUtc}::timestamptz

          union all
          -- Expenses retained from a Driver's collection are genuine
          -- operating expenses even though they are not General Expense
          -- payments. They are paid economically when the confirmed
          -- reconciliation nets them from the COD handed over. Keep the
          -- reconciliation as their single source of truth so the report does
          -- not create or count a duplicate General Expense.
          select 'driver_collection_expense', r.id,
                 coalesce(et.display_name, 'Driver Collection Expense') ||
                   coalesce(' — ' || nullif(e.description, ''), ''),
                 coalesce(d.name_en, d.code), r.reconciliation_number,
                 e.amount::text, r.confirmed_at::text
            from driver_reconciliation_expenses e
            join driver_reconciliations r
              on r.id=e.reconciliation_id and r.company_id=e.company_id
            join drivers d on d.id=r.driver_id and d.company_id=r.company_id
            left join expense_types et on et.id=e.expense_type_id and et.company_id=e.company_id
           where e.company_id=${companyId}::uuid and r.status='confirmed'
             and r.confirmed_at is not null
             and r.confirmed_at>=${window.startUtc}::timestamptz
             and r.confirmed_at<${window.endUtc}::timestamptz
             and (${driverId}::uuid is null or r.driver_id=${driverId}::uuid)
             and (${driverType}::text is null or d.driver_type=${driverType}::text)

          union all
          -- Outsourced Driver fee payments, cash and bank alike -- unlike the
          -- Cash Activity report this is an operating EXPENSE view, not a
          -- till-cash view, so payment method does not gate inclusion.
          select 'outsourced_driver_fee', f.id,
                 'Outsourced Driver Fee — ' || coalesce(d.name_en, d.code),
                 coalesce(d.name_en, d.code), f.payment_number, f.amount_paid::text,
                 f.confirmed_at::text
            from outsourced_driver_fee_payments f
            left join drivers d on d.id = f.driver_id and d.company_id = f.company_id
           where f.company_id = ${companyId}::uuid and f.status = 'confirmed'
             and f.confirmed_at is not null
             and f.confirmed_at >= ${window.startUtc}::timestamptz
             and f.confirmed_at < ${window.endUtc}::timestamptz

          union all
          -- Payroll, split per Employee via the payment's own allocations so
          -- "Payroll — Ahmed" reads as a real name, not a lump header row.
          -- Reversed allocations are excluded; they paid nobody. sourceId
          -- is the payment header (p.id), which is what /payroll/payments/:id
          -- opens -- never the allocation row.
          select 'payroll', p.id,
                 'Payroll — ' || coalesce(e.name_en, 'Employee'),
                 coalesce(e.name_en, null), p.payment_number, a.allocated_amount::text,
                 p.confirmed_at::text
            from payroll_payments p
            join payroll_payment_allocations a
              on a.payroll_payment_id = p.id and a.company_id = p.company_id and a.reversed_at is null
            left join employees e on e.id = a.employee_id and e.company_id = a.company_id
           where p.company_id = ${companyId}::uuid and p.status = 'confirmed'
             and p.confirmed_at is not null
             and p.confirmed_at >= ${window.startUtc}::timestamptz
             and p.confirmed_at < ${window.endUtc}::timestamptz
        )
        select type, "sourceId", description, payee, reference, amount, "confirmedAt"
          from expenses
         order by "confirmedAt" desc
      `.execute(this.database),
      sql<
        Omit<TraderPaymentRow, "businessDate" | "calendarDate"> & {
          paymentAt: string;
          settlementBusinessDate: string;
        }
      >`
        select s.id as "settlementId", s.settlement_number as "settlementNumber",
               t.name_en as "traderName", p.payment_method as "paymentMethod",
               link.allocated_amount::text as amount, p.payment_at::text as "paymentAt",
               s.business_date::text as "settlementBusinessDate",
               coalesce(nullif(p.bank_reference, ''), s.settlement_number) as reference,
               o.id as "orderId", o.order_number as "orderNumber",
               o.serial_number as "orderSerialNumber", o.reference_number as "referenceNumber",
               o.customer_name as "customerName",
               o.trader_net_payable::text as "originalAmountDue",
               greatest(coalesce(o.trader_paid_amount, 0) - link.allocated_amount, 0)::text as "previouslyPaid"
          from trader_settlement_payments p
          join trader_settlements s on s.id = p.settlement_id and s.company_id = p.company_id
          join trader_settlement_orders link
            on link.settlement_id = s.id and link.company_id = s.company_id
          join orders o on o.id = link.order_id and o.company_id = link.company_id
          join traders t on t.id = s.trader_id and t.company_id = s.company_id
         where p.company_id = ${companyId}::uuid
           and s.status = 'confirmed'
           and (
             (
               ${dateMode}::text = 'business_day'
               and s.business_date >= ${query.dateFrom}::date
               and s.business_date <= ${query.dateTo}::date
             )
             or (
               ${dateMode}::text = 'calendar_day'
               and p.payment_at >= ${window.startUtc}::timestamptz
               and p.payment_at < ${window.endUtc}::timestamptz
             )
           )
         order by s.business_date desc, p.payment_at desc, s.settlement_number, o.serial_number nulls last, o.order_number
      `.execute(this.database),
      sql<
        Omit<TraderCollectionRow, "businessDate" | "calendarDate"> & {
          businessDate: string;
          confirmedAt: string;
        }
      >`
        select c.id as "collectionId", c.collection_number as "collectionNumber",
               t.name_en as "traderName", c.payment_method as "paymentMethod",
               c.amount_received::text as amount, c.confirmed_at::text as "confirmedAt",
               c.payment_date::text as "businessDate",
               coalesce(nullif(c.payment_reference, ''), c.collection_number) as reference
          from trader_collections c
          join traders t on t.id = c.trader_id and t.company_id = c.company_id
         where c.company_id = ${companyId}::uuid
           and c.status = 'confirmed'
           and (
             (
               ${dateMode}::text = 'business_day'
               and c.payment_date >= ${query.dateFrom}::date
               and c.payment_date <= ${query.dateTo}::date
             )
             or (
               ${dateMode}::text = 'calendar_day'
               and c.confirmed_at >= ${window.startUtc}::timestamptz
               and c.confirmed_at < ${window.endUtc}::timestamptz
             )
           )
         order by c.payment_date desc, c.confirmed_at desc, c.collection_number
      `.execute(this.database),
      sql<TraderReceivableDueRow>`
        select r.id as "receivableId", r.receivable_number as "receivableNumber",
               t.name_en as "traderName", r.business_date::text as "businessDate",
               r.source_reference as "sourceReference", o.serial_number as "orderSerialNumber",
               r.reason, r.original_amount_due::text as "originalAmountDue",
               r.amount_collected::text as "amountCollected",
               r.outstanding_amount::text as "outstandingAmount",
               r.created_at::text as "createdAt",
               r.created_at::date::text as "calendarDate"
          from trader_receivables r
          join traders t on t.id = r.trader_id and t.company_id = r.company_id
          left join orders o
            on o.company_id = r.company_id
           and r.source_type = 'service_charge'
           and o.order_number = r.source_reference
         where r.company_id = ${companyId}::uuid
           and r.status in ('outstanding', 'partially_collected')
           and r.outstanding_amount > 0
           and (
             (
               ${dateMode}::text = 'business_day'
               and r.business_date >= ${query.dateFrom}::date
               and r.business_date <= ${query.dateTo}::date
             )
             or (
               ${dateMode}::text = 'calendar_day'
               and r.created_at >= ${window.startUtc}::timestamptz
               and r.created_at < ${window.endUtc}::timestamptz
             )
           )
         order by r.business_date desc, r.receivable_number
      `.execute(this.database),
      sql<
        Omit<TraderPayableDueRow, "businessDate" | "calendarDate"> & {
          deliveredAt: string;
        }
      >`
        select o.id as "orderId", o.order_number as "orderNumber",
               o.serial_number as "orderSerialNumber", o.reference_number as "referenceNumber",
               t.name_en as "traderName", o.customer_name as "customerName",
               o.delivered_at::text as "deliveredAt",
               o.trader_net_payable::text as "originalAmountDue",
               o.trader_paid_amount::text as "previouslyPaid",
               o.trader_outstanding_balance::text as "outstandingAmount",
               o.trader_settlement_status as "settlementStatus"
          from orders o
          join traders t on t.id = o.trader_id and t.company_id = o.company_id
         where o.company_id = ${companyId}::uuid
           and o.delivery_status = 'delivered'
           and o.driver_reconciliation_status in ('reconciled', 'not_applicable')
           and o.trader_settlement_status in ('unsettled', 'partially_settled')
           and o.trader_outstanding_balance > 0
           and o.delivered_at >= ${window.startUtc}::timestamptz
           and o.delivered_at < ${window.endUtc}::timestamptz
         order by o.delivered_at asc, o.serial_number nulls last, o.order_number
      `.execute(this.database),
    ]);

    const driverSummary = driverRows.rows;
    // Business Date and Calendar Date are NEVER a raw cast of the payment
    // timestamp (that was the bug: a payment at 00:xx Business Date 10 Aug
    // displayed as "2026-08-11", its raw UTC calendar date). Both are
    // resolved through the same shared Calendar as everything else in this
    // report, in one bulk call each, keyed by the exact `confirmedAt` string
    // returned above -- and both are always computed, regardless of which
    // one selected this dataset, so the report can always show either.
    const confirmedTimestamps = expenseRows.rows.map((row) => row.confirmedAt);
    const [businessDatesByTimestamp, calendarDatesByTimestamp] = await Promise.all([
      this.businessDays.businessDatesFor(confirmedTimestamps),
      this.businessDays.calendarDatesFor(confirmedTimestamps),
    ]);
    const expenses = expenseRows.rows.map((row) => ({
      amount: row.amount,
      businessDate: businessDatesByTimestamp.get(row.confirmedAt) ?? row.confirmedAt.slice(0, 10),
      calendarDate: calendarDatesByTimestamp.get(row.confirmedAt) ?? row.confirmedAt.slice(0, 10),
      description: row.description,
      payee: row.payee,
      reference: row.reference,
      sourceId: row.sourceId,
      type: row.type,
    }));
    const traderPaymentTimestamps = traderPaymentRows.rows.map((row) => row.paymentAt);
    const traderPaymentCalendarDates =
      await this.businessDays.calendarDatesFor(traderPaymentTimestamps);
    const traderPayments = traderPaymentRows.rows.map((row) => ({
      amount: row.amount,
      businessDate: row.settlementBusinessDate,
      calendarDate: traderPaymentCalendarDates.get(row.paymentAt) ?? row.paymentAt.slice(0, 10),
      customerName: row.customerName,
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      orderSerialNumber: row.orderSerialNumber,
      originalAmountDue: row.originalAmountDue,
      paymentMethod: row.paymentMethod,
      previouslyPaid: row.previouslyPaid,
      reference: row.reference,
      referenceNumber: row.referenceNumber,
      settlementId: row.settlementId,
      settlementNumber: row.settlementNumber,
      traderName: row.traderName,
    }));
    const traderCollectionTimestamps = traderCollectionRows.rows.map((row) => row.confirmedAt);
    const traderCollectionCalendarDates =
      await this.businessDays.calendarDatesFor(traderCollectionTimestamps);
    const traderCollections = traderCollectionRows.rows.map((row) => ({
      amount: row.amount,
      businessDate: row.businessDate,
      calendarDate: traderCollectionCalendarDates.get(row.confirmedAt) ?? row.confirmedAt.slice(0, 10),
      collectionId: row.collectionId,
      collectionNumber: row.collectionNumber,
      paymentMethod: row.paymentMethod,
      reference: row.reference,
      traderName: row.traderName,
    }));
    const totalOrders = driverSummary.reduce((total, row) => total + row.deliveredOrders, 0);
    const totalDeliveryIncome = sumMoney(driverSummary.map((row) => row.deliveryIncome));
    const totalExpenses = sumMoney(expenses.map((row) => row.amount));
    const traderReceivableCreatedAt = traderReceivableRows.rows.map((row) => row.createdAt);
    const traderReceivableCalendarDates =
      await this.businessDays.calendarDatesFor(traderReceivableCreatedAt);
    const traderReceivables = traderReceivableRows.rows.map((row) => ({
      ...row,
      calendarDate: traderReceivableCalendarDates.get(row.createdAt) ?? row.createdAt.slice(0, 10),
    }));
    const traderPayableTimestamps = traderPayableRows.rows.map((row) => row.deliveredAt);
    const [traderPayableBusinessDates, traderPayableCalendarDates] = await Promise.all([
      this.businessDays.businessDatesFor(traderPayableTimestamps),
      this.businessDays.calendarDatesFor(traderPayableTimestamps),
    ]);
    const traderPayables = traderPayableRows.rows.map((row) => ({
      ...row,
      businessDate: traderPayableBusinessDates.get(row.deliveredAt) ?? row.deliveredAt.slice(0, 10),
      calendarDate: traderPayableCalendarDates.get(row.deliveredAt) ?? row.deliveredAt.slice(0, 10),
    }));
    const totalTraderPayments = sumMoney(traderPayments.map((row) => row.amount));
    const totalTraderCollections = sumMoney(traderCollections.map((row) => row.amount));
    const totalTraderPayables = sumMoney(traderPayables.map((row) => row.outstandingAmount));
    const totalTraderReceivables = sumMoney(traderReceivables.map((row) => row.outstandingAmount));
    const netResult = (Number(totalDeliveryIncome) - Number(totalExpenses)).toFixed(2);
    const netStatus =
      Number(netResult) > 0 ? "positive" : Number(netResult) < 0 ? "negative" : "break_even";

    return {
      dateMode,
      driverSummary,
      expenses,
      includeTraderPayments: isTruthyQueryFlag(query.includeTraderPayments),
      includeTraderCollections: isTruthyQueryFlag(query.includeTraderCollections),
      includeTraderPayables: isTruthyQueryFlag(query.includeTraderPayables),
      includeTraderReceivables: isTruthyQueryFlag(query.includeTraderReceivables),
      metadata: {
        businessDayStart: window.businessDayStart,
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
        displayEnd: window.displayEnd,
        endUtc: window.endUtc,
        spansRuleChange: window.spansRuleChange,
        startUtc: window.startUtc,
        timezone: window.timezone,
      },
      netResult,
      netStatus,
      totalDeliveryIncome,
      totalExpenses,
      totalOrders,
      totalTraderPayments,
      totalTraderCollections,
      totalTraderPayables,
      totalTraderReceivables,
      traderPayables,
      traderPayments,
      traderCollections,
      traderReceivables,
    };
  }

  /**
   * The Orders contributing to one Driver's row in `report()` -- opened from
   * "View Orders". `driverId` is required so this never loads every Order in
   * the range across every Driver, matching `report()`'s own
   * server-side-aggregation posture.
   *
   * The WHERE predicate below (company, `delivered_at is not null`, the same
   * window, the same driver) is IDENTICAL to the aggregate query in
   * `report()` on purpose: the sum of `deliveryIncome` here must equal that
   * Driver's `deliveryIncome` in the summary, and the count must equal
   * `deliveredOrders` -- proven by a DB test, not merely asserted here. This
   * requires `dateMode` to match the parent report's request; a caller that
   * changed mode between the two calls would see a drill-down that no longer
   * reconciles, which is why the frontend always passes the mode it last ran
   * the summary with.
   */
  public async driverOrders(
    query: DailyOperationsSummaryOrdersQueryDto,
  ): Promise<readonly DriverOrderRow[]> {
    this.assertPermission();
    const { companyId } = this.tenants.current();
    const dateMode = query.dateMode ?? "business_day";
    const window = await this.resolveWindow(dateMode, query.dateFrom, query.dateTo);
    const result = await sql<
      Omit<DriverOrderRow, "deliveryBusinessDate" | "deliveryCalendarDate">
    >`
      with reportable_orders as (
        select o.*, coalesce(cash.confirmed_at, o.delivered_at) as report_activity_at
          from orders o
          left join lateral (
            select r.confirmed_at
              from driver_reconciliation_orders line
              join driver_reconciliations r
                on r.id = line.reconciliation_id and r.company_id = line.company_id
             where line.company_id = o.company_id
               and line.order_id = o.id
               and r.status = 'confirmed'
               and r.confirmed_at is not null
             order by r.confirmed_at desc
             limit 1
          ) cash on true
         where o.company_id = ${companyId}::uuid
           and o.delivered_at is not null
           and (
             (o.driver_reconciliation_status = 'reconciled' and cash.confirmed_at is not null)
             or o.driver_reconciliation_status = 'not_applicable'
           )
      )
      select o.id, o.serial_number as "serialNumber", o.order_date::text as "orderDate",
             o.order_number as "orderNumber", o.reference_number as "referenceNumber",
             t.name_en as "traderName", o.customer_name as "customerName",
             d.name_en as "driverName", o.delivered_at::text as "deliveredAt",
             (case when o.financial_model_version is null then o.company_revenue
                   else coalesce(o.service_fee_net_amount, 0) + coalesce(o.additional_fees, 0)
              end)::text as "deliveryIncome"
        from reportable_orders o
        join drivers d on d.id = o.assigned_driver_id and d.company_id = o.company_id
        join traders t on t.id = o.trader_id and t.company_id = o.company_id
       where o.report_activity_at >= ${window.startUtc}::timestamptz
         and o.report_activity_at < ${window.endUtc}::timestamptz
         and o.assigned_driver_id = ${query.driverId}::uuid
       order by o.order_date, o.serial_number nulls last, o.order_number
    `.execute(this.database);

    const deliveredTimestamps = result.rows.map((row) => row.deliveredAt);
    const [deliveryBusinessDates, deliveryCalendarDates] = await Promise.all([
      this.businessDays.businessDatesFor(deliveredTimestamps),
      this.businessDays.calendarDatesFor(deliveredTimestamps),
    ]);
    return result.rows.map((row) => ({
      customerName: row.customerName,
      deliveredAt: row.deliveredAt,
      deliveryBusinessDate: deliveryBusinessDates.get(row.deliveredAt) ?? null,
      deliveryCalendarDate: deliveryCalendarDates.get(row.deliveredAt) ?? null,
      deliveryIncome: row.deliveryIncome,
      driverName: row.driverName,
      id: row.id,
      orderDate: row.orderDate,
      orderNumber: row.orderNumber,
      referenceNumber: row.referenceNumber,
      serialNumber: row.serialNumber,
      traderName: row.traderName,
    }));
  }

  /** True downloadable PDF, via the SAME shared Chromium renderer every other
   *  report PDF in this codebase already uses -- never a second PDF engine. */
  public async pdf(
    query: DailyOperationsSummaryQueryDto,
    language: ReportLanguage,
  ): Promise<{ readonly bytes: Buffer; readonly filename: string }> {
    const report = await this.report(query);
    const generatedAt = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      month: "2-digit",
      timeZone: "Asia/Dubai",
      year: "numeric",
    }).format(new Date());
    const html = buildDailyOperationsSummaryHtml(report, language, `${generatedAt} (UAE)`);
    const footerTemplate =
      language === "ar"
        ? `<div style="font-size:9px;width:100%;text-align:center;color:#666;direction:rtl;">الصفحة <span class="pageNumber"></span> من <span class="totalPages"></span></div>`
        : `<div style="font-size:9px;width:100%;text-align:center;color:#666;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;
    const bytes = await this.pdfRenderer.renderPdf(html, footerTemplate);
    return {
      bytes,
      filename: `Daily-Operations-Summary-${query.dateFrom}-to-${query.dateTo}.pdf`,
    };
  }

  /**
   * Single-sheet workbook, using the SAME hand-rolled XLSX writer every other
   * Accounting/Report export already uses (no new xlsx dependency, per §17).
   * `accountingXlsx` writes one metadata block plus one flat table, so this
   * MVP export covers the Driver Delivery Summary (the primary numeric table
   * an operator would pull into a spreadsheet) with the report totals AND
   * the active Date Mode folded into the metadata header. Expense Detail is
   * fully covered in the PDF; putting it in the same worksheet as a
   * genuinely separate table would need extending the shared writer to
   * support multiple sheets, which was out of scope for reusing existing
   * export infrastructure without modifying it (see the report's "remaining
   * limitations").
   */
  public async excel(
    query: DailyOperationsSummaryQueryDto,
    language: ReportLanguage = "en",
  ): Promise<{ readonly bytes: Buffer; readonly filename: string }> {
    const report = await this.report(query);
    const columns =
      language === "ar"
        ? ["المندوب", "رمز المندوب", "الطلبات المسلمة", "دخل التوصيل"]
        : ["Driver", "Driver Code", "Delivered Orders", "Delivery Income"];
    const rows: Readonly<Record<string, unknown>>[] = [
      ...report.driverSummary.map((row) =>
        Object.fromEntries([
          [columns[0]!, row.driverName],
          [columns[1]!, row.driverCode],
          [columns[2]!, row.deliveredOrders],
          [columns[3]!, Number(row.deliveryIncome)],
        ]),
      ),
      Object.fromEntries([
        [columns[0]!, language === "ar" ? "الإجمالي الكلي" : "GRAND TOTAL"],
        [columns[1]!, ""],
        [columns[2]!, report.totalOrders],
        [columns[3]!, Number(report.totalDeliveryIncome)],
      ]),
    ];
    const bytes = accountingXlsx(columns, rows, [
      [language === "ar" ? "التقرير" : "Report", language === "ar" ? "ملخص العمليات اليومية" : "Daily Operations Summary"],
      [language === "ar" ? "نمط التاريخ" : "Date Mode", report.dateMode === "calendar_day" ? (language === "ar" ? "يوم تقويمي" : "Calendar Day") : (language === "ar" ? "يوم عمل" : "Business Day")],
      [language === "ar" ? "الفترة" : "Period", `${query.dateFrom} ${language === "ar" ? "إلى" : "to"} ${query.dateTo}`],
      [language === "ar" ? "إجمالي دخل التوصيل" : "Total Delivery Income", Number(report.totalDeliveryIncome)],
      [language === "ar" ? "إجمالي المصروفات" : "Total Expenses", Number(report.totalExpenses)],
      [language === "ar" ? "صافي النتيجة" : "Net Result", Number(report.netResult)],
      [
        language === "ar" ? "الحالة" : "Status",
        language === "ar"
          ? { break_even: "تعادل", negative: "سلبي", positive: "إيجابي" }[report.netStatus]
          : report.netStatus,
      ],
    ]);
    return { bytes, filename: `Daily-Operations-Summary-${query.dateFrom}-to-${query.dateTo}.xlsx` };
  }
}

function isTruthyQueryFlag(value: unknown): boolean {
  return value === true || value === "true";
}

function sumMoney(values: readonly string[]): string {
  return values.reduce((total, value) => total + Number(value), 0).toFixed(2);
}






