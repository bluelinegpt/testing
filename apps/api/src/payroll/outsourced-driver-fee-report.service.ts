import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { CompanyProfileService } from "../company-profile/company-profile.service.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { DriverCollectionPdfService } from "../operations/driver-collection-pdf.service.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type {
  DailyDriverFeeAccrualReportQueryDto,
  OutstandingDriverFeesReportQueryDto,
  OutsourcedDriverFeeStatementQueryDto,
} from "./outsourced-driver-fee.dto.js";
import {
  buildDailyDriverFeeAccrualHtml,
  buildDriverEarningsStatementHtml,
  buildDriverFeePaymentReceiptHtml,
  buildOutstandingDriverFeesHtml,
  driverFeeReportFooter,
} from "./outsourced-driver-fee-report-html.js";
import type {
  DailyDriverFeeAccrualReportData,
  DriverEarningsStatementData,
  DriverFeePaymentReceiptData,
  DriverFeeReportLanguage,
  OutstandingDriverFeesReportData,
} from "./outsourced-driver-fee-report.types.js";
import { PayrollOperationSupport } from "./payroll-operation.support.js";

@Injectable()
export class OutsourcedDriverFeeReportService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(PayrollOperationSupport) private readonly support: PayrollOperationSupport,
    @Inject(CompanyProfileService) private readonly companyProfile: CompanyProfileService,
    @Inject(DriverCollectionPdfService) private readonly pdf: DriverCollectionPdfService,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
  ) {}

  public async statement(
    driverId: string,
    query: OutsourcedDriverFeeStatementQueryDto,
  ): Promise<DriverEarningsStatementData> {
    this.support.assertPermission("outsourced_driver_fees.view");
    const { companyId } = this.support.context();
    const range = this.statementRange(query);
    const driver = await this.driver(companyId, driverId);
    const opening = await this.outstandingAsOf(companyId, driverId, this.dayBefore(range.from));
    const lines = await sql<Record<string, unknown>>`
      select f.id, o.order_number as "orderNumber",o.serial_number::text as "serialNumber",
        f.delivery_date::text as "deliveryDate",f.accrual_business_date::text as "accrualBusinessDate",
        f.fee_rate_snapshot::text as "feeRate",f.earned_amount::text as "earnedAmount",
        coalesce(before_period.amount,0)::text as "paidBefore",
        coalesce(period_active.amount,0)::text as "paidDuringPeriod",
        coalesce(period_cash.amount,0)::text as "separatePaymentAmount",
        coalesce(period_offset.amount,0)::text as "collectionOffsetAmount",
        coalesce(period_reversed.amount,0)::text as "reversedAmount",
        case
          when f.status in ('reversed','recovery_required')
            and (f.reversed_at at time zone 'Asia/Dubai')::date<=${range.to}::date then 0
          else greatest(f.earned_amount-coalesce(as_of_paid.amount,0),0)
        end::text as "closingOutstanding",
        f.recovery_amount::text as "recoveryAmount",f.status as "accrualStatus",
        coalesce(refs.references,'') as "paymentReferences",
        coalesce(refs.reconciliations,'') as "collectionReferences"
      from outsourced_driver_fee_accruals f
      join orders o on o.id=f.order_id and o.company_id=f.company_id
      left join lateral (
        select sum(x.allocated_amount) as amount from outsourced_driver_fee_payment_allocations x
        join outsourced_driver_fee_payments p on p.id=x.payment_id and p.company_id=x.company_id
        where x.company_id=f.company_id and x.accrual_id=f.id and p.payment_date<${range.from}::date
          and (x.reversed_at is null or (x.reversed_at at time zone 'Asia/Dubai')::date>=${range.from}::date)
      ) before_period on true
      left join lateral (
        select sum(x.allocated_amount) as amount from outsourced_driver_fee_payment_allocations x
        join outsourced_driver_fee_payments p on p.id=x.payment_id and p.company_id=x.company_id
        where x.company_id=f.company_id and x.accrual_id=f.id and p.payment_date between ${range.from}::date and ${range.to}::date
          and (x.reversed_at is null or (x.reversed_at at time zone 'Asia/Dubai')::date>${range.to}::date)
      ) period_active on true
      left join lateral (
        select sum(x.allocated_amount) as amount from outsourced_driver_fee_payment_allocations x
        join outsourced_driver_fee_payments p on p.id=x.payment_id and p.company_id=x.company_id
        where x.company_id=f.company_id and x.accrual_id=f.id and p.payment_source='separate_payment'
          and p.payment_date between ${range.from}::date and ${range.to}::date
      ) period_cash on true
      left join lateral (
        select sum(x.allocated_amount) as amount from outsourced_driver_fee_payment_allocations x
        join outsourced_driver_fee_payments p on p.id=x.payment_id and p.company_id=x.company_id
        where x.company_id=f.company_id and x.accrual_id=f.id and p.payment_source='driver_collection'
          and p.payment_date between ${range.from}::date and ${range.to}::date
      ) period_offset on true
      left join lateral (
        select sum(x.allocated_amount) as amount from outsourced_driver_fee_payment_allocations x
        where x.company_id=f.company_id and x.accrual_id=f.id and x.reversed_at is not null
          and (x.reversed_at at time zone 'Asia/Dubai')::date between ${range.from}::date and ${range.to}::date
      ) period_reversed on true
      left join lateral (
        select sum(x.allocated_amount) as amount
          from outsourced_driver_fee_payment_allocations x
          join outsourced_driver_fee_payments p
            on p.id=x.payment_id and p.company_id=x.company_id
         where x.company_id=f.company_id
           and x.accrual_id=f.id
           and p.payment_date<=${range.to}::date
           and (
             x.reversed_at is null
             or (x.reversed_at at time zone 'Asia/Dubai')::date>${range.to}::date
           )
      ) as_of_paid on true
      left join lateral (
        select string_agg(distinct p.payment_number,', ') as references,
          string_agg(distinct r.reconciliation_number,', ') filter(where r.id is not null) as reconciliations
        from outsourced_driver_fee_payment_allocations x
        join outsourced_driver_fee_payments p on p.id=x.payment_id and p.company_id=x.company_id
        left join driver_reconciliations r on r.id=p.linked_driver_reconciliation_id and r.company_id=p.company_id
        where x.company_id=f.company_id and x.accrual_id=f.id
      ) refs on true
      where f.company_id=${companyId}::uuid and f.driver_id=${driverId}::uuid
        and f.accrual_business_date<=${range.to}::date
        and (${query.status ?? null}::text is null or f.status=${query.status ?? null})
      order by f.accrual_business_date,f.delivery_date,f.id
    `.execute(this.database);
    const periodLines = lines.rows.filter(
      (line) => String(line.accrualBusinessDate) >= range.from,
    );
    const earned = periodLines.reduce(
      (total, row) => total.plus(String(row.earnedAmount)),
      new Decimal(0),
    );
    const separate = lines.rows.reduce(
      (total, row) => total.plus(String(row.separatePaymentAmount)),
      new Decimal(0),
    );
    const offsets = lines.rows.reduce(
      (total, row) => total.plus(String(row.collectionOffsetAmount)),
      new Decimal(0),
    );
    const reversed = lines.rows.reduce(
      (total, row) => total.plus(String(row.reversedAmount)),
      new Decimal(0),
    );
    const recovery = periodLines.reduce(
      (total, row) => total.plus(String(row.recoveryAmount)),
      new Decimal(0),
    );
    const closing = await this.outstandingAsOf(companyId, driverId, range.to);
    const expectedClosing = opening.plus(earned).minus(separate).minus(offsets).plus(reversed);
    const warnings = expectedClosing.equals(closing)
      ? []
      : [
          `Stored closing balance ${closing.toFixed(2)} differs from event-based balance ${expectedClosing.toFixed(2)}. Stored history was preserved.`,
        ];
    return {
      company: await this.company(),
      driver,
      from: range.from,
      generatedAt: this.generatedAt(),
      lines: lines.rows,
      summary: {
        accrualCount: periodLines.length,
        closingOutstanding: closing.toFixed(2),
        collectionOffsets: offsets.toFixed(2),
        feesEarned: earned.toFixed(2),
        openingOutstanding: opening.toFixed(2),
        recoveryRequired: recovery.toFixed(2),
        reversedPayments: reversed.toFixed(2),
        separatePayments: separate.toFixed(2),
      },
      to: range.to,
      warnings,
    };
  }

  public async outstanding(
    query: OutstandingDriverFeesReportQueryDto,
  ): Promise<OutstandingDriverFeesReportData> {
    this.support.assertPermission("outsourced_driver_fees.view");
    const { companyId } = this.support.context();
    if (query.driverId !== undefined) await this.driver(companyId, query.driverId);
    const lines = await sql<Record<string, unknown>>`
      with scoped as (
        select d.id as driver_id,d.name_en as driver_name,d.code as driver_code,
          f.accrual_business_date,f.delivery_date,f.earned_amount,
          coalesce(p.active_paid,0) as active_paid,
          case
            when f.status in ('reversed','recovery_required')
              and (f.reversed_at at time zone 'Asia/Dubai')::date<=${query.asOf}::date then 0
            else greatest(f.earned_amount-coalesce(p.active_paid,0),0)
          end as outstanding,
          case
            when f.status='recovery_required'
              and (f.reversed_at at time zone 'Asia/Dubai')::date<=${query.asOf}::date
              then f.recovery_amount
            else 0
          end as recovery_amount,
          case
            when f.status='recovery_required'
              and (f.reversed_at at time zone 'Asia/Dubai')::date<=${query.asOf}::date
              then 'recovery_required'
            when f.status='reversed'
              and (f.reversed_at at time zone 'Asia/Dubai')::date<=${query.asOf}::date
              then 'reversed'
            when coalesce(p.active_paid,0)=0 then 'accrued'
            when coalesce(p.active_paid,0)>=f.earned_amount then 'paid'
            else 'partially_paid'
          end as as_of_status,
          p.last_payment_date,p.last_offset_date
        from outsourced_driver_fee_accruals f
        join drivers d on d.id=f.driver_id and d.company_id=f.company_id
        left join lateral (
          select sum(x.allocated_amount) filter(
                   where x.reversed_at is null
                      or (x.reversed_at at time zone 'Asia/Dubai')::date>${query.asOf}::date
                 ) as active_paid,
                 max(pay.payment_date) as last_payment_date,
                 max(pay.payment_date) filter(
                   where pay.payment_source='driver_collection'
                 ) as last_offset_date
            from outsourced_driver_fee_payment_allocations x
            join outsourced_driver_fee_payments pay
              on pay.id=x.payment_id and pay.company_id=x.company_id
           where x.company_id=f.company_id
             and x.accrual_id=f.id
             and pay.payment_date<=${query.asOf}::date
        ) p on true
        where f.company_id=${companyId}::uuid
          and f.accrual_business_date<=${query.asOf}::date
          and (${query.driverId ?? null}::uuid is null or f.driver_id=${query.driverId ?? null}::uuid)
      )
      select driver_id as "driverId",driver_name as "driverName",driver_code as "driverCode",
        sum(earned_amount)::text as "earnedAmount",sum(active_paid)::text as "activePaid",
        sum(outstanding)::text as outstanding,
        min(accrual_business_date) filter(where outstanding>0)::text as "oldestOutstandingDate",
        min(delivery_date) filter(where outstanding>0)::text as "oldestDeliveryDate",
        count(*) filter(where outstanding>0)::int as "unpaidOrderCount",
        count(*) filter(where as_of_status='partially_paid')::int as "partiallyPaidCount",
        coalesce(sum(recovery_amount),0)::text as "recoveryAmount",
        max(last_payment_date)::text as "lastPaymentDate",
        max(last_offset_date)::text as "lastCollectionOffsetDate"
      from scoped
      where as_of_status in ('accrued','partially_paid','recovery_required')
        and (${query.status ?? null}::text is null or as_of_status=${query.status ?? null})
        and (
          ${query.oldestUnpaidDate ?? null}::date is null
          or accrual_business_date<=${query.oldestUnpaidDate ?? null}::date
        )
      group by driver_id,driver_name,driver_code
      having sum(outstanding)>=${query.minimumOutstanding ?? 0}
      order by sum(outstanding) desc,
        min(accrual_business_date) filter(where outstanding>0),
        driver_name
    `.execute(this.database);
    const outstanding = lines.rows.reduce((sum, row) => sum.plus(String(row.outstanding)), new Decimal(0));
    const recovery = lines.rows.reduce((sum, row) => sum.plus(String(row.recoveryAmount)), new Decimal(0));
    const earned = lines.rows.reduce((sum, row) => sum.plus(String(row.earnedAmount)), new Decimal(0));
    const paid = lines.rows.reduce((sum, row) => sum.plus(String(row.activePaid)), new Decimal(0));
    const oldestOutstandingDate = lines.rows
      .map((row) => row.oldestOutstandingDate)
      .filter((value): value is string => typeof value === "string")
      .sort()[0] ?? null;
    return {
      asOf: query.asOf,
      company: await this.company(),
      generatedAt: this.generatedAt(),
      lines: lines.rows,
      summary: {
        driversWithOutstanding: lines.rows.filter((row) => Number(row.outstanding) > 0).length,
        oldestOutstandingDate,
        totalActivePaid: paid.toFixed(2),
        totalEarned: earned.toFixed(2),
        totalOutstanding: outstanding.toFixed(2),
        totalRecoveryRequired: recovery.toFixed(2),
        unpaidAccrualCount: lines.rows.reduce((sum, row) => sum + Number(row.unpaidOrderCount), 0),
      },
    };
  }

  public async dailyAccruals(
    query: DailyDriverFeeAccrualReportQueryDto,
  ): Promise<DailyDriverFeeAccrualReportData> {
    this.support.assertPermission("outsourced_driver_fees.view");
    this.assertRange(query.from, query.to);
    const { companyId } = this.support.context();
    if (query.driverId !== undefined) await this.driver(companyId, query.driverId);
    const lines = await sql<Record<string, unknown>>`
      select f.id,f.accrual_business_date::text as "accrualBusinessDate",
        f.delivery_date::text as "deliveryDate",d.name_en as "driverName",d.code as "driverCode",
        o.order_number as "orderNumber",o.serial_number::text as "serialNumber",
        f.fee_rate_snapshot::text as "feeRate",f.earned_amount::text as "earnedAmount",
        f.accrual_source as source,f.source_reference as "sourceReference",f.status,
        coalesce(cu.display_name,a.username) as "createdBy",f.created_at::text as "createdAt"
      from outsourced_driver_fee_accruals f
      join drivers d on d.id=f.driver_id and d.company_id=f.company_id
      join orders o on o.id=f.order_id and o.company_id=f.company_id
      left join accounts a on a.id=f.created_by_account_id and a.company_id=f.company_id
      left join company_users cu on cu.account_id=a.id and cu.company_id=a.company_id
      where f.company_id=${companyId}::uuid and f.accrual_business_date between ${query.from}::date and ${query.to}::date
        and (${query.driverId ?? null}::uuid is null or f.driver_id=${query.driverId ?? null}::uuid)
        and (${query.source ?? null}::text is null or f.accrual_source=${query.source ?? null})
        and (${query.status ?? null}::text is null or f.status=${query.status ?? null})
      order by f.accrual_business_date,f.delivery_date,f.id
    `.execute(this.database);
    const total = lines.rows.reduce((sum, row) => sum.plus(String(row.earnedAmount)), new Decimal(0));
    return {
      company: await this.company(),
      from: query.from,
      generatedAt: this.generatedAt(),
      lines: lines.rows,
      summary: {
        accrualCount: lines.rows.length,
        backfillCount: lines.rows.filter((row) => row.source === "authorized_backfill").length,
        deliveryCount: lines.rows.filter((row) => row.source === "delivery").length,
        driverCount: new Set(lines.rows.map((row) => row.driverCode)).size,
        reconciliationCount: lines.rows.filter((row) => row.source === "daily_reconciliation").length,
        totalEarned: total.toFixed(2),
      },
      to: query.to,
    };
  }

  public async receipt(paymentId: string): Promise<DriverFeePaymentReceiptData> {
    this.support.assertPermission("outsourced_driver_fees.view");
    const { companyId } = this.support.context();
    const payment = await sql<Record<string, unknown>>`
      select p.id,p.payment_number as "paymentNumber",d.name_en as "driverName",d.code as "driverCode",
        d.driver_type as "driverType",p.payment_date::text as "paymentDate",
        p.payment_method as "paymentMethod",p.payment_source as "paymentSource",
        p.amount_paid::text as "amountPaid",p.cash_voucher_reference as "voucherReference",
        p.external_reference as "externalReference",p.notes,p.status,
        coalesce(cu.display_name,a.username) as "paidBy",p.created_at::text as "createdAt",
        r.reconciliation_number as "linkedDriverCollection",p.reversal_reason as "reversalReason",
        coalesce(rcu.display_name,ra.username) as "reversedBy",p.reversed_at::text as "reversedAt",
        p.driver_id as "driverId"
      from outsourced_driver_fee_payments p
      join drivers d on d.id=p.driver_id and d.company_id=p.company_id
      join accounts a on a.id=p.paid_by_account_id and a.company_id=p.company_id
      left join company_users cu on cu.account_id=a.id and cu.company_id=a.company_id
      left join accounts ra on ra.id=p.reversed_by_account_id and ra.company_id=p.company_id
      left join company_users rcu on rcu.account_id=ra.id and rcu.company_id=ra.company_id
      left join driver_reconciliations r on r.id=p.linked_driver_reconciliation_id and r.company_id=p.company_id
      where p.id=${paymentId}::uuid and p.company_id=${companyId}::uuid
    `.execute(this.database);
    const header = payment.rows[0];
    if (header === undefined) {
      throw new ApplicationException("outsourced_driver_fee_payment_not_found", "The Driver fee payment was not found", HttpStatus.NOT_FOUND);
    }
    const allocations = await sql<Record<string, unknown>>`
      select x.id,o.order_number as "orderNumber",o.serial_number::text as "serialNumber",
        f.delivery_date::text as "deliveryDate",f.accrual_business_date::text as "accrualBusinessDate",
        f.earned_amount::text as "earnedAmount",
        coalesce((select sum(prior.allocated_amount) from outsourced_driver_fee_payment_allocations prior
          where prior.company_id=x.company_id and prior.accrual_id=x.accrual_id
            and (prior.created_at,prior.id)<(x.created_at,x.id)),0)::text as "paidBefore",
        x.allocated_amount::text as "paidThisPayment",
        greatest(f.earned_amount-coalesce((select sum(prior.allocated_amount)
          from outsourced_driver_fee_payment_allocations prior
          where prior.company_id=x.company_id and prior.accrual_id=x.accrual_id
            and (prior.created_at,prior.id)<=(x.created_at,x.id)),0),0)::text as "remainingOutstanding",
        f.status as "accrualStatus",case when x.reversed_at is null then 'active' else 'reversed' end as "allocationStatus",
        x.reversed_at::text as "allocationReversedAt"
      from outsourced_driver_fee_payment_allocations x
      join outsourced_driver_fee_accruals f on f.id=x.accrual_id and f.company_id=x.company_id
      join orders o on o.id=f.order_id and o.company_id=f.company_id
      where x.company_id=${companyId}::uuid and x.payment_id=${paymentId}::uuid
      order by x.allocation_order,x.id
    `.execute(this.database);
    const remaining = await sql<{ amount: string }>`
      select coalesce(sum(outstanding_amount),0)::text as amount from outsourced_driver_fee_accruals
      where company_id=${companyId}::uuid and driver_id=${String(header.driverId)}::uuid
        and status in ('accrued','partially_paid')
    `.execute(this.database);
    return {
      allocations: allocations.rows,
      company: await this.company(),
      generatedAt: this.generatedAt(),
      header,
      summary: {
        allocationCount: allocations.rows.length,
        notes: header.notes as string | null,
        remainingDriverOutstanding: remaining.rows[0]?.amount ?? "0.00",
        totalPaid: String(header.amountPaid),
      },
    };
  }

  public statementPdf(driverId: string, query: OutsourcedDriverFeeStatementQueryDto, language: DriverFeeReportLanguage, correlationId: string) {
    return this.render("outsourced_driver_fee.statement.pdf_generated",driverId,"driver",language,this.statement(driverId,query),buildDriverEarningsStatementHtml,(data) => `Driver-Earnings-${this.safe(data.driver.code)}-${data.from}-${data.to}.pdf`,correlationId);
  }
  public outstandingPdf(query: OutstandingDriverFeesReportQueryDto, language: DriverFeeReportLanguage, correlationId: string) {
    return this.render("outsourced_driver_fee.outstanding.pdf_generated",this.support.context().companyId,"company",language,this.outstanding(query),buildOutstandingDriverFeesHtml,(data) => `Outstanding-Driver-Fees-${data.asOf}.pdf`,correlationId);
  }
  public dailyAccrualsPdf(query: DailyDriverFeeAccrualReportQueryDto, language: DriverFeeReportLanguage, correlationId: string) {
    return this.render("outsourced_driver_fee.accrual_report.pdf_generated",this.support.context().companyId,"company",language,this.dailyAccruals(query),buildDailyDriverFeeAccrualHtml,(data) => `Daily-Driver-Fee-Accrual-${data.from}-${data.to}.pdf`,correlationId);
  }
  public receiptPdf(paymentId: string, language: DriverFeeReportLanguage, correlationId: string) {
    return this.render("outsourced_driver_fee.receipt.pdf_generated",paymentId,"outsourced_driver_fee_payment",language,this.receipt(paymentId),buildDriverFeePaymentReceiptHtml,(data) => `Driver-Fee-Payment-${this.safe(String(data.header.paymentNumber))}.pdf`,correlationId);
  }

  private async render<T>(
    action: string, subjectId: string, subjectType: string, language: DriverFeeReportLanguage,
    dataPromise: Promise<T>, html: (data: T, language: DriverFeeReportLanguage) => string,
    filename: (data: T) => string, correlationId: string,
  ) {
    this.support.assertPermission("reports.export");
    const { actorId, companyId } = this.support.context();
    const data = await dataPromise;
    const bytes = await this.pdf.renderPdf(html(data, language), driverFeeReportFooter(language));
    await this.history.audit(this.database,{action,actorId,after:{language},companyId,correlationId,subjectId,subjectType});
    return { bytes, filename: filename(data) };
  }

  private statementRange(query: OutsourcedDriverFeeStatementQueryDto) {
    if (query.month !== undefined) {
      const start = `${query.month}-01`;
      const [year, month] = query.month.split("-").map(Number);
      return { from: start, to: `${query.month}-${String(new Date(Date.UTC(year!,month!,0)).getUTCDate()).padStart(2,"0")}` };
    }
    if (query.from === undefined || query.to === undefined) {
      throw new ApplicationException("outsourced_driver_fee_report_range_required","Select a month or a From and To date",HttpStatus.BAD_REQUEST);
    }
    this.assertRange(query.from, query.to);
    return { from: query.from, to: query.to };
  }
  private assertRange(from: string, to: string) {
    const days = (Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/86_400_000;
    if (!Number.isFinite(days) || days < 0 || days > 366) throw new ApplicationException("outsourced_driver_fee_report_range_invalid","The report date range must be between zero and 366 days",HttpStatus.BAD_REQUEST);
  }
  private async driver(companyId: string, driverId: string) {
    const result = await sql<{ code: string; id: string; name: string }>`select id,code,name_en as name from drivers where id=${driverId}::uuid and company_id=${companyId}::uuid and driver_type='outsourced'`.execute(this.database);
    if (result.rows[0] === undefined) throw new ApplicationException("outsourced_driver_fee_driver_not_found","The Outsourced Driver was not found",HttpStatus.NOT_FOUND);
    return result.rows[0];
  }
  private outstandingAsOf(companyId: string, driverId: string, date: string) {
    return sql<{ amount: string }>`
      select coalesce(sum(greatest(f.earned_amount-coalesce(paid.amount,0),0)),0)::text as amount
      from outsourced_driver_fee_accruals f left join lateral (
        select sum(x.allocated_amount) as amount from outsourced_driver_fee_payment_allocations x
        join outsourced_driver_fee_payments p on p.id=x.payment_id and p.company_id=x.company_id
        where x.company_id=f.company_id and x.accrual_id=f.id and p.payment_date<=${date}::date
          and (x.reversed_at is null or (x.reversed_at at time zone 'Asia/Dubai')::date>${date}::date)
      ) paid on true where f.company_id=${companyId}::uuid and f.driver_id=${driverId}::uuid
        and f.accrual_business_date<=${date}::date
        and not(f.status in ('reversed','recovery_required') and (f.reversed_at at time zone 'Asia/Dubai')::date<=${date}::date)
    `.execute(this.database).then((result) => new Decimal(result.rows[0]?.amount ?? 0));
  }
  private dayBefore(date: string) { const value=new Date(`${date}T00:00:00Z`); value.setUTCDate(value.getUTCDate()-1); return value.toISOString().slice(0,10); }
  private async company() {
    const branding=await this.companyProfile.branding();
    const logoDataUri=branding.hasLogo?await this.companyProfile.logoContent().then((logo)=>`data:${logo.mediaType};base64,${logo.bytes.toString("base64")}`).catch(()=>null):null;
    return {logoDataUri,nameAr:branding.nameAr,nameEn:branding.nameEn,subtitleAr:branding.subtitleAr,subtitleEn:branding.subtitleEn,telephone:branding.telephone};
  }
  private generatedAt() { return `${new Intl.DateTimeFormat("en-GB",{dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Dubai"}).format(new Date())} (UAE)`; }
  private safe(value: string) { return value.replaceAll(/[^A-Za-z0-9-]/g,"")||"Driver"; }
}
