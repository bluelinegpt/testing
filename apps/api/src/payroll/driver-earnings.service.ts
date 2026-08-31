import { createHash, randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { BalanceEnforcementCoordinator } from "../accounting/balance-enforcement.coordinator.js";
import { PaymentFundingAccountService } from "../accounting/payment-funding-account.service.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type {
  CalculateEmployeeDriverEarningPeriodDto,
  DriverEarningsQueryDto,
  EmployeeMoneyPaymentDto,
  ReconcileEmployeeDriverEarningsDto,
  SaveOutsourcedCollectionRuleDto,
} from "./driver-earnings.dto.js";
import { PayrollOperationSupport } from "./payroll-operation.support.js";
import { EmployeeDeliveryEarningService } from "./employee-delivery-earning.service.js";
import { EmployeeCollectionEarningService } from "./employee-collection-earning.service.js";

type Database = Kysely<DatabaseSchema>;

interface EmployeeSource {
  readonly collectedOrderCount: number;
  readonly customer: string | null;
  readonly date: string;
  readonly gross: string;
  readonly id: string;
  readonly interimPaid: string;
  readonly linkedOrders: readonly Record<string, unknown>[];
  readonly orderId: string | null;
  readonly orderNumber: string | null;
  readonly paid: string;
  readonly payrollAllocated: string;
  readonly paymentStatus: string;
  readonly rate: string;
  readonly reference: string;
  readonly referenceNumber: string | null;
  readonly serialDate: string | null;
  readonly serialNumber: string | null;
  readonly sourceType: "collection" | "delivery";
  readonly trader: string | null;
}

@Injectable()
export class DriverEarningsService {
  public constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(PayrollOperationSupport) private readonly support: PayrollOperationSupport,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
    @Inject(PaymentFundingAccountService) private readonly funding: PaymentFundingAccountService,
    @Inject(BalanceEnforcementCoordinator)
    private readonly balances: BalanceEnforcementCoordinator,
    @Inject(EmployeeDeliveryEarningService)
    private readonly deliveryEarnings: EmployeeDeliveryEarningService,
    @Inject(EmployeeCollectionEarningService)
    private readonly collectionEarnings: EmployeeCollectionEarningService,
  ) {}

  public async previewPeriod(input: CalculateEmployeeDriverEarningPeriodDto) {
    this.support.assertPermission("payroll.pay");
    const { companyId } = this.support.context();
    return this.periodCalculation(this.database, companyId, input, false);
  }

  public async confirmPeriod(
    input: CalculateEmployeeDriverEarningPeriodDto,
    correlationId: string,
  ) {
    this.support.assertPermission("payroll.pay");
    const { actorId, companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      // No same-range or overlap guard here (approved product decision,
      // 2026-08-31): periods are incremental order-level captures, so a
      // second period over the same dates is legitimate -- it picks up only
      // orders no prior period claimed. Double-confirm protection comes from
      // the source rows themselves: the FOR UPDATE row locks inside
      // periodCalculation serialize concurrent confirms, the loser re-reads
      // the claimed orders as excluded, and an all-claimed calculation fails
      // with employee_driver_earning_period_empty below.
      const candidateOrders = await sql<{ id: string }>`select o.id from orders o
        join drivers d on d.id=o.assigned_driver_id and d.company_id=o.company_id
        where o.company_id=${companyId}::uuid and d.id=${input.driverId}::uuid
          and d.driver_type='employee' and o.delivered_at is not null
          and (o.delivered_at at time zone coalesce((select timezone from company_settings where company_id=o.company_id),'Asia/Dubai'))::date
            between ${input.dateFrom}::date and ${input.dateTo}::date
        order by o.delivered_at,o.id for update of o`.execute(transaction);
      for (const order of candidateOrders.rows)
        await this.deliveryEarnings.accrueForDelivery(transaction, order.id);
      const calculation = await this.periodCalculation(transaction, companyId, input, true);
      const inserted = await sql<{ id: string }>`insert into employee_driver_earning_periods(
        company_id,employee_id,driver_id,date_from,date_to,status,delivered_order_count,
        collected_order_count,delivery_earnings,collection_rate_snapshot,collection_earnings,
        total_earnings,calculated_by_account_id)
        values(${companyId}::uuid,${calculation.employeeId}::uuid,${input.driverId}::uuid,
          ${input.dateFrom}::date,${input.dateTo}::date,'locked',${calculation.deliveredOrders},
          ${calculation.collectedOrders},${calculation.deliveryEarnings},${calculation.collectionRate},
          ${calculation.collectionEarnings},${calculation.totalEarnings},${actorId}::uuid)
        returning id`.execute(transaction);
      const periodId = inserted.rows[0]!.id;
      for (const source of calculation.deliverySources) {
        await sql`insert into employee_driver_earning_period_delivery_sources(
          company_id,period_id,employee_order_earning_id,earning_amount_snapshot)
          values(${companyId}::uuid,${periodId}::uuid,${source.id}::uuid,${source.amount})`.execute(
          transaction,
        );
      }
      await sql`update employee_collect_order_earnings set earning_period_id=${periodId}::uuid
        where company_id=${companyId}::uuid and id in (${sql.join(
          calculation.collectionSources.length > 0
            ? calculation.collectionSources.map((source) => sql`${source.id}::uuid`)
            : [sql`null::uuid`],
        )})
          and earning_period_id is null`.execute(transaction);
      const result = { ...calculation, periodId, status: "locked" };
      await this.history.audit(transaction, {
        action: "employee_driver.earning_period.locked",
        actorId,
        after: result,
        companyId,
        correlationId,
        subjectId: periodId,
        subjectType: "employee_driver_earning_period",
      });
      return result;
    });
  }

  public async periods(driverId: string) {
    const permissions = this.support.permissions();
    if (!permissions.includes("payroll.view") && !permissions.includes("payroll.pay"))
      this.support.assertPermission("payroll.view");
    const { companyId } = this.support.context();
    const result =
      await sql`select p.id,p.date_from::text as "dateFrom",p.date_to::text as "dateTo",
      p.delivered_order_count as "deliveredOrders",p.collected_order_count as "collectedOrders",
      p.delivery_earnings::text as "deliveryEarnings",p.collection_rate_snapshot::text as "collectionRate",
      p.collection_earnings::text as "collectionEarnings",p.total_earnings::text as "totalEarnings",
      coalesce(a.interim_paid,0)::text as "interimPaid",coalesce(pa.payroll_paid,0)::text as "payrollPaid",
      greatest(p.total_earnings-coalesce(a.interim_paid,0)-coalesce(pa.payroll_paid,0),0)::text as outstanding,
      case when coalesce(a.interim_paid,0)+coalesce(pa.payroll_paid,0)=0 then 'unpaid'
        when coalesce(a.interim_paid,0)+coalesce(pa.payroll_paid,0)<p.total_earnings then 'partially_paid' else 'paid' end as status,
      p.calculated_at as "calculatedAt",p.locked_at as "lockedAt"
      ,coalesce(ds.sources,'[]'::jsonb) as "deliverySources",
      coalesce(csx.sources,'[]'::jsonb) as "collectionSources"
      from employee_driver_earning_periods p
      left join lateral(select sum(x.allocated_amount) as interim_paid
        from employee_driver_earning_period_payment_allocations x
        join employee_variable_earning_payments ep on ep.id=x.payment_id and ep.company_id=x.company_id
        where x.company_id=p.company_id and x.period_id=p.id and x.reversed_at is null and ep.status='confirmed') a on true
      left join lateral(select sum(x.allocated_amount) as payroll_paid
        from employee_driver_earning_period_payroll_allocations x
        join payroll_entries pe on pe.id=x.payroll_entry_id and pe.company_id=x.company_id
        where x.company_id=p.company_id and x.period_id=p.id and x.reversed_at is null
          and pe.approved_at is not null) pa on true
      left join lateral(select jsonb_agg(jsonb_build_object(
        'id',e.id,'orderId',o.id,'serialNumber',o.serial_number,'serialDate',o.order_date::text,
        'orderNumber',o.order_number,'referenceNumber',o.reference_number,
        'deliveryDate',(e.delivered_at at time zone coalesce(cs.timezone,'Asia/Dubai'))::date::text,
        'trader',t.name_en,'customer',o.customer_name,'driver',em.name_en,
        'rate',r.amount_per_order::text,'earned',s.earning_amount_snapshot::text)
        order by e.delivered_at,e.id) as sources
        from employee_driver_earning_period_delivery_sources s
        join employee_order_earnings e on e.id=s.employee_order_earning_id and e.company_id=s.company_id
        join orders o on o.id=e.order_id and o.company_id=e.company_id
        join employees em on em.id=e.employee_id and em.company_id=e.company_id
        left join employee_delivery_earning_rules r on r.id=e.rule_id and r.company_id=e.company_id
        left join traders t on t.id=o.trader_id and t.company_id=o.company_id
        left join company_settings cs on cs.company_id=e.company_id
        where s.company_id=p.company_id and s.period_id=p.id) ds on true
      left join lateral(select jsonb_agg(jsonb_build_object('id',x.id,'orderId',o.id,
        'serialNumber',o.serial_number,'serialDate',o.order_date::text,'orderNumber',o.order_number,
        'referenceNumber',o.reference_number,'customer',o.customer_name,
        'area',coalesce(a.name_en,''),
        'closeDate',(x.closed_at at time zone coalesce(cset.timezone,'Asia/Dubai'))::date::text,
        'rate',x.rate_snapshot::text,'earned',x.earned_amount::text) order by x.closed_at,x.id) sources
        from employee_collect_order_earnings x join orders o on o.id=x.order_id and o.company_id=x.company_id
        left join areas a on a.id=o.area_id and a.company_id=o.company_id
        left join company_settings cset on cset.company_id=x.company_id
        where x.company_id=p.company_id and x.earning_period_id=p.id) csx on true
      where p.company_id=${companyId}::uuid and p.driver_id=${driverId}::uuid and p.status<>'reversed'
      order by p.date_from desc,p.id`.execute(this.database);
    const items = result.rows;
    const latest = items[0] as { dateTo?: string } | undefined;
    return { items, nextAvailableStart: latest?.dateTo ? await this.nextDay(latest.dateTo) : null };
  }

  public async monthlyPayments(month: string, driverId?: string) {
    const permissions = this.support.permissions();
    if (!permissions.includes("payroll.view") && !permissions.includes("payroll.pay"))
      this.support.assertPermission("payroll.view");
    const { companyId } = this.support.context();
    const start = `${month}-01`;
    const result = await sql<Record<string, unknown>>`
      select d.id as "driverId",d.code as "driverCode",d.name_en as "driverName",
        d.employee_id as "employeeId",
        coalesce(pr.basic_salary,0)::text as "basicSalary",
        coalesce(pr.allowances,0)::text as allowances,
        coalesce(pr.delivery_earnings,0)::text as "deliveryEarnings",
        coalesce(pr.collection_earnings,0)::text as "collectionEarnings",
        coalesce(pr.other_earnings,0)::text as "otherEarnings",
        coalesce(pr.gross_earned,ep.earned,0)::text as "grossEarned",
        coalesce(pr.other_deductions,0)::text as "otherDeductions",
        coalesce(pr.advance_recovery,0)::text as "advanceRecovery",
        coalesce(pr.total_deductions,0)::text as "totalDeductions",
        coalesce(pr.net_salary,0)::text as "netSalary",
        coalesce(pr.salary_paid,0)::text as "salaryPaid",
        coalesce(pr.salary_outstanding,0)::text as "salaryOutstanding",
        coalesce(ep.earned,0)::text as "driverEarnings",
        coalesce(vp.paid,0)::text as "driverEarningsPaid",
        greatest(coalesce(ep.earned,0)-coalesce(vp.allocated_to_month,0)-coalesce(epp.payroll_paid,0),0)::text
          as "driverEarningsOutstanding",
        coalesce(sa.paid,0)::text as "advancePaid",
        coalesce(sab.outstanding,0)::text as "advanceOutstanding",
        (coalesce(pr.salary_paid,0)+coalesce(vp.paid,0)+coalesce(sa.paid,0))::text as "totalCashPaid",
        coalesce(pr.payment_details,'[]'::jsonb) as "salaryPayments",
        coalesce(vp.details,'[]'::jsonb) as "driverEarningPayments",
        coalesce(sa.details,'[]'::jsonb) as "salaryAdvances",
        coalesce(pr.deduction_details,'[]'::jsonb) as deductions
      from drivers d
      join employees e on e.id=d.employee_id and e.company_id=d.company_id
      left join lateral(
        select sum(l.basic_salary_snapshot) as basic_salary,sum(l.allowance_total) as allowances,
          sum(l.delivered_order_earnings) as delivery_earnings,
          sum(l.collection_earnings) as collection_earnings,
          sum(l.earning_adjustments_total) as other_earnings,sum(l.gross_earnings) as gross_earned,
          sum(l.deduction_adjustments_total+l.advances) as other_deductions,
          sum(l.salary_advance_recovery) as advance_recovery,
          sum(l.deduction_adjustments_total+l.advances+l.salary_advance_recovery) as total_deductions,
          sum(l.net_salary) as net_salary,sum(l.amount_paid) as salary_paid,
          sum(l.outstanding_amount) as salary_outstanding,
          (select jsonb_agg(jsonb_build_object('paymentNumber',p.payment_number,
              'paymentDate',p.payment_date::text,'amount',a.allocated_amount::text,'status',p.status)
              order by p.payment_date,p.payment_number)
             from payroll_payment_allocations a join payroll_payments p
               on p.id=a.payroll_payment_id and p.company_id=a.company_id
            where a.company_id=d.company_id and a.employee_id=d.employee_id
              and p.payment_date>=${start}::date and p.payment_date<(${start}::date+interval '1 month')
              and p.status<>'reversed' and a.reversed_at is null) as payment_details,
          (select jsonb_agg(jsonb_build_object('type',a.adjustment_type,'amount',a.amount::text,
              'reason',a.reason,'direction',a.direction) order by a.created_at)
             from payroll_adjustments a join payroll_entries le
               on le.id=a.payroll_line_id and le.company_id=a.company_id
             join payroll_periods pe on pe.id=le.payroll_period_id and pe.company_id=le.company_id
            where a.company_id=d.company_id and le.employee_id=d.employee_id
              and pe.payroll_month=${start}::date and a.status='active' and a.direction='deduction')
            as deduction_details
        from payroll_entries l join payroll_periods p
          on p.id=l.payroll_period_id and p.company_id=l.company_id
        where l.company_id=d.company_id and l.employee_id=d.employee_id
          and p.payroll_month=${start}::date and l.status<>'reversed'
      ) pr on true
      left join lateral(
        select sum(p.total_earnings) as earned from employee_driver_earning_periods p
        where p.company_id=d.company_id and p.employee_id=d.employee_id and p.status<>'reversed'
          and p.date_from>=${start}::date and p.date_from<(${start}::date+interval '1 month')
      ) ep on true
      left join lateral(
        select sum(p.amount_paid) as paid,
          (select sum(a.allocated_amount) from employee_variable_earning_payment_allocations a
            join employee_variable_earning_payments ap on ap.id=a.payment_id and ap.company_id=a.company_id
            where a.company_id=d.company_id and ap.employee_id=d.employee_id and ap.status='confirmed'
              and a.reversed_at is null
              and a.source_earning_date>=${start}::date
              and a.source_earning_date<(${start}::date+interval '1 month')) as allocated_to_month,
          jsonb_agg(jsonb_build_object('paymentNumber',p.payment_number,'paymentDate',p.payment_date::text,
            'amount',p.amount_paid::text,'status',p.status) order by p.payment_date,p.payment_number) as details
        from employee_variable_earning_payments p
        where p.company_id=d.company_id and p.employee_id=d.employee_id and p.status='confirmed'
          and p.payment_date>=${start}::date and p.payment_date<(${start}::date+interval '1 month')
      ) vp on true
      left join lateral(
        select sum(a.allocated_amount) as payroll_paid
        from employee_driver_earning_period_payroll_allocations a
        join payroll_entries l on l.id=a.payroll_entry_id and l.company_id=a.company_id
        join employee_driver_earning_periods p on p.id=a.period_id and p.company_id=a.company_id
        where a.company_id=d.company_id and p.employee_id=d.employee_id and a.reversed_at is null
          and l.approved_at is not null and p.date_from>=${start}::date
          and p.date_from<(${start}::date+interval '1 month')
      ) epp on true
      left join lateral(
        select sum(a.amount_paid) as paid,
          jsonb_agg(jsonb_build_object('advanceNumber',a.advance_number,'paymentDate',a.payment_date::text,
            'amount',a.amount_paid::text,'outstanding',a.outstanding_amount::text,'status',a.status)
            order by a.payment_date,a.advance_number) as details
        from employee_salary_advances a where a.company_id=d.company_id and a.employee_id=d.employee_id
          and a.status<>'reversed' and a.payment_date>=${start}::date
          and a.payment_date<(${start}::date+interval '1 month')
      ) sa on true
      left join lateral(
        select sum(a.outstanding_amount) as outstanding from employee_salary_advances a
        where a.company_id=d.company_id and a.employee_id=d.employee_id and a.status<>'reversed'
      ) sab on true
      where d.company_id=${companyId}::uuid and d.driver_type='employee' and d.account_status='active'
        and e.payroll_eligible and (${driverId ?? null}::uuid is null or d.id=${driverId ?? null}::uuid)
      order by d.code,d.id
    `.execute(this.database);
    const items = result.rows;
    const sum = (field: string) =>
      items
        .reduce((total, item) => total.plus(String(item[field] ?? "0")), new Decimal(0))
        .toFixed(2);
    return {
      month,
      items,
      totals: {
        advancePaid: sum("advancePaid"),
        driverEarningsPaid: sum("driverEarningsPaid"),
        salaryPaid: sum("salaryPaid"),
        totalCashPaid: sum("totalCashPaid"),
      },
    };
  }

  private async nextDay(value: string) {
    const result = await sql<{ value: string }>`select (${value}::date+1)::text as value`.execute(
      this.database,
    );
    return result.rows[0]!.value;
  }

  private async periodCalculation(
    database: Database,
    companyId: string,
    input: CalculateEmployeeDriverEarningPeriodDto,
    lock: boolean,
  ) {
    if (input.dateTo < input.dateFrom)
      throw new ApplicationException(
        "driver_earning_period_range_invalid",
        "Date To must be on or after Date From",
        HttpStatus.BAD_REQUEST,
      );

    // Same-day calculation is allowed (approved product decision,
    // 2026-08-31): each confirmed period claims its orders individually, so
    // deliveries that land after a confirmation are simply picked up by the
    // next calculation. Only genuinely future dates are rejected, measured
    // in the Company's own timezone -- not UTC, which flips to the next day
    // at 4 AM Gulf time.
    const todayRow = await sql<{ today: string }>`select (now() at time zone
      coalesce((select timezone from company_settings where company_id=${companyId}::uuid),'Asia/Dubai'))::date::text as today`.execute(
      database,
    );
    const today = todayRow.rows[0]!.today;
    if (input.dateTo > today)
      throw new ApplicationException(
        "driver_earning_period_future_date",
        `Earning periods cannot include future dates. Date To must be on or before today (${today}).`,
        HttpStatus.BAD_REQUEST,
      );
    const driver = await sql<{ employeeId: string }>`select d.employee_id as "employeeId"
      from drivers d join employees e on e.id=d.employee_id and e.company_id=d.company_id
      where d.id=${input.driverId}::uuid and d.company_id=${companyId}::uuid
        and d.driver_type='employee' and e.payroll_eligible`.execute(database);
    const employeeId = driver.rows[0]?.employeeId;
    if (!employeeId) this.notFound();
    // Overlapping date ranges are allowed by design: a period claims ORDERS
    // (delivery-source links / earning_period_id stamps), not dates, and the
    // queries below exclude every already-claimed order. The matching DB
    // exclusion constraint is dropped by migration
    // 20260955000000_allow_same_day_driver_earning_periods.
    const collectionRules = await sql<{
      amount: string;
      effectiveFrom: string;
      effectiveTo: string | null;
    }>`select amount::text as amount,effective_from::text as "effectiveFrom",effective_to::text as "effectiveTo"
      from employee_collection_earning_rules where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid
        and is_active and collection_payment_type='per_collected_order'
        and daterange(effective_from,coalesce(effective_to,'infinity'::date),'[)') && daterange(${input.dateFrom}::date,(${input.dateTo}::date+1),'[)')
      order by effective_from`.execute(database);
    const covering = collectionRules.rows.filter(
      (rule) =>
        rule.effectiveFrom <= input.dateFrom &&
        (!rule.effectiveTo || rule.effectiveTo > input.dateTo),
    );
    if (
      collectionRules.rows.length > 1 ||
      (collectionRules.rows.length === 1 && covering.length !== 1)
    )
      throw new ApplicationException(
        "employee_driver_collection_rate_boundary",
        "The period spans a Collection earning rate change. Split the earning period at the rate boundary",
        HttpStatus.CONFLICT,
      );
    const collectionRate = new Decimal(covering[0]?.amount ?? 0);
    const delivery = await sql<{
      amount: string;
      customer: string | null;
      deliveryDate: string;
      driver: string;
      id: string;
      orderId: string;
      orderNumber: string;
      rate: string;
      referenceNumber: string | null;
      serialDate: string;
      serialNumber: string | null;
      trader: string | null;
    }>`select e.id,e.applied_amount::text as amount,o.id as "orderId",o.order_number as "orderNumber",
      o.serial_number as "serialNumber",o.order_date::text as "serialDate",
      o.reference_number as "referenceNumber",
      (e.delivered_at at time zone coalesce(cs.timezone,'Asia/Dubai'))::date::text as "deliveryDate",
      t.name_en as trader,o.customer_name as customer,em.name_en as driver,
      r.amount_per_order::text as rate
      from employee_order_earnings e left join company_settings cs on cs.company_id=e.company_id
      join orders o on o.id=e.order_id and o.company_id=e.company_id
      join employees em on em.id=e.employee_id and em.company_id=e.company_id
      left join traders t on t.id=o.trader_id and t.company_id=o.company_id
      join employee_delivery_earning_rules r on r.id=e.rule_id and r.company_id=e.company_id
      where e.company_id=${companyId}::uuid and e.employee_id=${employeeId}::uuid
        and (e.delivered_at at time zone coalesce(cs.timezone,'Asia/Dubai'))::date between ${input.dateFrom}::date and ${input.dateTo}::date
        and not exists(select 1 from employee_driver_earning_period_delivery_sources s where s.company_id=e.company_id and s.employee_order_earning_id=e.id)
      order by e.delivered_at,e.id ${lock ? sql`for update of e` : sql``}`.execute(database);
    const deliveryAmount = delivery.rows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
    const collectionSources = await sql<{
      id: string;
      orderId: string;
      serialNumber: string | null;
      serialDate: string;
      orderNumber: string;
      referenceNumber: string | null;
      customer: string;
      area: string;
      closeDate: string;
      rate: string;
      amount: string;
    }>`select x.id,o.id as "orderId",
      o.serial_number as "serialNumber",o.order_date::text as "serialDate",o.order_number as "orderNumber",
      o.reference_number as "referenceNumber",o.customer_name as customer,
      coalesce(a.name_en,'') as area,
      (x.closed_at at time zone coalesce(cs.timezone,'Asia/Dubai'))::date::text as "closeDate",
      x.rate_snapshot::text as rate,x.earned_amount::text amount
      from employee_collect_order_earnings x join orders o on o.id=x.order_id and o.company_id=x.company_id
      left join areas a on a.id=o.area_id and a.company_id=o.company_id
      left join company_settings cs on cs.company_id=x.company_id
      where x.company_id=${companyId}::uuid and x.employee_id=${employeeId}::uuid and x.earning_period_id is null
        -- Excludes anything Payroll's own calculation already claimed directly
        -- (resolveCollectOrderEarnings), so this preview/lock can never double
        -- up with money a Calculate/Recalculate already picked up raw.
        and x.payroll_period_id is null
        and (x.closed_at at time zone coalesce(cs.timezone,'Asia/Dubai'))::date between ${input.dateFrom}::date and ${input.dateTo}::date
      order by x.closed_at,x.id ${lock ? sql`for update of x` : sql``}`.execute(database);
    const collectionAmount = collectionSources.rows.reduce(
      (sum, row) => sum.plus(row.amount),
      new Decimal(0),
    );
    if (deliveryAmount.plus(collectionAmount).lte(0))
      throw new ApplicationException(
        "employee_driver_earning_period_empty",
        "No payable Driver earnings exist for this period",
        HttpStatus.CONFLICT,
      );
    const last = await sql<{
      dateFrom: string;
      dateTo: string;
      nextStart: string;
    }>`select date_from::text as "dateFrom",date_to::text as "dateTo",(date_to+1)::text as "nextStart"
      from employee_driver_earning_periods where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid and status<>'reversed'
      order by date_to desc limit 1`.execute(database);
    return {
      collectedOrders: collectionSources.rows.length,
      collectionEarnings: collectionAmount.toFixed(2),
      collectionRate: collectionRate.toFixed(2),
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      deliveredOrders: delivery.rows.length,
      deliveryEarnings: deliveryAmount.toFixed(2),
      deliverySources: delivery.rows,
      collectionSources: collectionSources.rows,
      employeeId,
      lastPeriod: last.rows[0] ?? null,
      nextAvailableStart: last.rows[0]?.nextStart ?? null,
      totalEarnings: deliveryAmount.plus(collectionAmount).toFixed(2),
    };
  }

  public async reconcile(input: ReconcileEmployeeDriverEarningsDto, correlationId: string) {
    this.support.assertPermission("payroll.pay");
    if (input.dateTo < input.dateFrom)
      throw new ApplicationException(
        "driver_earnings_range_invalid",
        "Date To must be on or after Date From",
        HttpStatus.BAD_REQUEST,
      );
    const { actorId, companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const driver = await sql<{
        employeeId: string;
      }>`select d.employee_id as "employeeId" from drivers d join employees e on e.id=d.employee_id and e.company_id=d.company_id
        where d.id=${input.driverId}::uuid and d.company_id=${companyId}::uuid and d.driver_type='employee' and e.payroll_eligible`.execute(
        transaction,
      );
      const employeeId = driver.rows[0]?.employeeId;
      if (!employeeId) this.notFound();
      const orders = await sql<{
        id: string;
      }>`select o.id from orders o where o.company_id=${companyId}::uuid and o.assigned_driver_id=${input.driverId}::uuid
        and o.delivered_at is not null and (o.delivered_at at time zone coalesce((select timezone from company_settings where company_id=o.company_id),'Asia/Dubai'))::date between ${input.dateFrom}::date and ${input.dateTo}::date
        order by o.delivered_at,o.id`.execute(transaction);
      let deliveryCreated = 0;
      for (const order of orders.rows) {
        const before =
          await sql`select 1 from employee_order_earnings where company_id=${companyId}::uuid and order_id=${order.id}::uuid and employee_id=${employeeId}::uuid`.execute(
            transaction,
          );
        await this.deliveryEarnings.accrueForDelivery(transaction, order.id);
        if (before.rows.length === 0) {
          const after =
            await sql`select 1 from employee_order_earnings where company_id=${companyId}::uuid and order_id=${order.id}::uuid and employee_id=${employeeId}::uuid`.execute(
              transaction,
            );
          if (after.rows.length > 0) deliveryCreated++;
        }
      }
      const reconciliations = await sql<{
        businessDate: string;
        confirmedAt: string;
        id: string;
        orderIds: { id: string; orderNumber: string }[];
      }>`select r.id,r.business_date::text as "businessDate",r.confirmed_at::text as "confirmedAt",
        coalesce(jsonb_agg(distinct jsonb_build_object('id',o.id,'orderNumber',o.order_number)) filter(where o.id is not null),'[]') as "orderIds"
        from driver_reconciliations r left join driver_reconciliation_orders ro on ro.reconciliation_id=r.id and ro.company_id=r.company_id left join orders o on o.id=ro.order_id and o.company_id=ro.company_id
        where r.company_id=${companyId}::uuid and r.driver_id=${input.driverId}::uuid and r.status='confirmed' and r.business_date between ${input.dateFrom}::date and ${input.dateTo}::date
        group by r.id order by r.business_date,r.id`.execute(transaction);
      let collectionCreated = 0,
        ambiguousCollections = 0;
      for (const rec of reconciliations.rows) {
        const exists = await sql<{
          count: number;
          counts: boolean;
        }>`select counts_for_collection_earning as counts,collected_order_count as count from employee_driver_collection_facts where company_id=${companyId}::uuid and reconciliation_id=${rec.id}::uuid and employee_id=${employeeId}::uuid`.execute(
          transaction,
        );
        if (exists.rows.length) {
          if (!exists.rows[0]!.counts || exists.rows[0]!.count === 0) ambiguousCollections++;
          continue;
        }
        if (rec.orderIds.length === 0) {
          ambiguousCollections++;
          continue;
        }
        const rule =
          await sql`select 1 from employee_collection_earning_rules where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid and is_active and collection_payment_type='per_collected_order' and effective_from<=${rec.businessDate}::date and (effective_to is null or ${rec.businessDate}::date<effective_to)`.execute(
            transaction,
          );
        if (!rule.rows.length) continue;
        await this.collectionEarnings.captureForConfirmedCollection(
          transaction,
          {
            businessDate: rec.businessDate,
            confirmedAt: rec.confirmedAt,
            countsForCollectionEarning: true,
            driverId: input.driverId,
            orderIds: rec.orderIds,
            reconciliationId: rec.id,
          },
          actorId,
        );
        collectionCreated++;
      }
      const result = {
        ambiguousCollections,
        collectionCreated,
        dateFrom: input.dateFrom,
        dateTo: input.dateTo,
        deliveryCreated,
        driverId: input.driverId,
        employeeId,
      };
      await this.history.audit(transaction, {
        action: "employee_driver.earnings.reconciled",
        actorId,
        after: result,
        companyId,
        correlationId,
        subjectId: employeeId,
        subjectType: "employee",
      });
      return result;
    });
  }

  public async summary(query: DriverEarningsQueryDto) {
    const permissions = this.support.permissions();
    if (
      !permissions.some((permission) =>
        ["payroll.view", "outsourced_driver_fees.view", "users_roles.manage"].includes(permission),
      )
    ) {
      this.support.assertPermission("payroll.view");
    }
    const { companyId } = this.support.context();
    if (query.driverId === undefined) return this.driverDirectory(query);
    const driver = await sql<{
      driverCode: string;
      driverId: string;
      driverName: string;
      driverType: string;
      employeeId: string | null;
    }>`
      select d.id as "driverId",d.code as "driverCode",d.name_en as "driverName",
             d.driver_type as "driverType",d.employee_id as "employeeId"
        from drivers d where d.id=${query.driverId}::uuid and d.company_id=${companyId}::uuid
    `.execute(this.database);
    const row = driver.rows[0];
    if (row === undefined) this.notFound();
    if (row.driverType === "outsourced") {
      const totals = await sql<{
        collection: string;
        delivery: string;
        earned: string;
        paid: string;
        outstanding: string;
      }>`
        select coalesce(sum(earned_amount) filter(where earning_type='delivery' and status<>'reversed'),0)::text as delivery,
               coalesce(sum(earned_amount) filter(where earning_type='collection' and status<>'reversed'),0)::text as collection,
               coalesce(sum(earned_amount) filter(where status<>'reversed'),0)::text as earned,
               coalesce(sum(paid_amount) filter(where status<>'reversed'),0)::text as paid,
               coalesce(sum(outstanding_amount) filter(where status<>'reversed'),0)::text as outstanding
          from outsourced_driver_fee_accruals
         where company_id=${companyId}::uuid and driver_id=${row.driverId}::uuid
           and (${query.dateFrom ?? null}::date is null or accrual_business_date>=${query.dateFrom ?? null}::date)
           and (${query.dateTo ?? null}::date is null or accrual_business_date<=${query.dateTo ?? null}::date)
      `.execute(this.database);
      const sources = await sql<Record<string, unknown>>`select a.id,a.earning_type as "sourceType",
        a.accrual_business_date::text as date,a.order_id as "orderId",o.order_number as "orderNumber",
        o.serial_number as "serialNumber",o.order_date::text as "serialDate",
        o.reference_number as "referenceNumber",o.customer_name as customer,t.name_en as trader,
        a.fee_rate_snapshot::text as rate,a.unit_count as "unitCount",a.earned_amount::text as gross,
        a.paid_amount::text as paid,a.outstanding_amount::text as outstanding,a.status as "paymentStatus",
        coalesce(jsonb_agg(distinct jsonb_build_object('paymentId',p.id,'paymentNumber',p.payment_number,
          'paymentDate',p.payment_date::text,'reference',coalesce(p.external_reference,p.cash_voucher_reference),
          'amount',pa.allocated_amount::text,'status',p.status)) filter(where p.id is not null),'[]') as allocations
        from outsourced_driver_fee_accruals a left join orders o on o.id=a.order_id and o.company_id=a.company_id
        left join traders t on t.id=o.trader_id and t.company_id=o.company_id
        left join outsourced_driver_fee_payment_allocations pa on pa.accrual_id=a.id and pa.company_id=a.company_id and pa.reversed_at is null
        left join outsourced_driver_fee_payments p on p.id=pa.payment_id and p.company_id=pa.company_id
        where a.company_id=${companyId}::uuid and a.driver_id=${row.driverId}::uuid and a.status<>'reversed'
          and (${query.dateFrom ?? null}::date is null or a.accrual_business_date>=${query.dateFrom ?? null}::date)
          and (${query.dateTo ?? null}::date is null or a.accrual_business_date<=${query.dateTo ?? null}::date)
        group by a.id,o.order_number,o.serial_number,o.order_date,o.reference_number,o.customer_name,t.name_en
        order by a.accrual_business_date,a.id`.execute(this.database);
      const payments = await sql<
        Record<string, unknown>
      >`select p.id,p.payment_number as "paymentNumber",
        p.payment_date::text as "paymentDate",p.amount_paid::text as amount,p.payment_method as method,
        coalesce(p.external_reference,p.cash_voucher_reference) as reference,p.status,
        (p.reversed_at is not null) as reversed
        from outsourced_driver_fee_payments p where p.company_id=${companyId}::uuid
          and p.driver_id=${row.driverId}::uuid
          and (${query.dateFrom ?? null}::date is null or p.payment_date>=${query.dateFrom ?? null}::date)
          and (${query.dateTo ?? null}::date is null or p.payment_date<=${query.dateTo ?? null}::date)
        order by p.payment_date desc,p.created_at desc`.execute(this.database);
      const setup = await this.outsourcedEarningSetup(companyId, row.driverId);
      const deliverySources = sources.rows.filter((source) => source.sourceType === "delivery");
      const collectionSources = sources.rows.filter((source) => source.sourceType === "collection");
      return {
        ...row,
        ...totals.rows[0],
        sources: sources.rows,
        payments: payments.rows,
        setup,
        deliveredOrders: deliverySources.reduce((n, s) => n + Number(s.unitCount ?? 1), 0),
        deliveryTransactions: deliverySources.length,
        collectionTransactions: collectionSources.length,
        collectedOrders: collectionSources.reduce((n, s) => n + Number(s.unitCount ?? 0), 0),
        deliveryRate: this.rateLabel(deliverySources.map((s) => String(s.rate))),
        collectionRate: this.rateLabel(collectionSources.map((s) => String(s.rate))),
        paymentTransactions: payments.rows.length,
        variableInterimPaid: "0.00",
        interimPaid: "0.00",
        payrollPaid: "0.00",
        outsourcedPaid: totals.rows[0]?.paid ?? "0.00",
      };
    }
    if (row.employeeId === null) this.notFound();
    const sources = await this.employeeSources(
      this.database,
      companyId,
      row.employeeId!,
      query,
      false,
    );
    const delivery = this.sum(
      sources.filter((item) => item.sourceType === "delivery"),
      "gross",
    );
    const collection = this.sum(
      sources.filter((item) => item.sourceType === "collection"),
      "gross",
    );
    const paid = this.sum(sources, "paid");
    const interimPaid = this.sum(sources, "interimPaid");
    const payrollPaid = this.sum(sources, "payrollAllocated");
    const earned = new Decimal(delivery).plus(collection);
    const deliverySources = sources.filter((item) => item.sourceType === "delivery");
    const collectionSources = sources.filter((item) => item.sourceType === "collection");
    const setup = await this.employeeEarningSetup(companyId, row.employeeId);
    const payments = await this.employeePaymentHistory(companyId, row.employeeId, query);
    const paymentReady = await this.employeeInterimPaymentReady(companyId);
    return {
      ...row,
      collection: new Decimal(collection).toFixed(2),
      delivery: new Decimal(delivery).toFixed(2),
      earned: earned.toFixed(2),
      deliveredOrders: deliverySources.length,
      deliveryTransactions: deliverySources.length,
      collectionTransactions: collectionSources.length,
      collectedOrders: collectionSources.reduce(
        (total, source) => total + source.collectedOrderCount,
        0,
      ),
      deliveryRate: this.rateLabel(deliverySources.map((source) => source.rate)),
      collectionRate: this.rateLabel(collectionSources.map((source) => source.rate)),
      outstanding: earned.minus(paid).toFixed(2),
      paid: new Decimal(paid).toFixed(2),
      interimPaid,
      payrollPaid,
      outsourcedPaid: "0.00",
      paymentTransactions: payments.length,
      payments,
      setup,
      paymentAvailable: paymentReady,
      paymentBlockReason: paymentReady ? null : "employee_interim_payroll_clearing_missing",
      sources: sources.map((source) => ({
        ...source,
        outstanding: new Decimal(source.gross).minus(source.paid).toFixed(2),
      })),
      variableInterimPaid: new Decimal(paid).toFixed(2),
    };
  }

  public async payVariableEarnings(
    input: EmployeeMoneyPaymentDto,
    idempotencyKey: string | undefined,
    correlationId: string,
  ) {
    this.support.assertPermission("payroll.pay");
    const { actorId, companyId } = this.support.context();
    const requested = new Decimal(input.amount);
    return this.transactions.execute(async (transaction) => {
      const replay = await this.support.reserveIdempotency(transaction, {
        companyId,
        idempotencyKey,
        operation: "employee.variable_earnings_interim_payment.confirm",
        payload: input,
      });
      if (replay.replayResponse !== undefined) return replay.replayResponse;
      await this.assertEmployeeDriver(transaction, companyId, input.employeeId);
      if (input.earningPeriodId)
        await sql`select id from employee_driver_earning_periods
          where id=${input.earningPeriodId}::uuid and company_id=${companyId}::uuid for update`.execute(
          transaction,
        );
      const period = input.earningPeriodId
        ? await sql<{ outstanding: string }>`select greatest(p.total_earnings
            -coalesce(sum(a.allocated_amount) filter(where a.reversed_at is null and ep.status='confirmed'),0)
            -coalesce((select sum(pa.allocated_amount) from employee_driver_earning_period_payroll_allocations pa
              join payroll_entries pe on pe.id=pa.payroll_entry_id and pe.company_id=pa.company_id
              where pa.company_id=p.company_id and pa.period_id=p.id and pa.reversed_at is null
                and pe.approved_at is not null),0),0)::text as outstanding
            from employee_driver_earning_periods p
            left join employee_driver_earning_period_payment_allocations a
              on a.period_id=p.id and a.company_id=p.company_id
            left join employee_variable_earning_payments ep on ep.id=a.payment_id and ep.company_id=a.company_id
            where p.id=${input.earningPeriodId}::uuid and p.company_id=${companyId}::uuid
              and p.employee_id=${input.employeeId}::uuid and p.status<>'reversed'
            group by p.id`.execute(transaction)
        : null;
      if (input.earningPeriodId && !period?.rows[0]) this.notFound();
      await sql`select id from employee_order_earnings where company_id=${companyId}::uuid
        and employee_id=${input.employeeId}::uuid and payroll_period_id is null for update`.execute(
        transaction,
      );
      await sql`select id from employee_driver_collection_facts where company_id=${companyId}::uuid
        and employee_id=${input.employeeId}::uuid and payroll_period_id is null for update`.execute(
        transaction,
      );
      const sources = input.earningPeriodId
        ? []
        : await this.employeeSources(transaction, companyId, input.employeeId, {}, true);
      const available = input.earningPeriodId
        ? new Decimal(period!.rows[0]!.outstanding)
        : sources.reduce(
            (sum, source) => sum.plus(source.gross).minus(source.paid),
            new Decimal(0),
          );
      if (!requested.isFinite() || requested.lte(0) || requested.gt(available)) {
        throw new ApplicationException(
          "employee_variable_payment_exceeds_outstanding",
          "The payment exceeds the Employee's available variable earnings",
          HttpStatus.CONFLICT,
        );
      }
      const account = await this.funding.resolve(input.accountId, input.paymentMethod);
      const paymentNumber = await this.history.nextReferenceNumber(
        transaction,
        companyId,
        "employee_variable_earning_payment",
        "EVPAY",
      );
      const enforcement = await this.balances.evaluate(transaction, {
        actorId,
        actorPermissions: this.support.permissions(),
        deductions: [
          { accountId: account.accountId, amount: requested.toFixed(2), kind: account.kind },
        ],
        onDate: input.paymentDate,
        sourceReference: paymentNumber,
        sourceType: "employee_variable_earnings_payment",
        ...(input.balanceOverrideReason === undefined
          ? {}
          : { overrideReason: input.balanceOverrideReason }),
      });
      this.assertBalance(enforcement.allowed, enforcement.failureReason);
      const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const created = await sql<{ id: string }>`
        insert into employee_variable_earning_payments(
          company_id,employee_id,payment_number,payment_date,payment_method,amount_paid,
          company_cash_account_id,company_bank_account_id,external_reference,notes,
          paid_by_account_id,idempotency_key,request_hash
        ) values(
          ${companyId}::uuid,${input.employeeId}::uuid,${paymentNumber},${input.paymentDate}::date,
          ${input.paymentMethod},${requested.toFixed(2)},
          ${input.paymentMethod === "cash" ? account.accountId : null}::uuid,
          ${input.paymentMethod === "bank" ? account.accountId : null}::uuid,
          ${input.reference?.trim() || null},${input.notes?.trim() || null},${actorId}::uuid,
          ${idempotencyKey!.trim()},${requestHash}
        ) returning id
      `.execute(transaction);
      const paymentId = created.rows[0]!.id;

      // Create cash/bank movement for variable earnings payment
      if (input.paymentMethod) {
        await this.createPaymentMovement(transaction, {
          companyId,
          paymentNumber,
          paymentDate: input.paymentDate,
          fundingAccountId: account.accountId,
          amount: requested.toFixed(2),
          paymentMethod: input.paymentMethod,
          paymentId,
          paymentKind: "variable",
          actorId,
        });
      }

      let remaining = requested;
      let order = 1;
      const allocations: Array<{ amount: string; sourceId: string; sourceType: string }> = [];
      for (const source of sources) {
        if (remaining.isZero()) break;
        const outstanding = new Decimal(source.gross).minus(source.paid);
        if (outstanding.lte(0)) continue;
        const amount = Decimal.min(remaining, outstanding);
        await sql`
          insert into employee_variable_earning_payment_allocations(
            company_id,payment_id,source_type,employee_order_earning_id,
            employee_collection_fact_id,source_earning_date,source_gross_amount,
            allocated_amount,allocation_order
          ) values(
            ${companyId}::uuid,${paymentId}::uuid,${source.sourceType},
            ${source.sourceType === "delivery" ? source.id : null}::uuid,
            ${source.sourceType === "collection" ? source.id : null}::uuid,
            ${source.date}::date,${source.gross},${amount.toFixed(2)},${order}
          )
        `.execute(transaction);
        allocations.push({
          amount: amount.toFixed(2),
          sourceId: source.id,
          sourceType: source.sourceType,
        });
        remaining = remaining.minus(amount);
        order += 1;
      }
      if (input.earningPeriodId) {
        await sql`insert into employee_driver_earning_period_payment_allocations(
          company_id,period_id,payment_id,allocated_amount)
          values(${companyId}::uuid,${input.earningPeriodId}::uuid,${paymentId}::uuid,
            ${requested.toFixed(2)})`.execute(transaction);
        allocations.push({
          amount: requested.toFixed(2),
          sourceId: input.earningPeriodId,
          sourceType: "period",
        });
      }
      const response = {
        allocations,
        amount: requested.toFixed(2),
        availableBefore: available.toFixed(2),
        employeeId: input.employeeId,
        outstanding: available.minus(requested).toFixed(2),
        paymentId,
        paymentNumber,
        status: "confirmed",
      };
      if (enforcement.requiresOverrideAudit) {
        await this.balances.recordOverrides(transaction, {
          actorId,
          overrideReason: input.balanceOverrideReason ?? "",
          result: enforcement,
          sourceEntityId: paymentId,
          sourceReference: paymentNumber,
          sourceType: "employee_variable_earnings_payment",
        });
      }
      await this.history.audit(transaction, {
        action: "employee.variable_earnings_interim_payment.confirmed",
        actorId,
        after: response,
        companyId,
        correlationId,
        subjectId: paymentId,
        subjectType: "variable_earnings_interim_payment",
      });
      await this.support.completeIdempotency(transaction, {
        companyId,
        idempotencyKey: idempotencyKey!.trim(),
        operation: "employee.variable_earnings_interim_payment.confirm",
        resourceId: paymentId,
        resourceType: "variable_earnings_interim_payment",
        responseBody: response,
      });
      return response;
    });
  }

  public reverseVariablePayment(paymentId: string, reason: string, correlationId: string) {
    this.support.assertPermission("payroll.reverse");
    const { actorId, companyId } = this.support.context();
    if (reason.trim() === "") this.reasonRequired();
    return this.transactions.execute(async (transaction) => {
      const payment = await sql<{
        status: string;
      }>`select status from employee_variable_earning_payments
        where id=${paymentId}::uuid and company_id=${companyId}::uuid for update`.execute(
        transaction,
      );
      if (payment.rows[0]?.status !== "confirmed") this.paymentUnavailable();
      const posted = await sql<{ count: number }>`select count(*)::int as count
        from employee_variable_earning_payment_allocations a join payroll_entries l
          on l.id=a.payroll_entry_id and l.company_id=a.company_id join payroll_periods p
          on p.id=l.payroll_period_id and p.company_id=l.company_id
       where a.company_id=${companyId}::uuid and a.payment_id=${paymentId}::uuid
         and a.reversed_at is null and p.status in('approved','partially_paid','paid','closed')`.execute(
        transaction,
      );
      if ((posted.rows[0]?.count ?? 0) > 0) {
        throw new ApplicationException(
          "employee_variable_payment_in_posted_payroll",
          "Reverse the approved Payroll first before correcting this interim payment",
          HttpStatus.CONFLICT,
        );
      }
      await sql`update employee_variable_earning_payment_allocations set reversed_at=now()
        where company_id=${companyId}::uuid and payment_id=${paymentId}::uuid and reversed_at is null`.execute(
        transaction,
      );
      await sql`update employee_driver_earning_period_payment_allocations set reversed_at=now()
        where company_id=${companyId}::uuid and payment_id=${paymentId}::uuid and reversed_at is null`.execute(
        transaction,
      );
      await sql`update employee_variable_earning_payments set status='reversed',reversed_by_account_id=${actorId}::uuid,
        reversed_at=now(),reversal_reason=${reason.trim()},updated_at=now(),version=version+1
        where company_id=${companyId}::uuid and id=${paymentId}::uuid`.execute(transaction);
      await this.history.audit(transaction, {
        action: "employee.variable_earnings_interim_payment.reversed",
        actorId,
        after: { paymentId, reason: reason.trim() },
        companyId,
        correlationId,
        subjectId: paymentId,
        subjectType: "variable_earnings_interim_payment",
      });
      return { paymentId, status: "reversed" };
    });
  }

  public async paySalaryAdvance(
    input: EmployeeMoneyPaymentDto,
    idempotencyKey: string | undefined,
    correlationId: string,
  ) {
    this.support.assertPermission("payroll.pay");
    const { actorId, companyId } = this.support.context();
    return this.transactions.execute(async (transaction) => {
      const replay = await this.support.reserveIdempotency(transaction, {
        companyId,
        idempotencyKey,
        operation: "employee.salary_advance.confirm",
        payload: input,
      });
      if (replay.replayResponse !== undefined) return replay.replayResponse;
      await this.assertEmployee(transaction, companyId, input.employeeId);
      // Serialize Salary Advances per Employee so concurrent requests cannot
      // both observe the same available salary limit.
      await sql`select pg_advisory_xact_lock(hashtext(${`${companyId}:${input.employeeId}:salary-advance`}))`.execute(
        transaction,
      );
      const salary = await sql<{ amount: string }>`select basic_salary::text as amount
        from employee_salary_versions
        where company_id=${companyId}::uuid and employee_id=${input.employeeId}::uuid
          and effective_from<=${input.paymentDate}::date
          and (effective_to is null or effective_to>=${input.paymentDate}::date)
        order by effective_from desc limit 1 for update`.execute(transaction);
      const basicSalary = new Decimal(salary.rows[0]?.amount ?? 0);
      if (basicSalary.lte(0))
        throw new ApplicationException(
          "salary_advance_salary_not_configured",
          "An effective Basic Salary must be configured before paying a Salary Advance",
          HttpStatus.CONFLICT,
        );
      await sql`select id from employee_salary_advances
        where company_id=${companyId}::uuid and employee_id=${input.employeeId}::uuid
          and status in('confirmed','partially_recovered')
        for update`.execute(transaction);
      const existingAdvances = await sql<{
        amount: string;
      }>`select coalesce(sum(outstanding_amount),0)::text as amount
        from employee_salary_advances
        where company_id=${companyId}::uuid and employee_id=${input.employeeId}::uuid
          and status in('confirmed','partially_recovered')`.execute(transaction);
      const existingOutstanding = new Decimal(existingAdvances.rows[0]?.amount ?? 0);
      const amount = new Decimal(input.amount);
      const availableAdvance = Decimal.max(basicSalary.minus(existingOutstanding), 0);
      if (amount.gt(availableAdvance))
        throw new ApplicationException(
          "salary_advance_exceeds_basic_salary",
          `Salary Advance cannot exceed the available Basic Salary limit of AED ${availableAdvance.toFixed(2)}`,
          HttpStatus.CONFLICT,
        );
      const account = await this.funding.resolve(input.accountId, input.paymentMethod);
      const advanceNumber = await this.history.nextReferenceNumber(
        transaction,
        companyId,
        "employee_salary_advance",
        "SADV",
      );
      const enforcement = await this.balances.evaluate(transaction, {
        actorId,
        actorPermissions: this.support.permissions(),
        deductions: [
          { accountId: account.accountId, amount: amount.toFixed(2), kind: account.kind },
        ],
        onDate: input.paymentDate,
        sourceReference: advanceNumber,
        sourceType: "employee_salary_advance",
        ...(input.balanceOverrideReason === undefined
          ? {}
          : { overrideReason: input.balanceOverrideReason }),
      });
      this.assertBalance(enforcement.allowed, enforcement.failureReason);
      const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const created = await sql<{ id: string }>`insert into employee_salary_advances(
        company_id,employee_id,advance_number,payment_date,payment_method,amount_paid,outstanding_amount,
        company_cash_account_id,company_bank_account_id,external_reference,notes,paid_by_account_id,
        idempotency_key,request_hash) values(${companyId}::uuid,${input.employeeId}::uuid,
        ${advanceNumber},${input.paymentDate}::date,${input.paymentMethod},${amount.toFixed(2)},
        ${amount.toFixed(2)},${input.paymentMethod === "cash" ? account.accountId : null}::uuid,
        ${input.paymentMethod === "bank" ? account.accountId : null}::uuid,${input.reference?.trim() || null},
        ${input.notes?.trim() || null},${actorId}::uuid,${idempotencyKey!.trim()},${hash}) returning id`.execute(
        transaction,
      );
      const advanceId = created.rows[0]!.id;

      // Create cash/bank movement for salary advance payment
      if (input.paymentMethod) {
        await this.createPaymentMovement(transaction, {
          companyId,
          paymentNumber: advanceNumber,
          paymentDate: input.paymentDate,
          fundingAccountId: account.accountId,
          amount: amount.toFixed(2),
          paymentMethod: input.paymentMethod,
          paymentId: advanceId,
          paymentKind: "salary_advance",
          actorId,
        });
      }

      const response = {
        advanceId,
        advanceNumber,
        amount: amount.toFixed(2),
        employeeId: input.employeeId,
        outstanding: amount.toFixed(2),
        status: "confirmed",
      };
      if (enforcement.requiresOverrideAudit)
        await this.balances.recordOverrides(transaction, {
          actorId,
          overrideReason: input.balanceOverrideReason ?? "",
          result: enforcement,
          sourceEntityId: advanceId,
          sourceReference: advanceNumber,
          sourceType: "employee_salary_advance",
        });
      await this.history.audit(transaction, {
        action: "employee.salary_advance.confirmed",
        actorId,
        after: response,
        companyId,
        correlationId,
        subjectId: advanceId,
        subjectType: "salary_advance",
      });
      await this.support.completeIdempotency(transaction, {
        companyId,
        idempotencyKey: idempotencyKey!.trim(),
        operation: "employee.salary_advance.confirm",
        resourceId: advanceId,
        resourceType: "salary_advance",
        responseBody: response,
      });
      return response;
    });
  }

  public async salaryAdvanceAvailability(employeeId: string, paymentDate: string) {
    this.support.assertPermission("payroll.pay");
    const { companyId } = this.support.context();
    await this.assertEmployee(this.database, companyId, employeeId);
    const result = await sql<{ basicSalary: string; existingOutstanding: string }>`select
      coalesce((select basic_salary from employee_salary_versions
        where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid
          and effective_from<=${paymentDate}::date
          and (effective_to is null or effective_to>=${paymentDate}::date)
        order by effective_from desc limit 1),0)::text as "basicSalary",
      coalesce((select sum(outstanding_amount) from employee_salary_advances
        where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid
          and status in('confirmed','partially_recovered')),0)::text as "existingOutstanding"`.execute(
      this.database,
    );
    const row = result.rows[0] ?? { basicSalary: "0", existingOutstanding: "0" };
    return {
      ...row,
      available: Decimal.max(
        new Decimal(row.basicSalary).minus(row.existingOutstanding),
        0,
      ).toFixed(2),
    };
  }

  public reverseSalaryAdvance(advanceId: string, reason: string, correlationId: string) {
    this.support.assertPermission("payroll.reverse");
    const { actorId, companyId } = this.support.context();
    if (reason.trim() === "") this.reasonRequired();
    return this.transactions.execute(async (transaction) => {
      const row = await sql<{
        recovered: string;
        status: string;
      }>`select recovered_amount::text as recovered,status
        from employee_salary_advances where id=${advanceId}::uuid and company_id=${companyId}::uuid for update`.execute(
        transaction,
      );
      if (row.rows[0] === undefined || row.rows[0].status === "reversed") this.paymentUnavailable();
      if (new Decimal(row.rows[0]!.recovered).gt(0))
        throw new ApplicationException(
          "salary_advance_already_recovered",
          "Reverse the Payroll recovery before reversing this Salary Advance",
          HttpStatus.CONFLICT,
        );
      await sql`update employee_salary_advances set status='reversed',outstanding_amount=0,
        reversed_by_account_id=${actorId}::uuid,reversed_at=now(),reversal_reason=${reason.trim()},
        updated_at=now(),version=version+1 where id=${advanceId}::uuid and company_id=${companyId}::uuid`.execute(
        transaction,
      );
      await this.history.audit(transaction, {
        action: "employee.salary_advance.reversed",
        actorId,
        after: { advanceId, reason: reason.trim() },
        companyId,
        correlationId,
        subjectId: advanceId,
        subjectType: "salary_advance",
      });
      return { advanceId, status: "reversed" };
    });
  }

  public async outsourcedCollectionRules(driverId: string) {
    this.support.assertPermission("outsourced_driver_fees.view");
    const { companyId } = this.support.context();
    return (
      await sql`select id,collection_payment_type as "paymentType",amount::text,
      effective_from::text as "effectiveFrom",effective_to::text as "effectiveTo",is_active as "isActive"
      from outsourced_driver_collection_earning_rules where company_id=${companyId}::uuid
      and driver_id=${driverId}::uuid order by effective_from desc,created_at desc`.execute(
        this.database,
      )
    ).rows;
  }

  public setOutsourcedCollectionRule(
    driverId: string,
    input: SaveOutsourcedCollectionRuleDto,
    correlationId: string,
  ) {
    this.support.assertPermission("outsourced_driver_fees.manage");
    const { actorId, companyId } = this.support.context();
    if (
      input.collectionPaymentType !== "none" &&
      input.collectionPaymentType !== "per_collected_order"
    )
      throw new ApplicationException(
        "outsourced_collection_payment_type_unsupported",
        "Collection Payment Type must be None or Per Collected Order",
        HttpStatus.BAD_REQUEST,
      );
    const none = input.collectionPaymentType === "none";
    if ((none && input.amount !== 0) || (!none && input.amount <= 0))
      throw new ApplicationException(
        "outsourced_collection_rate_invalid",
        "The collection payment type and amount do not agree",
        HttpStatus.BAD_REQUEST,
      );
    return this.transactions.execute(async (transaction) => {
      await sql`update outsourced_driver_collection_earning_rules set effective_to=${input.effectiveFrom}::date,
        updated_at=now(),version=version+1 where company_id=${companyId}::uuid and driver_id=${driverId}::uuid
        and is_active and effective_to is null and effective_from<${input.effectiveFrom}::date`.execute(
        transaction,
      );
      const created = await sql<{
        id: string;
      }>`insert into outsourced_driver_collection_earning_rules(
        company_id,driver_id,collection_payment_type,amount,effective_from,effective_to,created_by_account_id)
        values(${companyId}::uuid,${driverId}::uuid,${input.collectionPaymentType},${input.amount},
        ${input.effectiveFrom}::date,${input.effectiveTo ?? null}::date,${actorId}::uuid) returning id`.execute(
        transaction,
      );
      const id = created.rows[0]!.id;
      await this.history.audit(transaction, {
        action: "outsourced_driver.collection_earning_rule.set",
        actorId,
        after: { driverId, id, ...input },
        companyId,
        correlationId,
        subjectId: driverId,
        subjectType: "driver",
      });
      return { id, ...input };
    });
  }

  private async employeeSources(
    database: Database,
    companyId: string,
    employeeId: string,
    query: Pick<DriverEarningsQueryDto, "dateFrom" | "dateTo" | "status">,
    onlyUnallocated: boolean,
  ): Promise<EmployeeSource[]> {
    const result = await sql<EmployeeSource>`
      with sources as(
        select e.id,'delivery'::text as source_type,
          (e.delivered_at at time zone coalesce(cs.timezone,'Asia/Dubai'))::date as earning_date,
          e.applied_amount as gross,e.order_number as reference,e.order_id,
          o.order_number,o.reference_number,o.serial_number,o.order_date::text as serial_date,
          o.customer_name as customer,t.name_en as trader,r.amount_per_order as rate,
          0::int as collected_order_count,'[]'::jsonb as linked_orders,e.payroll_entry_id
        from employee_order_earnings e left join company_settings cs on cs.company_id=e.company_id
        join orders o on o.id=e.order_id and o.company_id=e.company_id
        left join traders t on t.id=o.trader_id and t.company_id=o.company_id
        join employee_delivery_earning_rules r on r.id=e.rule_id and r.company_id=e.company_id
        where e.company_id=${companyId}::uuid and e.employee_id=${employeeId}::uuid
          and (${onlyUnallocated}::boolean=false or e.payroll_period_id is null)
        union all
        select f.id,'collection',f.business_date,
          coalesce(existing.source_gross_amount,case r.collection_payment_type
            when 'per_collected_order' then r.amount*f.collected_order_count
            -- Legacy read compatibility only. Write DTOs reject new flat rules.
            when 'flat_per_confirmed_collection' then r.amount else 0 end),
          dr.reconciliation_number,null::uuid,null::text,null::text,null::text,null::text,
          null::text,null::text,r.amount,f.collected_order_count,
          coalesce((select jsonb_agg(jsonb_build_object('orderId',o.id,'serialNumber',o.serial_number,
            'serialDate',o.order_date::text,'orderNumber',o.order_number,'referenceNumber',o.reference_number,
            'trader',t.name_en,'customer',o.customer_name) order by o.order_date,o.order_number)
            from driver_reconciliation_orders ro join orders o on o.id=ro.order_id and o.company_id=ro.company_id
            left join traders t on t.id=o.trader_id and t.company_id=o.company_id
            where ro.company_id=f.company_id and ro.reconciliation_id=f.reconciliation_id),'[]'::jsonb),
          f.payroll_entry_id
        from employee_driver_collection_facts f
        join driver_reconciliations dr on dr.id=f.reconciliation_id and dr.company_id=f.company_id
        left join employee_collection_earning_rules r on r.company_id=f.company_id
          and r.employee_id=f.employee_id and r.is_active and r.effective_from<=f.business_date
          and (r.effective_to is null or f.business_date<r.effective_to)
        left join lateral(select max(a.source_gross_amount) as source_gross_amount
          from employee_variable_earning_payment_allocations a
          where a.company_id=f.company_id and a.employee_collection_fact_id=f.id) existing on true
        where f.company_id=${companyId}::uuid and f.employee_id=${employeeId}::uuid
          and f.counts_for_collection_earning
          and (${onlyUnallocated}::boolean=false or f.payroll_period_id is null)
        union all
        -- Collect-order earnings (per closed collect_order, stamped with a
        -- rate snapshot at close). These are what the earning-period preview
        -- counts, yet were invisible here -- the Daily Earning Availability
        -- table showed 0 collected orders for a day the period preview
        -- correctly priced. REPORT PATH ONLY: when onlyUnallocated=true this
        -- list sizes the direct variable-earning payment, and these rows are
        -- paid exclusively through their earning period -- including them
        -- there would let the same earning be paid twice. Their payment
        -- state lives on the period, so paymentStatus below reads 'unpaid'
        -- until payroll consumes the period.
        select x.id,'collection',
          (x.closed_at at time zone coalesce(cs.timezone,'Asia/Dubai'))::date,
          x.earned_amount,o.order_number,x.order_id,
          o.order_number,o.reference_number,o.serial_number,o.order_date::text,
          o.customer_name,t.name_en,x.rate_snapshot,
          1::int,'[]'::jsonb,null::uuid
        from employee_collect_order_earnings x
        left join company_settings cs on cs.company_id=x.company_id
        join orders o on o.id=x.order_id and o.company_id=x.company_id
        left join traders t on t.id=o.trader_id and t.company_id=o.company_id
        where ${onlyUnallocated}::boolean=false
          and x.company_id=${companyId}::uuid and x.employee_id=${employeeId}::uuid
      ), paid as(
        select source_type,coalesce(employee_order_earning_id,employee_collection_fact_id) source_id,
          sum(allocated_amount) filter(where reversed_at is null) amount
        from employee_variable_earning_payment_allocations where company_id=${companyId}::uuid
        group by source_type,coalesce(employee_order_earning_id,employee_collection_fact_id)
      )
      select s.id,s.source_type as "sourceType",s.earning_date::text as date,
        s.gross::text as gross,coalesce(p.amount,0)::text as "interimPaid",
        (case when s.payroll_entry_id is not null then greatest(s.gross-coalesce(p.amount,0),0) else 0 end)::text as "payrollAllocated",
        (coalesce(p.amount,0)+case when s.payroll_entry_id is not null then greatest(s.gross-coalesce(p.amount,0),0) else 0 end)::text as paid,
        s.reference,s.order_id as "orderId",s.order_number as "orderNumber",
        s.reference_number as "referenceNumber",s.serial_number as "serialNumber",
        s.serial_date as "serialDate",s.customer,s.trader,s.rate::text as rate,
        s.collected_order_count as "collectedOrderCount",s.linked_orders as "linkedOrders",
        case when coalesce(p.amount,0)>=s.gross or s.payroll_entry_id is not null then 'paid'
             when coalesce(p.amount,0)>0 then 'partially_paid' else 'unpaid' end as "paymentStatus"
      from sources s left join paid p on p.source_type=s.source_type and p.source_id=s.id
      where s.gross>0
        and (${query.dateFrom ?? null}::date is null or s.earning_date>=${query.dateFrom ?? null}::date)
        and (${query.dateTo ?? null}::date is null or s.earning_date<=${query.dateTo ?? null}::date)
        and (${query.status ?? null}::text is null
          or (${query.status ?? null}='unpaid' and coalesce(p.amount,0)=0)
          or (${query.status ?? null}='partially_paid' and coalesce(p.amount,0)>0 and coalesce(p.amount,0)<s.gross)
          or (${query.status ?? null}='paid' and coalesce(p.amount,0)=s.gross))
      order by s.earning_date,s.source_type,s.id
    `.execute(database);
    return result.rows;
  }

  private async driverDirectory(query: DriverEarningsQueryDto) {
    const { companyId } = this.support.context();
    const page = Math.max(1, query.page ?? 1);
    const size = Math.min(200, query.pageSize ?? 50);
    const result =
      await sql`select d.id as "driverId",d.code as "driverCode",d.name_en as "driverName",
      d.driver_type as "driverType",d.employee_id as "employeeId" from drivers d
      where d.company_id=${companyId}::uuid and d.account_status='active'
        and d.driver_type='employee'
        and exists(select 1 from employees e where e.id=d.employee_id and e.company_id=d.company_id and e.payroll_eligible)
        and (${query.driverType ?? null}::text is null or d.driver_type=${query.driverType ?? null})
        and (exists(select 1 from employee_delivery_earning_rules r where r.company_id=d.company_id and r.employee_id=d.employee_id)
          or exists(select 1 from employee_collection_earning_rules r where r.company_id=d.company_id and r.employee_id=d.employee_id)
          or exists(select 1 from employee_order_earnings e where e.company_id=d.company_id and e.employee_id=d.employee_id)
          or exists(select 1 from employee_driver_collection_facts f where f.company_id=d.company_id and f.employee_id=d.employee_id and f.counts_for_collection_earning and f.collected_order_count>0)
          or exists(select 1 from employee_variable_earning_payments p where p.company_id=d.company_id and p.employee_id=d.employee_id)
          )
      order by d.code limit ${size} offset ${(page - 1) * size}`.execute(this.database);
    return { items: result.rows, page, pageSize: size };
  }
  private async employeeInterimPaymentReady(companyId: string): Promise<boolean> {
    const result = await sql<{ ready: boolean }>`select exists(
      select 1 from account_mappings m
      join chart_of_accounts a on a.id=m.debit_account_id and a.company_id=m.company_id
      where m.company_id=${companyId}::uuid
        and m.mapping_key='employee_interim_payroll_clearing' and m.is_active
        and m.effective_from<=current_date
        and (m.effective_to is null or current_date<m.effective_to)
        and a.is_active and a.is_posting_account
    ) as ready`.execute(this.database);
    return result.rows[0]?.ready === true;
  }
  private rateLabel(rates: readonly string[]): string | null {
    const unique = [...new Set(rates.filter((rate) => rate !== "null" && rate !== "undefined"))];
    return unique.length === 0
      ? null
      : unique.length === 1
        ? new Decimal(unique[0]!).toFixed(2)
        : "multiple";
  }
  private async employeeEarningSetup(companyId: string, employeeId: string) {
    const result = await sql<Record<string, unknown>>`select
      (select amount_per_order::text from employee_delivery_earning_rules where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid and is_active and effective_from<=current_date and (effective_to is null or current_date<effective_to) order by effective_from desc limit 1) as delivery,
      (select amount::text from employee_collection_earning_rules where company_id=${companyId}::uuid and employee_id=${employeeId}::uuid and is_active and collection_payment_type='per_collected_order' and effective_from<=current_date and (effective_to is null or current_date<effective_to) order by effective_from desc limit 1) as collection`.execute(
      this.database,
    );
    return result.rows[0] ?? { delivery: null, collection: null };
  }
  private async outsourcedEarningSetup(companyId: string, driverId: string) {
    const result = await sql<Record<string, unknown>>`select
      (select fee_per_order::text from outsourced_driver_fee_versions where company_id=${companyId}::uuid and driver_id=${driverId}::uuid and status='active' and effective_from<=current_date and (effective_to is null or current_date<effective_to) order by effective_from desc limit 1) as delivery,
      (select amount::text from outsourced_driver_collection_earning_rules where company_id=${companyId}::uuid and driver_id=${driverId}::uuid and is_active and collection_payment_type='per_collected_order' and effective_from<=current_date and (effective_to is null or current_date<effective_to) order by effective_from desc limit 1) as collection`.execute(
      this.database,
    );
    return result.rows[0] ?? { delivery: null, collection: null };
  }
  private async employeePaymentHistory(
    companyId: string,
    employeeId: string,
    query: Pick<DriverEarningsQueryDto, "dateFrom" | "dateTo">,
  ) {
    return (
      await sql<
        Record<string, unknown>
      >`select p.id,p.payment_number as "paymentNumber",p.payment_date::text as "paymentDate",
      'interim'::text as "transactionType",p.amount_paid::text as amount,p.payment_method as method,
      coalesce(c.cash_account_name,b.account_name,b.bank_name) as account,p.external_reference as reference,p.status,(p.reversed_at is not null) as reversed
      from employee_variable_earning_payments p left join company_cash_accounts c on c.id=p.company_cash_account_id and c.company_id=p.company_id
      left join company_bank_accounts b on b.id=p.company_bank_account_id and b.company_id=p.company_id
      where p.company_id=${companyId}::uuid and p.employee_id=${employeeId}::uuid
        and (${query.dateFrom ?? null}::date is null or p.payment_date>=${query.dateFrom ?? null}::date)
        and (${query.dateTo ?? null}::date is null or p.payment_date<=${query.dateTo ?? null}::date)
      order by p.payment_date desc,p.confirmed_at desc`.execute(this.database)
    ).rows;
  }
  private sum(
    rows: readonly EmployeeSource[],
    field: "gross" | "interimPaid" | "paid" | "payrollAllocated",
  ) {
    return rows.reduce((total, row) => total.plus(row[field]), new Decimal(0)).toFixed(2);
  }
  private async assertEmployee(database: Database, companyId: string, employeeId: string) {
    const row =
      await sql`select id from employees where id=${employeeId}::uuid and company_id=${companyId}::uuid`.execute(
        database,
      );
    if (row.rows[0] === undefined) this.notFound();
  }
  private async assertEmployeeDriver(database: Database, companyId: string, employeeId: string) {
    const row =
      await sql`select e.id from employees e join drivers d on d.employee_id=e.id and d.company_id=e.company_id
      where e.id=${employeeId}::uuid and e.company_id=${companyId}::uuid and d.driver_type='employee'`.execute(
        database,
      );
    if (row.rows[0] === undefined)
      throw new ApplicationException(
        "employee_driver_not_found",
        "The Employee is not linked to an Employee Driver",
        HttpStatus.NOT_FOUND,
      );
  }
  private assertBalance(allowed: boolean, reason: string | null) {
    if (!allowed)
      throw new ApplicationException(
        "payment_balance_blocked",
        reason ?? "The selected account cannot fund this payment",
        HttpStatus.CONFLICT,
      );
  }
  private notFound(): never {
    throw new ApplicationException(
      "driver_earnings_not_found",
      "The Driver was not found",
      HttpStatus.NOT_FOUND,
    );
  }
  private async createPaymentMovement(
    transaction: Kysely<DatabaseSchema>,
    options: {
      readonly companyId: string;
      readonly paymentNumber: string;
      readonly paymentDate: string;
      readonly fundingAccountId: string;
      readonly amount: string;
      readonly paymentMethod: string;
      readonly paymentId: string;
      readonly paymentKind: "salary_advance" | "variable";
      readonly actorId: string;
    },
  ): Promise<void> {
    const movementType = options.paymentMethod === "cash" ? "cash_withdrawal" : "bank_withdrawal";
    // Cash/Bank Movement uses the legacy UI-method vocabulary: bank-funded
    // payments are represented as `visa`, while the payroll DTO calls them
    // `bank`. Keep the funding account classification separate from this label.
    const movementPaymentMethod = options.paymentMethod === "cash" ? "cash" : "visa";
    const movementNumber = await this.history.nextReferenceNumber(
      transaction,
      options.companyId,
      "cash_bank_movement",
      "CBM",
    );
    const movementId = randomUUID();

    const eventType =
      options.paymentKind === "variable"
        ? "employee_variable_earnings_interim_paid"
        : "employee_salary_advance_paid";
    const sourceEntityType =
      options.paymentKind === "variable"
        ? "employee_variable_earning_payment"
        : "employee_salary_advance";
    const movement = await sql<{ id: string }>`
      insert into cash_bank_movements (
        id, company_id, movement_number, movement_type, movement_date, accounting_date,
        source_cash_account_id, source_bank_account_id, destination_cash_account_id,
        destination_bank_account_id, amount, fee_amount, payment_method, reference_number,
        description, status, correlation_id, idempotency_identity, accounting_event_id,
        confirmed_by_account_id, confirmed_at, created_by_account_id, created_at
      ) select
        ${movementId}::uuid, ${options.companyId}::uuid, ${movementNumber},
        ${movementType}, ${options.paymentDate}::date,
        ${options.paymentDate}::date,
        ${options.paymentMethod === "cash" ? options.fundingAccountId : null}::uuid,
        ${options.paymentMethod === "bank" ? options.fundingAccountId : null}::uuid,
        null::uuid, null::uuid, ${new Decimal(options.amount).toFixed(2)}::numeric,
        '0'::numeric, ${movementPaymentMethod}, ${options.paymentNumber},
        ${`Employee payment ${options.paymentNumber}`}, 'confirmed', ${options.paymentId},
        ${`employee_payment:${options.paymentId}`}, e.id,
        ${options.actorId}::uuid, now(), ${options.actorId}::uuid, now()
      from accounting_events e
      where e.company_id=${options.companyId}::uuid
        and e.event_type=${eventType}
        and e.source_entity_type=${sourceEntityType}
        and e.source_entity_id=${options.paymentId}::uuid
      returning id
    `.execute(transaction);
    if (movement.rows[0] === undefined) {
      throw new ApplicationException(
        "employee_payment_cash_movement_not_created",
        "The Employee payment Cash/Bank Movement could not be created",
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private reasonRequired(): never {
    throw new ApplicationException(
      "payment_reversal_reason_required",
      "A reversal reason is required",
      HttpStatus.BAD_REQUEST,
    );
  }
  private paymentUnavailable(): never {
    throw new ApplicationException(
      "payment_not_available",
      "The payment is not available for reversal",
      HttpStatus.CONFLICT,
    );
  }
}
