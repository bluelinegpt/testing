import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import type {
  CompanyOverviewQueryDto,
  CompanyRankingQueryDto,
  PlatformDashboardQueryDto,
} from "./platform-dashboard.dto.js";

/**
 * The Platform Dashboard — read-only, cross-Company aggregates.
 *
 * ===========================================================================
 * TIMEZONE RULE (documented, not implicit)
 * ===========================================================================
 *
 * BluelineGPT targets the UAE today, and every Company created so far uses
 * `Asia/Dubai` (`company_settings.timezone`, checked against the live data
 * before writing this rule). Rather than mixing per-Company business-day
 * windows into one cross-tenant chart — which would make a single "Last 7
 * Days" bar mean a different real time window per Company — this Dashboard
 * fixes ONE calendar: `from`/`to` are `Asia/Dubai` calendar days for every
 * metric, for every Company, all the time. A future Company outside the UAE
 * would need this revisited; nothing here assumes it silently.
 *
 * This is Option A from the handover brief: Platform executive filters use
 * calendar dates in a fixed timezone. Company-level operational reports
 * keep using their own Company business-day semantics unchanged — this
 * service never touches `BusinessDayService` or any Company's business-day
 * configuration.
 *
 * ===========================================================================
 * WHAT "DELIVERED COD" AND "SERVICE FEES" MEAN HERE
 * ===========================================================================
 *
 * `cod_amount` / `service_fee` are summed only for Orders whose
 * `delivery_status = 'delivered'`, bucketed by `delivered_at` (not
 * `created_at`) falling inside the selected range. That is booked value for
 * deliveries actually completed in the period — not all booked COD, and
 * never called "revenue" (Service Fees are the Company's fee income on an
 * Order, not Platform revenue).
 *
 * ===========================================================================
 * "TOTAL ORDERS" VS "ORDERS TREND"
 * ===========================================================================
 *
 * The `Total Orders` / `Delivered Orders` KPI cards use their own natural
 * timestamp: Total Orders counts by `created_at`, Delivered Orders counts by
 * `delivered_at`. The Orders Trend chart's four series follow the same rule
 * per series: `created` and `delivered` bucket by their own timestamp, while
 * `cancelled`/`returned` bucket by `created_at` because `orders` has no
 * dedicated `cancelled_at`/`returned_at` column — a cancelled/returned count
 * in a bucket means "Orders created in that period whose CURRENT status is
 * cancelled/returned", not "Orders that became cancelled/returned in that
 * period". This is stated in the response `metadata`, not left implicit.
 *
 * ===========================================================================
 * DELIVERY RATE DENOMINATOR
 * ===========================================================================
 *
 * `deliveryRate = deliveredInRange / createdInRange`. Both counts come from
 * different timestamp bases (see above), so the rate can exceed 100% near a
 * period boundary — an Order created just before the window and delivered
 * just inside it. Documented in `metadata.deliveryRateDefinition` rather than
 * silently producing a number that looks wrong with no explanation attached.
 */

const DASHBOARD_TIMEZONE = "Asia/Dubai";
const MAX_RANGE_DAYS = 366;
const NO_ORDERS_ATTENTION_DAYS = 30;

interface RangeBounds {
  readonly from: string;
  readonly to: string;
  readonly days: number;
}

function todayInDubai(): string {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: DASHBOARD_TIMEZONE,
    year: "numeric",
  }).format(new Date());
}

function addDays(isoDate: string, delta: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year as number, (month as number) - 1, day as number));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const start = Date.UTC(fy as number, (fm as number) - 1, fd as number);
  const end = Date.UTC(ty as number, (tm as number) - 1, td as number);
  return Math.round((end - start) / 86_400_000) + 1;
}

function autoGroupBy(days: number): "daily" | "weekly" | "monthly" {
  if (days <= 31) return "daily";
  if (days <= 120) return "weekly";
  return "monthly";
}

const truncUnit: Readonly<Record<"daily" | "weekly" | "monthly", "day" | "week" | "month">> = {
  daily: "day",
  monthly: "month",
  weekly: "week",
};

interface CompanyRow {
  readonly id: string;
  readonly code: string;
  readonly nameEn: string;
  readonly status: string;
  readonly environment: string;
}

@Injectable()
export class PlatformDashboardService {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  // -------------------------------------------------------------------------
  // Shared range resolution
  // -------------------------------------------------------------------------

  /**
   * Resolves `from`/`to` to validated `Asia/Dubai` calendar dates.
   *
   * Defaults to the last 30 days ending today (Dubai) when neither is given —
   * an explicit default, not an unbounded query. A range wider than
   * `MAX_RANGE_DAYS` is rejected rather than silently clamped: silently
   * shrinking a caller's explicit request would produce a chart that looks
   * complete while quietly answering a different question than the one asked.
   */
  private resolveRange(query: PlatformDashboardQueryDto): RangeBounds {
    const today = todayInDubai();
    const to = query.to ?? today;
    const from = query.from ?? addDays(to, -(30 - 1));
    if (from > to) {
      throw new ApplicationException(
        "dashboard_date_range_invalid",
        "The start date must not be after the end date",
        HttpStatus.BAD_REQUEST,
      );
    }
    const days = daysBetween(from, to);
    if (days > MAX_RANGE_DAYS) {
      throw new ApplicationException(
        "dashboard_date_range_too_large",
        `The selected date range spans ${days} days; the Dashboard supports at most ${MAX_RANGE_DAYS}.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    return { days, from, to };
  }

  private previousRange(range: RangeBounds): RangeBounds {
    const to = addDays(range.from, -1);
    const from = addDays(to, -(range.days - 1));
    return { days: range.days, from, to };
  }

  /** `[start, endExclusive)` as `Asia/Dubai`-local instants, in UTC. */
  private bounds(from: string, to: string) {
    return {
      endExclusive: sql`((${addDays(to, 1)}::date)::timestamp at time zone ${DASHBOARD_TIMEZONE})`,
      start: sql`((${from}::date)::timestamp at time zone ${DASHBOARD_TIMEZONE})`,
    };
  }

  private async assertCompanyExists(companyId: string): Promise<CompanyRow> {
    const company = (
      await sql<CompanyRow>`
        select id, code, name_en as "nameEn", status, environment
          from companies where id = ${companyId}::uuid
      `.execute(this.database)
    ).rows[0];
    if (company === undefined) {
      throw new ApplicationException(
        "company_not_found",
        "The requested Company does not exist",
        HttpStatus.NOT_FOUND,
      );
    }
    return company;
  }

  // -------------------------------------------------------------------------
  // Summary (KPI cards)
  // -------------------------------------------------------------------------

  public async summary(query: PlatformDashboardQueryDto): Promise<Record<string, unknown>> {
    const range = this.resolveRange(query);
    const previous = this.previousRange(range);
    const companyId = query.companyId ?? null;
    if (companyId !== null) await this.assertCompanyExists(companyId);
    const { start, endExclusive } = this.bounds(range.from, range.to);
    const previousBounds = this.bounds(previous.from, previous.to);

    const [companyCounts, current, previousTotals, partyCounts] = await Promise.all([
      // Current-state Company counts are never period-scoped: a status is a
      // snapshot of NOW, not something that happened between two dates.
      sql<{
        total: string;
        active: string;
        suspended: string;
        closed: string;
        draft: string;
        disabled: string;
        newThisMonth: string;
      }>`
        select count(*)::bigint as total,
               count(*) filter (where status = 'active')::bigint as active,
               count(*) filter (where status = 'suspended')::bigint as suspended,
               count(*) filter (where status = 'closed')::bigint as closed,
               count(*) filter (where status = 'draft')::bigint as draft,
               count(*) filter (where status = 'disabled')::bigint as disabled,
               count(*) filter (
                 where created_at >= date_trunc('month', now() at time zone ${DASHBOARD_TIMEZONE})
                   at time zone ${DASHBOARD_TIMEZONE}
               )::bigint as "newThisMonth"
          from companies
         where (${companyId}::uuid is null or id = ${companyId}::uuid)
      `.execute(this.database),
      sql<{
        ordersCreated: string;
        delivered: string;
        deliveredCod: string;
        serviceFees: string;
      }>`
        select
          count(*) filter (where created_at >= ${start} and created_at < ${endExclusive})::bigint
            as "ordersCreated",
          count(*) filter (
            where delivery_status = 'delivered' and delivered_at >= ${start} and delivered_at < ${endExclusive}
          )::bigint as delivered,
          coalesce(sum(cod_amount) filter (
            where delivery_status = 'delivered' and delivered_at >= ${start} and delivered_at < ${endExclusive}
          ), 0)::numeric(18,2) as "deliveredCod",
          coalesce(sum(service_fee) filter (
            where delivery_status = 'delivered' and delivered_at >= ${start} and delivered_at < ${endExclusive}
          ), 0)::numeric(18,2) as "serviceFees"
        from orders
        where (${companyId}::uuid is null or company_id = ${companyId}::uuid)
          and (
            (created_at >= ${start} and created_at < ${endExclusive})
            or (delivered_at >= ${start} and delivered_at < ${endExclusive})
          )
      `.execute(this.database),
      sql<{
        ordersCreated: string;
        deliveredCod: string;
        serviceFees: string;
        newTraders: string;
        newCustomers: string;
      }>`
        select
          (select count(*) from orders
            where (${companyId}::uuid is null or company_id = ${companyId}::uuid)
              and created_at >= ${previousBounds.start} and created_at < ${previousBounds.endExclusive}
          )::bigint as "ordersCreated",
          (select coalesce(sum(cod_amount), 0) from orders
            where (${companyId}::uuid is null or company_id = ${companyId}::uuid)
              and delivery_status = 'delivered'
              and delivered_at >= ${previousBounds.start} and delivered_at < ${previousBounds.endExclusive}
          )::numeric(18,2) as "deliveredCod",
          (select coalesce(sum(service_fee), 0) from orders
            where (${companyId}::uuid is null or company_id = ${companyId}::uuid)
              and delivery_status = 'delivered'
              and delivered_at >= ${previousBounds.start} and delivered_at < ${previousBounds.endExclusive}
          )::numeric(18,2) as "serviceFees",
          (select count(*) from traders
            where (${companyId}::uuid is null or company_id = ${companyId}::uuid)
              and created_at >= ${previousBounds.start} and created_at < ${previousBounds.endExclusive}
          )::bigint as "newTraders",
          (select count(*) from customers
            where (${companyId}::uuid is null or company_id = ${companyId}::uuid)
              and created_at >= ${previousBounds.start} and created_at < ${previousBounds.endExclusive}
          )::bigint as "newCustomers"
      `.execute(this.database),
      // Traders/Customers/Drivers/Employees are CURRENT total counts, scoped
      // to the selected Company when one is chosen. Not period-based — see
      // `platform-dashboard.dto.ts` header and the Customer-counting note
      // below.
      sql<{
        traders: string;
        customers: string;
        drivers: string;
        employees: string;
        activeTraders: string;
        newTraders: string;
        newCustomers: string;
        newDrivers: string;
        newEmployees: string;
      }>`
        select
          (select count(*) from traders
            where ${companyId}::uuid is null or company_id = ${companyId}::uuid)::bigint as traders,
          (select count(*) from traders
            where account_status = 'active'
              and (${companyId}::uuid is null or company_id = ${companyId}::uuid))::bigint as "activeTraders",
          (select count(*) from customers
            where ${companyId}::uuid is null or company_id = ${companyId}::uuid)::bigint as customers,
          (select count(*) from drivers
            where ${companyId}::uuid is null or company_id = ${companyId}::uuid)::bigint as drivers,
          (select count(*) from employees
            where ${companyId}::uuid is null or company_id = ${companyId}::uuid)::bigint as employees,
          (select count(*) from traders
            where created_at >= ${start} and created_at < ${endExclusive}
              and (${companyId}::uuid is null or company_id = ${companyId}::uuid))::bigint as "newTraders",
          (select count(*) from customers
            where created_at >= ${start} and created_at < ${endExclusive}
              and (${companyId}::uuid is null or company_id = ${companyId}::uuid))::bigint as "newCustomers",
          (select count(*) from drivers
            where created_at >= ${start} and created_at < ${endExclusive}
              and (${companyId}::uuid is null or company_id = ${companyId}::uuid))::bigint as "newDrivers",
          (select count(*) from employees
            where created_at >= ${start} and created_at < ${endExclusive}
              and (${companyId}::uuid is null or company_id = ${companyId}::uuid))::bigint as "newEmployees"
      `.execute(this.database),
    ]);

    const companies = companyCounts.rows[0];
    const totals = current.rows[0];
    const prior = previousTotals.rows[0];
    const parties = partyCounts.rows[0];

    const change = (nowValue: number, thenValue: number): { percent: number | null; label: string } => {
      if (thenValue === 0) return { label: nowValue === 0 ? "No change" : "New", percent: null };
      const percent = ((nowValue - thenValue) / thenValue) * 100;
      return { label: `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`, percent };
    };

    const ordersNow = Number(totals?.ordersCreated ?? 0);
    const deliveredNow = Number(totals?.delivered ?? 0);
    const codNow = Number(totals?.deliveredCod ?? 0);
    const feesNow = Number(totals?.serviceFees ?? 0);
    const companyTotal = Number(companies?.total ?? 0);

    return {
      companies: {
        active: Number(companies?.active ?? 0),
        activePercent: percentOf(Number(companies?.active ?? 0), companyTotal),
        closed: Number(companies?.closed ?? 0),
        closedPercent: percentOf(Number(companies?.closed ?? 0), companyTotal),
        draft: Number(companies?.draft ?? 0),
        disabled: Number(companies?.disabled ?? 0),
        newThisMonth: Number(companies?.newThisMonth ?? 0),
        suspended: Number(companies?.suspended ?? 0),
        suspendedPercent: percentOf(Number(companies?.suspended ?? 0), companyTotal),
        total: companyTotal,
      },
      customers: { new: Number(parties?.newCustomers ?? 0), total: Number(parties?.customers ?? 0) },
      drivers: { new: Number(parties?.newDrivers ?? 0), total: Number(parties?.drivers ?? 0) },
      employees: { new: Number(parties?.newEmployees ?? 0), total: Number(parties?.employees ?? 0) },
      filters: { companyId, from: range.from, to: range.to },
      metadata: {
        codBasis: "delivered_orders_only",
        customerCountingNote:
          "Total Customers means total Company Customer records, one per Company. The same real person may appear in more than one Company and is not deduplicated in this phase.",
        deliveryRateDefinition: "delivered (by delivered_at in range) / orders created (by created_at in range)",
        previousPeriod: { from: previous.from, to: previous.to },
        serviceFeeBasis: "delivered_orders_only",
        timezone: DASHBOARD_TIMEZONE,
      },
      orders: {
        cod: codNow,
        codChange: change(codNow, Number(prior?.deliveredCod ?? 0)),
        delivered: deliveredNow,
        deliveryRate: ordersNow === 0 ? null : Math.round((deliveredNow / ordersNow) * 1000) / 10,
        serviceFees: feesNow,
        serviceFeesChange: change(feesNow, Number(prior?.serviceFees ?? 0)),
        total: ordersNow,
        totalChange: change(ordersNow, Number(prior?.ordersCreated ?? 0)),
      },
      traders: {
        active: Number(parties?.activeTraders ?? 0),
        new: Number(parties?.newTraders ?? 0),
        total: Number(parties?.traders ?? 0),
      },
    };
  }

  // -------------------------------------------------------------------------
  // Orders Trend
  // -------------------------------------------------------------------------

  public async ordersTrend(query: PlatformDashboardQueryDto): Promise<Record<string, unknown>> {
    const range = this.resolveRange(query);
    const companyId = query.companyId ?? null;
    const groupBy = query.groupBy ?? autoGroupBy(range.days);
    const unit = truncUnit[groupBy];
    const { start, endExclusive } = this.bounds(range.from, range.to);

    const [created, delivered, cancelled, returned] = await Promise.all([
      sql<{ bucket: string; n: string }>`
        select (date_trunc(${unit}, created_at at time zone ${DASHBOARD_TIMEZONE}))::date::text as bucket,
               count(*)::bigint as n
          from orders
         where created_at >= ${start} and created_at < ${endExclusive}
           and (${companyId}::uuid is null or company_id = ${companyId}::uuid)
         group by 1 order by 1
      `.execute(this.database),
      sql<{ bucket: string; n: string }>`
        select (date_trunc(${unit}, delivered_at at time zone ${DASHBOARD_TIMEZONE}))::date::text as bucket,
               count(*)::bigint as n
          from orders
         where delivery_status = 'delivered'
           and delivered_at >= ${start} and delivered_at < ${endExclusive}
           and (${companyId}::uuid is null or company_id = ${companyId}::uuid)
         group by 1 order by 1
      `.execute(this.database),
      sql<{ bucket: string; n: string }>`
        select (date_trunc(${unit}, created_at at time zone ${DASHBOARD_TIMEZONE}))::date::text as bucket,
               count(*)::bigint as n
          from orders
         where delivery_status = 'cancelled'
           and created_at >= ${start} and created_at < ${endExclusive}
           and (${companyId}::uuid is null or company_id = ${companyId}::uuid)
         group by 1 order by 1
      `.execute(this.database),
      sql<{ bucket: string; n: string }>`
        select (date_trunc(${unit}, created_at at time zone ${DASHBOARD_TIMEZONE}))::date::text as bucket,
               count(*)::bigint as n
          from orders
         where delivery_status = 'returned'
           and created_at >= ${start} and created_at < ${endExclusive}
           and (${companyId}::uuid is null or company_id = ${companyId}::uuid)
         group by 1 order by 1
      `.execute(this.database),
    ]);

    const points = bucketSeries(range.from, range.to, groupBy);
    const index = (rows: readonly { bucket: string; n: string }[]): Map<string, number> =>
      new Map(rows.map((row) => [row.bucket.slice(0, 10), Number(row.n)]));
    const createdIndex = index(created.rows);
    const deliveredIndex = index(delivered.rows);
    const cancelledIndex = index(cancelled.rows);
    const returnedIndex = index(returned.rows);

    return {
      filters: { companyId, from: range.from, to: range.to, groupBy },
      metadata: {
        seriesBasis: {
          cancelled: "created_at (current status snapshot; no cancelled_at column exists)",
          created: "created_at",
          delivered: "delivered_at",
          returned: "created_at (current status snapshot; no returned_at column exists)",
        },
        timezone: DASHBOARD_TIMEZONE,
      },
      series: points.map((bucket) => ({
        bucket,
        cancelled: cancelledIndex.get(bucket) ?? 0,
        created: createdIndex.get(bucket) ?? 0,
        delivered: deliveredIndex.get(bucket) ?? 0,
        returned: returnedIndex.get(bucket) ?? 0,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Order Status Distribution
  // -------------------------------------------------------------------------

  public async orderStatusDistribution(query: PlatformDashboardQueryDto): Promise<Record<string, unknown>> {
    const range = this.resolveRange(query);
    const companyId = query.companyId ?? null;
    const { start, endExclusive } = this.bounds(range.from, range.to);

    const rows = (
      await sql<{ status: string; n: string }>`
        select delivery_status as status, count(*)::bigint as n
          from orders
         where created_at >= ${start} and created_at < ${endExclusive}
           and (${companyId}::uuid is null or company_id = ${companyId}::uuid)
         group by 1
      `.execute(this.database)
    ).rows;
    const total = rows.reduce((sum, row) => sum + Number(row.n), 0);

    return {
      filters: { companyId, from: range.from, to: range.to },
      // Live enum values from `orders_delivery_status_check`, not the
      // mockup's labels — the mockup's "Assigned to Driver" / "Out for
      // Delivery" map to `assigned` / `out_for_delivery` here.
      items: rows
        .map((row) => ({
          count: Number(row.n),
          percent: percentOf(Number(row.n), total),
          status: row.status,
        }))
        .sort((a, b) => b.count - a.count),
      total,
    };
  }

  // -------------------------------------------------------------------------
  // Top Companies by Orders (and other metrics, same query)
  // -------------------------------------------------------------------------

  public async companyRanking(query: CompanyRankingQueryDto): Promise<Record<string, unknown>> {
    const range = this.resolveRange(query);
    const companyId = query.companyId ?? null;
    const metric = query.metric ?? "orders";
    const limit = query.limit ?? 10;
    const { start, endExclusive } = this.bounds(range.from, range.to);

    const rows = (
      await sql<{
        id: string;
        code: string;
        nameEn: string;
        status: string;
        environment: string;
        orders: string;
        delivered: string;
        cod: string;
        serviceFees: string;
        traders: string;
        customers: string;
      }>`
        select c.id, c.code, c.name_en as "nameEn", c.status, c.environment,
               coalesce(o.n, 0)::bigint as orders,
               coalesce(o.delivered, 0)::bigint as delivered,
               coalesce(o.cod, 0)::numeric(18,2) as cod,
               coalesce(o.fees, 0)::numeric(18,2) as "serviceFees",
               (select count(*) from traders t where t.company_id = c.id)::bigint as traders,
               (select count(*) from customers cu where cu.company_id = c.id)::bigint as customers
          from companies c
          left join lateral (
            select count(*) as n,
                   count(*) filter (where delivery_status = 'delivered') as delivered,
                   sum(cod_amount) filter (where delivery_status = 'delivered') as cod,
                   sum(service_fee) filter (where delivery_status = 'delivered') as fees
              from orders
             where company_id = c.id and created_at >= ${start} and created_at < ${endExclusive}
          ) o on true
         where ${companyId}::uuid is null or c.id = ${companyId}::uuid
         order by ${sql.raw(rankingSortColumns[metric] ?? rankingSortColumns.orders)} desc, c.code asc
         limit ${limit}
      `.execute(this.database)
    ).rows;

    return {
      filters: { companyId, from: range.from, to: range.to, limit, metric },
      items: rows.map((row) => ({
        cod: Number(row.cod),
        customers: Number(row.customers),
        delivered: Number(row.delivered),
        environment: row.environment,
        id: row.id,
        name: row.nameEn,
        code: row.code,
        orders: Number(row.orders),
        serviceFees: Number(row.serviceFees),
        status: row.status,
        traders: Number(row.traders),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Companies by Status / Environment (current-state, not period-scoped)
  // -------------------------------------------------------------------------

  public async companiesByStatus(query: PlatformDashboardQueryDto): Promise<Record<string, unknown>> {
    return this.currentStateDistribution("status", query.companyId ?? null);
  }

  public async companiesByEnvironment(query: PlatformDashboardQueryDto): Promise<Record<string, unknown>> {
    return this.currentStateDistribution("environment", query.companyId ?? null);
  }

  private async currentStateDistribution(
    column: "status" | "environment",
    companyId: string | null,
  ): Promise<Record<string, unknown>> {
    const rows = (
      await sql<{ value: string; n: string }>`
        select ${sql.raw(column)} as value, count(*)::bigint as n
          from companies
         where ${companyId}::uuid is null or id = ${companyId}::uuid
         group by 1
      `.execute(this.database)
    ).rows;
    const total = rows.reduce((sum, row) => sum + Number(row.n), 0);
    return {
      basis: "current_state",
      items: rows
        .map((row) => ({ count: Number(row.n), percent: percentOf(Number(row.n), total), value: row.value }))
        .sort((a, b) => b.count - a.count),
      total,
    };
  }

  // -------------------------------------------------------------------------
  // Orders by Emirate
  // -------------------------------------------------------------------------

  public async ordersByEmirate(query: PlatformDashboardQueryDto): Promise<Record<string, unknown>> {
    const range = this.resolveRange(query);
    const companyId = query.companyId ?? null;
    const { start, endExclusive } = this.bounds(range.from, range.to);

    const rows = (
      await sql<{ emirate: string; n: string }>`
        select coalesce(e.name_en, 'Other / Unknown') as emirate, count(o.id)::bigint as n
          from orders o
          left join areas a on a.id = o.area_id
          left join emirates e on e.id = a.emirate_id
         where o.created_at >= ${start} and o.created_at < ${endExclusive}
           and (${companyId}::uuid is null or o.company_id = ${companyId}::uuid)
         group by 1
      `.execute(this.database)
    ).rows;
    const total = rows.reduce((sum, row) => sum + Number(row.n), 0);

    return {
      filters: { companyId, from: range.from, to: range.to },
      items: rows
        .map((row) => ({ count: Number(row.n), emirate: row.emirate, percent: percentOf(Number(row.n), total) }))
        .sort((a, b) => b.count - a.count),
      total,
    };
  }

  // -------------------------------------------------------------------------
  // Company Overview table
  // -------------------------------------------------------------------------

  public async companyOverview(query: CompanyOverviewQueryDto): Promise<Record<string, unknown>> {
    const range = this.resolveRange(query);
    const companyId = query.companyId ?? null;
    const search = query.search?.trim() ?? "";
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;
    const column = overviewSortColumns[query.sort ?? "orders"] ?? overviewSortColumns.orders;
    const direction = query.direction === "asc" ? sql`asc` : sql`desc`;
    const { start, endExclusive } = this.bounds(range.from, range.to);

    const filters = sql`
      where (${companyId}::uuid is null or c.id = ${companyId}::uuid)
        and (${search} = '' or c.name_en ilike ${`%${search}%`} or c.code ilike ${`%${search}%`})
    `;

    const total = Number(
      (
        await sql<{ n: string }>`select count(*)::bigint n from companies c ${filters}`.execute(this.database)
      ).rows[0]?.n ?? 0,
    );

    const rows = (
      await sql<{
        id: string;
        code: string;
        nameEn: string;
        status: string;
        environment: string;
        orders: string;
        delivered: string;
        cod: string;
        traders: string;
        customers: string;
        drivers: string;
        lastOrderAt: string | null;
      }>`
        select c.id, c.code, c.name_en as "nameEn", c.status, c.environment,
               coalesce(o.n, 0)::bigint as orders,
               coalesce(o.delivered, 0)::bigint as delivered,
               coalesce(o.cod, 0)::numeric(18,2) as cod,
               (select count(*) from traders t where t.company_id = c.id)::bigint as traders,
               (select count(*) from customers cu where cu.company_id = c.id)::bigint as customers,
               (select count(*) from drivers d where d.company_id = c.id)::bigint as drivers,
               (select max(o2.created_at) from orders o2 where o2.company_id = c.id) as "lastOrderAt"
          from companies c
          left join lateral (
            select count(*) as n,
                   count(*) filter (where delivery_status = 'delivered') as delivered,
                   sum(cod_amount) filter (where delivery_status = 'delivered') as cod
              from orders
             where company_id = c.id and created_at >= ${start} and created_at < ${endExclusive}
          ) o on true
          ${filters}
         order by ${sql.raw(column)} ${direction}, c.code asc
         limit ${pageSize} offset ${(page - 1) * pageSize}
      `.execute(this.database)
    ).rows;

    return {
      filters: { companyId, from: range.from, to: range.to, search },
      items: rows.map((row) => ({
        cod: Number(row.cod),
        customers: Number(row.customers),
        delivered: Number(row.delivered),
        drivers: Number(row.drivers),
        environment: row.environment,
        id: row.id,
        code: row.code,
        lastOrderAt: row.lastOrderAt,
        name: row.nameEn,
        orders: Number(row.orders),
        status: row.status,
        traders: Number(row.traders),
      })),
      page,
      pageSize,
      total,
    };
  }

  // -------------------------------------------------------------------------
  // Needs Attention
  // -------------------------------------------------------------------------

  /**
   * Only alerts derivable from real, existing data. No WhatsApp/payment-
   * gateway/trial-expiry alerts: nothing in the schema backs them yet (see
   * `platform-dashboard.dto.ts` and the completion report's Deferred
   * Capabilities section).
   */
  public async needsAttention(): Promise<Record<string, unknown>> {
    const today = todayInDubai();
    const { start: cutoff } = this.bounds(addDays(today, -(NO_ORDERS_ATTENTION_DAYS - 1)), today);

    const [inactive, suspended, closed, draft, deletionIssues, accountingIncomplete] = await Promise.all([
      sql<CompanyRow>`
        select c.id, c.code, c.name_en as "nameEn", c.status, c.environment
          from companies c
         where c.status = 'active'
           and not exists (
             select 1 from orders o where o.company_id = c.id and o.created_at >= ${cutoff}
           )
         order by c.name_en
         limit 20
      `.execute(this.database),
      sql<{ n: string }>`select count(*)::bigint n from companies where status = 'suspended'`.execute(
        this.database,
      ),
      sql<{ n: string }>`select count(*)::bigint n from companies where status = 'closed'`.execute(
        this.database,
      ),
      sql<CompanyRow>`
        select id, code, name_en as "nameEn", status, environment
          from companies where status = 'draft'
         order by created_at desc limit 20
      `.execute(this.database),
      sql<{ id: string; companyCodeSnapshot: string; companyNameSnapshot: string; state: string }>`
        select id, company_code_snapshot as "companyCodeSnapshot",
               company_name_snapshot as "companyNameSnapshot", state
          from platform_company_deletion_operations
         where state in ('failed', 'completed_cleanup_pending')
         order by updated_at desc
         limit 20
      `.execute(this.database),
      sql<CompanyRow>`
        select id, code, name_en as "nameEn", status, environment
          from companies
         where status in ('draft', 'active') and accounting_setup_status <> 'ready'
         order by created_at desc limit 20
      `.execute(this.database),
    ]);

    return {
      categories: [
        {
          companies: inactive.rows.map(toCompanyRef),
          count: inactive.rows.length,
          key: "no_recent_orders",
          label: `No Orders in the last ${NO_ORDERS_ATTENTION_DAYS} days`,
          severity: "warning",
        },
        {
          companies: [],
          count: Number(suspended.rows[0]?.n ?? 0),
          key: "suspended",
          label: "Suspended Companies",
          severity: "critical",
        },
        {
          companies: [],
          count: Number(closed.rows[0]?.n ?? 0),
          key: "closed",
          label: "Closed Companies",
          severity: "info",
        },
        {
          companies: draft.rows.map(toCompanyRef),
          count: draft.rows.length,
          key: "onboarding_incomplete",
          label: "Onboarding incomplete (Draft)",
          severity: "info",
        },
        {
          companies: accountingIncomplete.rows.map(toCompanyRef),
          count: accountingIncomplete.rows.length,
          key: "accounting_setup_incomplete",
          label: "Accounting configuration incomplete",
          severity: "warning",
        },
        {
          companies: deletionIssues.rows.map((row) => ({
            code: row.companyCodeSnapshot,
            id: row.id,
            name: `${row.companyNameSnapshot} (${row.state})`,
          })),
          count: deletionIssues.rows.length,
          key: "deletion_operation_needs_attention",
          label: "Deletion operations failed / cleanup pending",
          severity: "critical",
        },
      ],
      generatedAt: new Date().toISOString(),
    };
  }
}

const rankingSortColumns: Readonly<
  Record<"cod" | "customers" | "delivered" | "orders" | "serviceFees" | "traders", string>
> = {
  cod: "cod",
  customers: "customers",
  delivered: "delivered",
  orders: "orders",
  serviceFees: "\"serviceFees\"",
  traders: "traders",
};

const overviewSortColumns: Readonly<
  Record<"cod" | "customers" | "delivered" | "drivers" | "lastOrder" | "name" | "orders" | "traders", string>
> = {
  cod: "cod",
  customers: "customers",
  delivered: "delivered",
  drivers: "drivers",
  lastOrder: "\"lastOrderAt\"",
  name: "c.name_en",
  orders: "orders",
  traders: "traders",
};

function percentOf(count: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((count / total) * 1000) / 10;
}

function toCompanyRef(row: CompanyRow): { id: string; code: string; name: string } {
  return { code: row.code, id: row.id, name: row.nameEn };
}

/** Dense bucket list so a chart never silently skips a zero period. */
function bucketSeries(from: string, to: string, groupBy: "daily" | "weekly" | "monthly"): string[] {
  const points: string[] = [];
  let cursor = alignBucketStart(from, groupBy);
  const stop = new Date(`${to}T00:00:00Z`).getTime();
  let guard = 0;
  while (new Date(`${cursor}T00:00:00Z`).getTime() <= stop && guard < 400) {
    points.push(cursor);
    cursor = advanceBucket(cursor, groupBy);
    guard += 1;
  }
  return points;
}

function alignBucketStart(from: string, groupBy: "daily" | "weekly" | "monthly"): string {
  if (groupBy === "monthly") return `${from.slice(0, 7)}-01`;
  if (groupBy === "daily") return from;
  // Weekly buckets align to Monday, matching Postgres `date_trunc('week', ...)`.
  const date = new Date(`${from}T00:00:00Z`);
  const isoDayOfWeek = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (isoDayOfWeek - 1));
  return date.toISOString().slice(0, 10);
}

function advanceBucket(bucket: string, groupBy: "daily" | "weekly" | "monthly"): string {
  if (groupBy === "daily") return addDays(bucket, 1);
  if (groupBy === "weekly") return addDays(bucket, 7);
  const [year, month] = bucket.split("-").map(Number);
  const date = new Date(Date.UTC(year as number, (month as number) - 1 + 1, 1));
  return date.toISOString().slice(0, 10);
}
