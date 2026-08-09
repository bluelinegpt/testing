import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

type Database = Kysely<DatabaseSchema>;

/** What one delivered Order earned one Employee. */
export interface EmployeeOrderEarning {
  readonly appliedAmount: string;
  readonly deliveredAt: string;
  readonly earningMonth: string;
  readonly employeeId: string;
  readonly id: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly ruleId: string;
}

/** The rule in force for one Employee at one instant. */
interface ApplicableRule {
  readonly amountPerOrder: string;
  readonly id: string;
}

/**
 * Accrues employee earnings for delivered Orders.
 *
 * Deliberately narrow: it decides whether an Employee earned something for one
 * delivery and records it. It does not pay, does not post, and raises no
 * Accounting Event or Journal — payment stays with the existing cash-only
 * payroll flow.
 *
 * ---------------------------------------------------------------------------
 * WHY delivered_at AND NOT delivery_status
 * ---------------------------------------------------------------------------
 *
 * The earning is owed because a delivery happened. An Order later returned or
 * cancelled still WAS delivered, and the Employee still did the work, so the
 * gate is the authoritative timestamp rather than the current status. An Order
 * that never reached a customer has no `delivered_at` and earns nothing.
 *
 * This is the same rule Delivery Activity uses, for the same reason.
 */
@Injectable()
export class EmployeeDeliveryEarningService {
  public constructor(
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
  ) {}

  /**
   * Record the earning for one delivered Order, if one is owed.
   *
   * The Employee is resolved FROM the Order — assigned Driver, employee Drivers
   * only — rather than passed in, so a caller cannot credit the wrong person.
   *
   * Returns `null` when nothing is owed: no delivery timestamp, no employee
   * Driver on the Order, or no rule covering that Employee at that moment. All
   * ordinary outcomes, not failures — most Employees are not enrolled.
   *
   * Idempotent, and idempotent in the useful direction. A replayed delivery
   * returns the EXISTING earning rather than null, so a caller can tell "already
   * recorded" apart from "nothing owed". The guarantee rests on the
   * `(company_id, order_id, employee_id, rule_id)` unique constraint rather than
   * a prior read — a check-then-insert would still race.
   */
  public async accrueForDelivery(
    database: Database,
    orderId: string,
  ): Promise<EmployeeOrderEarning | null> {
    const { companyId } = this.tenants.current();
    const order = await this.deliveredOrder(database, companyId, orderId);
    if (order === null) return null;
    // The Employee is derived from the Order, never supplied by the caller: an
    // earning must belong to whoever actually made the delivery.
    const employeeId = order.employeeId;
    if (employeeId === null) return null;

    const rule = await this.applicableRule(
      database,
      companyId,
      employeeId,
      order.deliveredAt,
      order.serviceType,
    );
    if (rule === null) return null;

    // The Company-local calendar month of the delivery. Resolved here rather
    // than in SQL: a UTC month boundary would move deliveries before 04:00
    // Dubai into the previous month on the first of every month.
    const earningMonth = await this.localEarningMonth(database, companyId, order.deliveredAt);

    const inserted = await sql<EmployeeOrderEarning>`
      insert into employee_order_earnings (
        company_id, employee_id, order_id, rule_id,
        order_number, delivered_at, applied_amount, earning_month
      ) values (
        ${companyId}::uuid, ${employeeId}::uuid, ${orderId}::uuid, ${rule.id}::uuid,
        ${order.orderNumber}, ${order.deliveredAt}::timestamptz,
        ${new Decimal(rule.amountPerOrder).toFixed(2)}, ${earningMonth}::date
      )
      -- Already recorded for this Order, Employee and rule. A no-op UPDATE of
      -- an immutable column, so the existing row is RETURNED rather than
      -- swallowed: DO NOTHING returns no rows, which a caller cannot tell
      -- apart from "nothing was owed". order_id is part of the conflict
      -- target, so this rewrites the value it already holds and changes
      -- nothing. The snapshot columns are deliberately left alone.
      on conflict (company_id, order_id, employee_id, rule_id)
        do update set order_id = employee_order_earnings.order_id
      returning id, employee_id as "employeeId", order_id as "orderId",
                rule_id as "ruleId", order_number as "orderNumber",
                delivered_at::text as "deliveredAt",
                applied_amount::text as "appliedAmount",
                earning_month::text as "earningMonth"
    `.execute(database);
    return inserted.rows[0] ?? null;
  }

  /**
   * The Order, only if it actually reached a customer.
   *
   * Returns null rather than throwing when `delivered_at` is absent: asking
   * about an undelivered Order is a normal question with a normal answer.
   */
  private async deliveredOrder(
    database: Database,
    companyId: string,
    orderId: string,
  ): Promise<{
    readonly deliveredAt: string;
    readonly employeeId: string | null;
    readonly orderNumber: string;
    readonly serviceType: string | null;
  } | null> {
    const result = await sql<{
      deliveredAt: string | null;
      employeeId: string | null;
      orderNumber: string;
      serviceType: string | null;
    }>`
      select o.order_number as "orderNumber",
             o.delivered_at::text as "deliveredAt",
             -- Only an EMPLOYEE Driver earns this. Outsourced Drivers are paid
             -- through the separate fee-accrual flow, and routing them here
             -- would pay the same work twice under two models.
             case when d.driver_type = 'employee' then d.employee_id else null end as "employeeId",
             null::text as "serviceType"
        from orders o
        left join drivers d on d.id = o.assigned_driver_id and d.company_id = o.company_id
       where o.id = ${orderId}::uuid and o.company_id = ${companyId}::uuid
    `.execute(database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException("order_not_found", "Order not found", HttpStatus.NOT_FOUND);
    }
    if (row.deliveredAt === null) return null;
    return {
      deliveredAt: row.deliveredAt,
      employeeId: row.employeeId,
      orderNumber: row.orderNumber,
      serviceType: row.serviceType,
    };
  }

  /**
   * The rule covering this Employee at the delivery instant.
   *
   * Resolved by the DELIVERY date, never by today: that is what stops a rate
   * change in March from restating February. A service-type-specific rule wins
   * over an all-service rule, so a Company can set a general rate and override
   * it for one service without deleting anything.
   */
  private async applicableRule(
    database: Database,
    companyId: string,
    employeeId: string,
    deliveredAt: string,
    serviceType: string | null,
  ): Promise<ApplicableRule | null> {
    const result = await sql<ApplicableRule>`
      select r.id, r.amount_per_order::text as "amountPerOrder"
        from employee_delivery_earning_rules r
       where r.company_id = ${companyId}::uuid
         and r.employee_id = ${employeeId}::uuid
         and r.is_active
         and r.effective_from <= ${deliveredAt}::timestamptz::date
         and (r.effective_to is null or ${deliveredAt}::timestamptz::date < r.effective_to)
         and (r.service_type is null or r.service_type = ${serviceType}::text)
       order by (r.service_type is not null) desc
       limit 1
    `.execute(database);
    return result.rows[0] ?? null;
  }

  /** First day of the Company-local calendar month of the delivery. */
  private async localEarningMonth(
    database: Database,
    companyId: string,
    deliveredAt: string,
  ): Promise<string> {
    const settings = await sql<{ timezone: string }>`
      select timezone from company_settings where company_id = ${companyId}::uuid
    `.execute(database);
    const timezone = settings.rows[0]?.timezone ?? "Asia/Dubai";
    const parts = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "2-digit",
      timeZone: timezone,
      year: "numeric",
    })
      .formatToParts(new Date(deliveredAt))
      .reduce<Record<string, string>>((result, part) => {
        result[part.type] = part.value;
        return result;
      }, {});
    return `${parts.year}-${parts.month}-01`;
  }
}
