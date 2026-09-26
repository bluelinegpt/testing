import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

/**
 * Unified Payment Position — read-only.
 *
 * ===========================================================================
 * THIS IS A VIEW, NOT A LEDGER
 * ===========================================================================
 *
 * Nothing here is stored, posted, or reconciled. Every figure is read live from
 * the table that already owns it, and the service writes to nothing.
 *
 * That is the whole design constraint. The tempting alternative -- a
 * `payment_positions` table kept in step by triggers or a nightly job -- would
 * be a SECOND set of financial numbers, and the day it drifted from the first
 * nobody would be able to say which was right. Reading the owning table means
 * this report cannot be stale and cannot be wrong independently of its source.
 *
 * It also never touches `journal_lines` or `chart_of_accounts`. Posted
 * accounting balances are the Trial Balance's answer to a different question,
 * and recomputing them here would produce a third number for the same money.
 * This report answers the OPERATIONAL question -- who owes us, whom do we owe,
 * and how much is still outstanding -- from the operational records.
 *
 * ===========================================================================
 * DIRECTION IS A PROPERTY OF THE SOURCE, NOT OF THE SIGN
 * ===========================================================================
 *
 * Every amount is stored and returned as a POSITIVE magnitude, with
 * `direction` saying which way it points. A payable of 100 and a receivable of
 * 100 are both `100`, never `100` and `-100`.
 *
 * Mixing signs into the amount is how a "total outstanding" silently becomes a
 * net figure that means nothing: a Company owed 10,000 and owing 10,000 is not
 * in a zero position, it has two problems. The one place a sign appears is the
 * running balance, where it is applied explicitly and documented.
 *
 * ===========================================================================
 * THERE IS NO DUE DATE IN THIS DATABASE
 * ===========================================================================
 *
 * No source table has a `due_date` column -- not receivables, not settlements,
 * not payroll, not fee accruals, not expenses. Payment terms are not modelled.
 *
 * So "overdue" cannot be read; it can only be defined. This service defines it
 * as an AGEING threshold -- outstanding for more than `overdueAfterDays` -- and
 * returns the derived date in `dueDate` alongside a `dueDateBasis` of
 * `derived_from_ageing` so no caller can mistake it for a term the Company
 * agreed. The threshold is a request parameter rather than a constant, because
 * a policy invented by a report should be visible and adjustable, not buried.
 */

export type PaymentPositionDirection = "payable" | "receivable";

export type PaymentPositionPartyType = "driver" | "employee" | "supplier" | "trader";

export interface PaymentPositionFilters {
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly direction?: PaymentPositionDirection;
  readonly limit?: number;
  readonly offset?: number;
  readonly overdueAfterDays?: number;
  readonly overdueOnly?: boolean;
  readonly outstandingOnly?: boolean;
  readonly partyId?: string;
  readonly partyType?: PaymentPositionPartyType;
  readonly sortBy?: string;
  readonly sortDirection?: string;
}

export interface PaymentPositionPartySummary {
  readonly direction: PaymentPositionDirection;
  readonly lastMovementDate: string | null;
  readonly originalAmount: string;
  readonly outstandingAmount: string;
  readonly overdueAmount: string;
  readonly partyId: string | null;
  readonly partyName: string | null;
  readonly partyReference: string | null;
  readonly partyType: PaymentPositionPartyType;
  readonly runningBalance: string;
  readonly settledAmount: string;
  readonly transactionCount: number;
}

export interface PaymentPositionTransaction {
  readonly accountingEventId: string | null;
  readonly direction: PaymentPositionDirection;
  readonly dueDate: string | null;
  readonly isOverdue: boolean;
  readonly journalEntryId: string | null;
  readonly journalNumber: string | null;
  readonly originalAmount: string;
  readonly outstandingAmount: string;
  readonly partyId: string | null;
  readonly partyName: string | null;
  readonly partyType: PaymentPositionPartyType;
  readonly runningBalance: string;
  readonly settledAmount: string;
  readonly sourceId: string;
  readonly sourceReference: string;
  readonly status: string;
  readonly transactionDate: string;
  readonly transactionType: string;
}

export interface PaymentPositionMetadata {
  readonly dueDateBasis: "derived_from_ageing";
  readonly dueDateNote: string;
  readonly overdueAfterDays: number;
  readonly sources: readonly {
    readonly direction: PaymentPositionDirection;
    readonly partyType: PaymentPositionPartyType;
    readonly table: string;
    readonly transactionType: string;
  }[];
}

/** Safety ceiling for one export. Reported when reached, never silent. */
const exportRowLimit = 50_000;

/** Page ceiling for the interactive endpoints. Export raises it deliberately. */
const pageLimit = 200;

/** Default ageing threshold. A visible policy, overridable per request. */
const defaultOverdueAfterDays = 30;

/** What each obligation source contributes. Mirrors the CTE below exactly. */
const sourceDeclarations: PaymentPositionMetadata["sources"] = [
  {
    direction: "receivable",
    partyType: "trader",
    table: "trader_receivables",
    transactionType: "trader_receivable",
  },
  {
    direction: "receivable",
    partyType: "driver",
    table: "orders",
    transactionType: "driver_cash_pending",
  },
  {
    direction: "payable",
    partyType: "trader",
    table: "orders",
    transactionType: "trader_settlement_due",
  },
  {
    direction: "payable",
    partyType: "employee",
    table: "payroll_entries",
    transactionType: "payroll_entry",
  },
  {
    direction: "payable",
    partyType: "driver",
    table: "outsourced_driver_fee_accruals",
    transactionType: "outsourced_driver_fee",
  },
  {
    direction: "payable",
    partyType: "supplier",
    table: "general_expenses",
    transactionType: "general_expense",
  },
];

const partySortColumns: Readonly<Record<string, string>> = {
  originalAmount: "original_amount",
  outstandingAmount: "outstanding_amount",
  overdueAmount: "overdue_amount",
  partyName: "party_name",
  transactionCount: "transaction_count",
};

const transactionSortColumns: Readonly<Record<string, string>> = {
  originalAmount: "original_amount",
  outstandingAmount: "outstanding_amount",
  partyName: "party_name",
  transactionDate: "transaction_date",
};

@Injectable()
export class PaymentPositionService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
  ) {}

  /**
   * Everything the export needs, in one pass.
   *
   * Differs from `summary()` and `transactions()` in exactly one respect: the
   * bound. Same obligations CTE, same predicate, same ordering resolution, so
   * an export cannot disagree with the screen it was taken from. The screen
   * pages because a person reads a page at a time; an export that stopped at
   * one page would be silently wrong.
   *
   * `exportRowLimit` is a ceiling, not a page size, and `truncated` reports
   * when it was hit. A cap that hides itself turns a partial export into one
   * that looks complete.
   */
  public async exportData(filters: PaymentPositionFilters): Promise<{
    readonly metadata: PaymentPositionMetadata;
    readonly parties: readonly PaymentPositionPartySummary[];
    readonly totals: {
      readonly originalAmount: string;
      readonly outstandingAmount: string;
      readonly overdueAmount: string;
      readonly settledAmount: string;
      readonly transactionCount: number;
    };
    readonly transactions: readonly PaymentPositionTransaction[];
    readonly truncated: boolean;
  }> {
    const unbounded: PaymentPositionFilters = {
      ...filters,
      limit: exportRowLimit,
      offset: 0,
    };
    // Reuses the public read paths rather than re-deriving anything: the export
    // is the screen, unpaged.
    const [summary, transactions] = await Promise.all([
      this.summary(unbounded, exportRowLimit),
      this.transactions({ ...unbounded, limit: exportRowLimit + 1 }, exportRowLimit + 1),
    ]);
    const truncated =
      transactions.items.length > exportRowLimit || summary.items.length >= exportRowLimit;
    return {
      metadata: summary.metadata,
      parties: summary.items,
      totals: summary.totals,
      transactions: truncated ? transactions.items.slice(0, exportRowLimit) : transactions.items,
      truncated,
    };
  }

  /** One row per party and direction, plus grand totals. */
  public async summary(
    filters: PaymentPositionFilters,
    maxLimit = pageLimit,
  ): Promise<{
    readonly items: readonly PaymentPositionPartySummary[];
    readonly metadata: PaymentPositionMetadata;
    readonly total: number;
    readonly totals: {
      readonly originalAmount: string;
      readonly outstandingAmount: string;
      readonly overdueAmount: string;
      readonly settledAmount: string;
      readonly transactionCount: number;
    };
  }> {
    const { companyId } = this.tenants.current();
    const days = this.overdueDays(filters);
    const obligations = this.obligations(companyId, days);
    const predicate = this.predicate(filters);
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), maxLimit);
    const offset = Math.max(filters.offset ?? 0, 0);
    const order = this.ordering(filters, partySortColumns, "outstanding_amount");

    // Grouped in SQL, ordered in SQL, paged in SQL. Grouping in application
    // memory would mean fetching every obligation the Company has ever had in
    // order to display fifty rows.
    const grouped = sql`
      select o.party_type, o.party_id, o.party_name, o.party_reference, o.direction,
             sum(o.original_amount) as original_amount,
             sum(o.settled_amount) as settled_amount,
             sum(o.outstanding_amount) as outstanding_amount,
             sum(case when o.is_overdue then o.outstanding_amount else 0 end) as overdue_amount,
             count(*)::int as transaction_count,
             max(o.last_movement_date)::text as last_movement_date
        from obligations o
       where ${predicate}
       group by o.party_type, o.party_id, o.party_name, o.party_reference, o.direction
    `;

    const [items, total, totals] = await Promise.all([
      sql<PaymentPositionPartySummary>`
        with obligations as (${obligations}), grouped as (${grouped})
        select g.party_type as "partyType", g.party_id as "partyId",
               g.party_name as "partyName", g.party_reference as "partyReference",
               g.direction, g.original_amount::text as "originalAmount",
               g.settled_amount::text as "settledAmount",
               g.outstanding_amount::text as "outstandingAmount",
               g.overdue_amount::text as "overdueAmount",
               g.transaction_count as "transactionCount",
               g.last_movement_date as "lastMovementDate",
               -- Running balance across the ordered party list: how the total
               -- position accumulates as the reader goes down the page. Signed
               -- here and only here, because a mixed payable/receivable list
               -- only nets meaningfully in one direction.
               sum(case when g.direction='receivable' then g.outstanding_amount
                        else -g.outstanding_amount end)
                 over (order by ${sql.raw(order.column)} ${sql.raw(order.direction)},
                                g.party_id nulls last
                       rows between unbounded preceding and current row)::text
                 as "runningBalance"
          from grouped g
         order by ${sql.raw(order.column)} ${sql.raw(order.direction)}, g.party_id nulls last
         limit ${limit} offset ${offset}
      `.execute(this.database),
      sql<{ total: number }>`
        with obligations as (${obligations}), grouped as (${grouped})
        select count(*)::int as total from grouped g
      `.execute(this.database),
      sql<{
        originalAmount: string;
        outstandingAmount: string;
        overdueAmount: string;
        settledAmount: string;
        transactionCount: number;
      }>`
        with obligations as (${obligations})
        select coalesce(sum(o.original_amount),0)::text as "originalAmount",
               coalesce(sum(o.settled_amount),0)::text as "settledAmount",
               coalesce(sum(o.outstanding_amount),0)::text as "outstandingAmount",
               coalesce(sum(case when o.is_overdue then o.outstanding_amount else 0 end),0)::text
                 as "overdueAmount",
               count(*)::int as "transactionCount"
          from obligations o where ${predicate}
      `.execute(this.database),
    ]);

    return {
      items: items.rows,
      metadata: this.metadata(days),
      total: total.rows[0]?.total ?? 0,
      totals: totals.rows[0] ?? {
        originalAmount: "0.00",
        outstandingAmount: "0.00",
        overdueAmount: "0.00",
        settledAmount: "0.00",
        transactionCount: 0,
      },
    };
  }

  /** The individual obligations behind the summary. */
  public async transactions(
    filters: PaymentPositionFilters,
    maxLimit = pageLimit,
  ): Promise<{
    readonly items: readonly PaymentPositionTransaction[];
    readonly metadata: PaymentPositionMetadata;
    readonly total: number;
  }> {
    const { companyId } = this.tenants.current();
    const days = this.overdueDays(filters);
    const obligations = this.obligations(companyId, days);
    const predicate = this.predicate(filters);
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), maxLimit);
    const offset = Math.max(filters.offset ?? 0, 0);
    const order = this.ordering(filters, transactionSortColumns, "transaction_date");

    const [items, total] = await Promise.all([
      sql<PaymentPositionTransaction>`
        with obligations as (${obligations})
        select o.party_type as "partyType", o.party_id as "partyId",
               o.party_name as "partyName", o.direction,
               o.transaction_type as "transactionType",
               o.source_id as "sourceId", o.source_reference as "sourceReference",
               o.transaction_date::text as "transactionDate", o.due_date::text as "dueDate",
               o.original_amount::text as "originalAmount",
               o.settled_amount::text as "settledAmount",
               o.outstanding_amount::text as "outstandingAmount",
               o.is_overdue as "isOverdue", o.status,
               -- Per-party running balance, in transaction order. PARTITION BY
               -- keeps one party's history from bleeding into the next, which
               -- is the whole point of a statement-style balance.
               sum(o.outstanding_amount) over (
                 partition by o.party_type, o.party_id, o.direction
                 order by o.transaction_date, o.source_id
                 rows between unbounded preceding and current row
               )::text as "runningBalance",
               -- LEFT joins: an obligation is real whether or not it has been
               -- posted. Hiding unposted rows would understate the position.
               e.id as "accountingEventId", j.id as "journalEntryId",
               j.journal_number as "journalNumber"
          from obligations o
          left join accounting_events e
            on e.company_id=o.company_id and e.source_entity_type=o.event_entity_type
           and e.source_entity_id=o.source_id
          left join journal_entries j
            on j.company_id=o.company_id and j.source_id=o.source_id and j.status='posted'
         where ${predicate}
         order by ${sql.raw(order.column)} ${sql.raw(order.direction)}, o.source_id
         limit ${limit} offset ${offset}
      `.execute(this.database),
      sql<{ total: number }>`
        with obligations as (${obligations})
        select count(*)::int as total from obligations o where ${predicate}
      `.execute(this.database),
    ]);

    return { items: items.rows, metadata: this.metadata(days), total: total.rows[0]?.total ?? 0 };
  }

  /**
   * Every obligation source, normalised to one shape.
   *
   * `company_id` is filtered on EVERY branch and carried as a column, so tenant
   * isolation holds inside the CTE. Applying it once on the outside would leak
   * the day someone adds a seventh branch and forgets.
   *
   * Amounts are magnitudes throughout; `direction` carries the meaning.
   */
  private obligations(companyId: string, overdueAfterDays: number) {
    const cutoff = sql`(current_date - ${overdueAfterDays}::int)`;
    return sql`
      -- RECEIVABLE: money a Trader owes the Company. outstanding_amount is a
      -- generated column on this table, so it cannot drift from its parts.
      select r.company_id, 'trader'::text as party_type, r.trader_id as party_id,
             coalesce(t.name_en, t.code) as party_name, t.code as party_reference,
             'receivable'::text as direction, 'trader_receivable'::text as transaction_type,
             r.id as source_id, r.receivable_number as source_reference,
             r.business_date as transaction_date,
             (r.business_date + ${overdueAfterDays}::int) as due_date,
             r.original_amount_due as original_amount, r.amount_collected as settled_amount,
             r.outstanding_amount, r.status,
             (r.outstanding_amount > 0 and r.business_date < ${cutoff}) as is_overdue,
             r.updated_at::date as last_movement_date,
             'trader_receivable'::text as event_entity_type
        from trader_receivables r
        left join traders t on t.id=r.trader_id and t.company_id=r.company_id
       where r.company_id=${companyId}::uuid and r.status in ('outstanding','partially_collected')

      union all
      -- RECEIVABLE: cash a Driver has collected but not yet handed over. The
      -- Order is the authoritative record until a Reconciliation confirms it.
      select o.company_id, 'driver', o.assigned_driver_id,
             coalesce(d.name_en, d.code), d.code,
             'receivable', 'driver_cash_pending', o.id, o.order_number,
             o.order_date, (o.order_date + ${overdueAfterDays}::int),
             o.amount_collected, 0, o.amount_collected, o.driver_reconciliation_status,
             (o.amount_collected > 0 and o.order_date < ${cutoff}),
             o.updated_at::date, 'order'
        from orders o
        left join drivers d on d.id=o.assigned_driver_id and d.company_id=o.company_id
       where o.company_id=${companyId}::uuid and o.driver_reconciliation_status='pending'
         and o.amount_collected > 0

      union all
      -- PAYABLE: net amount owed to a Trader on Orders not yet settled.
      select o.company_id, 'trader', o.trader_id,
             coalesce(t.name_en, t.code), t.code,
             'payable', 'trader_settlement_due', o.id, o.order_number,
             o.order_date, (o.order_date + ${overdueAfterDays}::int),
             o.trader_net_payable, 0, o.trader_net_payable, o.trader_settlement_status,
             (o.trader_net_payable > 0 and o.order_date < ${cutoff}),
             o.updated_at::date, 'order'
        from orders o
        left join traders t on t.id=o.trader_id and t.company_id=o.company_id
       where o.company_id=${companyId}::uuid and o.trader_settlement_status='unsettled'
         and o.trader_net_payable > 0

      union all
      -- PAYABLE: Employee salary. Held and reversed lines are excluded because
      -- neither is owed: a held line is deliberately not payable, and a
      -- reversed one no longer exists as an obligation.
      select l.company_id, 'employee', l.employee_id,
             l.employee_name_snapshot, l.employee_number_snapshot,
             'payable', 'payroll_entry', l.id, l.payroll_number,
             p.period_end, (p.period_end + ${overdueAfterDays}::int),
             l.net_salary, l.amount_paid, l.outstanding_amount, l.status,
             (l.outstanding_amount > 0 and p.period_end < ${cutoff}),
             l.updated_at::date, 'payroll_entry'
        from payroll_entries l
        join payroll_periods p on p.id=l.payroll_period_id and p.company_id=l.company_id
       where l.company_id=${companyId}::uuid and l.status not in ('held','reversed')
         and l.outstanding_amount > 0

      union all
      -- PAYABLE: outsourced Driver fee already earned. accrual_business_date is
      -- the operational day it was earned, which is what ages the obligation.
      select a.company_id, 'driver', a.driver_id,
             coalesce(d.name_en, d.code), d.code,
             'payable', 'outsourced_driver_fee', a.id,
             coalesce(a.source_reference, a.id::text),
             a.accrual_business_date, (a.accrual_business_date + ${overdueAfterDays}::int),
             a.earned_amount, a.paid_amount, a.outstanding_amount, a.status,
             (a.outstanding_amount > 0 and a.accrual_business_date < ${cutoff}),
             a.updated_at::date, 'outsourced_driver_fee_accrual'
        from outsourced_driver_fee_accruals a
        left join drivers d on d.id=a.driver_id and d.company_id=a.company_id
       where a.company_id=${companyId}::uuid and a.outstanding_amount > 0

      union all
      -- PAYABLE: approved Expense owed to a supplier or other payee. Draft and
      -- rejected Expenses are not obligations, so only approved ones appear.
      -- The payee is a SNAPSHOT on the Expense; there is no supplier master,
      -- which is why party_id can be null here and the name carries the row.
      select g.company_id, 'supplier', g.payee_id,
             coalesce(g.payee_name_snapshot, g.category_name_en_snapshot), g.expense_number,
             'payable', 'general_expense', g.id, g.expense_number,
             coalesce(g.expense_date, g.accounting_date),
             (coalesce(g.expense_date, g.accounting_date) + ${overdueAfterDays}::int),
             g.approved_amount, g.paid_amount, g.outstanding_amount, g.payment_status,
             (g.outstanding_amount > 0
              and coalesce(g.expense_date, g.accounting_date) < ${cutoff}),
             g.updated_at::date, 'general_expense'
        from general_expenses g
       where g.company_id=${companyId}::uuid and g.status='approved'
         and g.outstanding_amount > 0
    `;
  }

  /**
   * One predicate shared by rows, counts and totals.
   *
   * Built once so a filtered total can never disagree with the rows it claims
   * to summarise.
   */
  private predicate(filters: PaymentPositionFilters) {
    const partyType = filters.partyType ?? null;
    const partyId = filters.partyId ?? null;
    const direction = filters.direction ?? null;
    const dateFrom = filters.dateFrom ?? null;
    const dateTo = filters.dateTo ?? null;
    return sql`
      (${partyType}::text is null or o.party_type = ${partyType}::text)
      and (${partyId}::uuid is null or o.party_id = ${partyId}::uuid)
      and (${direction}::text is null or o.direction = ${direction}::text)
      and (${dateFrom}::date is null or o.transaction_date >= ${dateFrom}::date)
      and (${dateTo}::date is null or o.transaction_date <= ${dateTo}::date)
      and (${filters.outstandingOnly ?? false} = false or o.outstanding_amount > 0)
      and (${filters.overdueOnly ?? false} = false or o.is_overdue)
    `;
  }

  /**
   * Sort column and direction, resolved through a fixed allow-list.
   *
   * `sql.raw` is used for the ORDER BY, which is only safe because the value
   * can never come from the request: an unrecognised `sortBy` falls back rather
   * than being interpolated.
   */
  private ordering(
    filters: PaymentPositionFilters,
    allowed: Readonly<Record<string, string>>,
    fallback: string,
  ): { readonly column: string; readonly direction: "asc" | "desc" } {
    const column = allowed[filters.sortBy ?? ""] ?? fallback;
    return { column, direction: filters.sortDirection === "asc" ? "asc" : "desc" };
  }

  private overdueDays(filters: PaymentPositionFilters): number {
    const value = filters.overdueAfterDays ?? defaultOverdueAfterDays;
    return Math.min(Math.max(Math.trunc(value), 0), 3650);
  }

  private metadata(overdueAfterDays: number): PaymentPositionMetadata {
    return {
      dueDateBasis: "derived_from_ageing",
      dueDateNote:
        "No source table stores a due date; payment terms are not modelled. Due dates shown here are derived as the transaction date plus the ageing threshold, and overdue means outstanding for longer than that threshold.",
      overdueAfterDays,
      sources: sourceDeclarations,
    };
  }
}
