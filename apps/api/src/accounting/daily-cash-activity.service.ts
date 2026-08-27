import { Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { BusinessDayService } from "../company-configuration/business-day.service.js";
import type { BusinessDayWindow } from "../company-configuration/business-day.service.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

/**
 * Daily Cash and Financial Activity — read-only report foundation.
 *
 * ===========================================================================
 * THE ONE IDEA THIS SERVICE EXISTS TO PROTECT
 * ===========================================================================
 *
 * Cash Activity and Income Statement Activity are DIFFERENT QUESTIONS on
 * DIFFERENT CALENDARS, and they are computed here by two queries that share no
 * data path.
 *
 *   Cash Activity        - "what money moved last night"
 *                          Operational. Filtered by an observed confirmation
 *                          INSTANT inside the 08:00-08:00 Business Day window.
 *
 *   Income Statement     - "what did we earn and spend"
 *                          Financial. Filtered by ACCOUNTING DATE on posted
 *                          Journals, which is a date-only decision with no time
 *                          of day and therefore no business day.
 *
 * Collecting cash is not revenue: it settles a receivable that was recognised
 * when the Order was delivered. Paying cash is not expense: it settles a
 * payable recognised when the cost was incurred. Reading one as the other is
 * the single most common way a daily report becomes wrong, so the two sections
 * never share a row, a filter, or a total.
 *
 * ===========================================================================
 * WHY `confirmed_at` AND NOTHING ELSE
 * ===========================================================================
 *
 * A Business Day window is INTRADAY. Placing a record inside it requires
 * knowing the time of day it happened. `payment_date`, `movement_date` and
 * `accounting_date` are date-only fields a person chose; `created_at` is when
 * the row was typed, not when the money moved. Only `confirmed_at` is an
 * instant the system observed.
 *
 * Three tables gained `confirmed_at` prospectively, so their older rows hold
 * null. Those rows are EXCLUDED and COUNTED, never estimated. A total that
 * silently drops rows understates the cash; a total that guesses their time
 * mixes invented data into an audited figure, which is worse. The count is
 * returned so the report can say so out loud.
 *
 * See `business-day-report-sources.ts` for the per-table reasoning.
 *
 * ===========================================================================
 * WHY ONE UNION AND NOT SIX QUERIES
 * ===========================================================================
 *
 * Every cash source is normalised once, in SQL, into a single movement shape:
 * direction, method, amount, party, account, instant. Opening balance, window
 * totals and drill-down rows are then three reads of that same shape.
 *
 * That is not only a performance choice. Deriving opening and closing from the
 * SAME movement set is what makes `opening + net = closing` true by
 * construction rather than by coincidence, and it removes any chance of the
 * summary and the drill-down disagreeing about what happened.
 */

/** Cash or Bank/Visa. Kept apart everywhere; never summed into one "money". */
export type DailyCashDateBasis = "business" | "calendar";

export type DailyCashMethod = "bank" | "cash";

export type DailyCashDirection = "in" | "out";

export type DailyCashPartyType =
  "driver" | "employee" | "expense" | "internal" | "trader" | "unknown";

export interface DailyCashActivityFilters {
  readonly businessDate: string;
  readonly dateBasis?: DailyCashDateBasis;
  /** Cash or Bank account id. Sources that carry no account are excluded when set. */
  readonly accountId?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly partyId?: string;
  readonly partyType?: DailyCashPartyType;
  readonly paymentMethod?: DailyCashMethod;
}

export interface DailyCashActivityRow {
  readonly accountingEventId: string | null;
  readonly amount: string;
  readonly bankAccountId: string | null;
  readonly bankAccountName: string | null;
  readonly businessDate: string | null;
  readonly cashAccountId: string | null;
  readonly cashAccountName: string | null;
  readonly confirmedAt: string;
  readonly direction: DailyCashDirection;
  readonly journalEntryId: string | null;
  readonly journalNumber: string | null;
  readonly partyId: string | null;
  readonly partyName: string | null;
  readonly partyType: DailyCashPartyType;
  readonly paymentMethod: DailyCashMethod;
  readonly sourceId: string;
  readonly sourceReference: string;
  readonly sourceType: string;
}

export interface DailyCashActivitySection {
  readonly bankCollected: string;
  readonly bankPaid: string;
  readonly cashCollected: string;
  readonly cashPaid: string;
  readonly closingBankBalance: string;
  readonly closingCashBalance: string;
  readonly netBankMovement: string;
  readonly netCashMovement: string;
  readonly openingBankBalance: string;
  readonly openingCashBalance: string;
  readonly outstandingToCollect: string;
  readonly outstandingToPay: string;
}

export interface DailyIncomeStatementSection {
  readonly expensesRecognized: string;
  readonly netIncomeActivity: string;
  readonly revenueRecognized: string;
}

export interface DailyCashActivityMetadata {
  readonly accountingDateBasis: string;
  readonly dateBasis: DailyCashDateBasis;
  readonly authoritativeTimestamps: readonly {
    readonly column: string;
    readonly historicalNulls: boolean;
    readonly sourceType: string;
    readonly table: string;
  }[];
  readonly businessDate: string;
  readonly businessDayStart: string;
  readonly displayEnd: string;
  readonly endUtc: string;
  readonly excludedRowsWithoutTimestamp: number;
  readonly segments: BusinessDayWindow["segments"];
  readonly spansRuleChange: boolean;
  readonly startUtc: string;
  readonly timezone: string;
}

export interface DailyCashActivityReport {
  readonly cashActivity: DailyCashActivitySection;
  readonly incomeStatementActivity: DailyIncomeStatementSection;
  readonly metadata: DailyCashActivityMetadata;
}

/** Safety ceiling for one export. Reported when reached, never silent. */
const exportRowLimit = 50_000;

/**
 * What each cash source contributes, and the instant that decides it.
 *
 * Declared here rather than inlined so the drill-down, the totals and the
 * metadata all describe the same set. `historicalNulls` marks the three tables
 * whose column was added prospectively.
 */
const cashSourceDeclarations = [
  {
    column: "confirmed_at",
    historicalNulls: false,
    sourceType: "driver_collection",
    table: "driver_reconciliations",
  },
  {
    column: "confirmed_at",
    historicalNulls: true,
    sourceType: "trader_collection",
    table: "trader_collections",
  },
  {
    column: "confirmed_at",
    historicalNulls: false,
    sourceType: "trader_settlement",
    table: "trader_settlements",
  },
  {
    column: "confirmed_at",
    historicalNulls: true,
    sourceType: "payroll_payment",
    table: "payroll_payments",
  },
  {
    column: "confirmed_at",
    historicalNulls: true,
    sourceType: "outsourced_driver_fee_payment",
    table: "outsourced_driver_fee_payments",
  },
  {
    column: "confirmed_at",
    historicalNulls: false,
    sourceType: "general_expense_payment",
    table: "general_expense_payments",
  },
  {
    column: "confirmed_at",
    historicalNulls: false,
    sourceType: "cash_bank_movement",
    table: "cash_bank_movements",
  },
] as const;

@Injectable()
export class DailyCashActivityService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(BusinessDayService) private readonly businessDays: BusinessDayService,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
  ) {}

  /**
   * Both sections plus the metadata that explains what was measured.
   *
   * Four aggregate reads, none of them per-row and none of them per-day:
   * balances before the window, movement inside it, outstanding as-of, and the
   * Income Statement. No source is iterated in application code.
   */
  public async report(filters: DailyCashActivityFilters): Promise<DailyCashActivityReport> {
    const { companyId } = this.tenants.current();
    const window = await this.activityWindow(filters);

    const [opening, movement, outstanding, income, excluded] = await Promise.all([
      this.balanceBefore(companyId, window.startUtc, filters),
      this.movementWithin(companyId, window, filters),
      this.outstanding(companyId),
      this.incomeStatement(companyId, filters.businessDate),
      this.rowsWithoutTimestamp(companyId),
    ]);

    const openingCash = opening.cash;
    const openingBank = opening.bank;
    const netCash = subtract(movement.cashIn, movement.cashOut);
    const netBank = subtract(movement.bankIn, movement.bankOut);

    return {
      cashActivity: {
        bankCollected: movement.bankIn,
        bankPaid: movement.bankOut,
        cashCollected: movement.cashIn,
        cashPaid: movement.cashOut,
        // Closing is opening plus net, never a second independent query: two
        // queries could disagree and the report would not be able to say which
        // one was wrong.
        closingBankBalance: add(openingBank, netBank),
        closingCashBalance: add(openingCash, netCash),
        netBankMovement: netBank,
        netCashMovement: netCash,
        openingBankBalance: openingBank,
        openingCashBalance: openingCash,
        outstandingToCollect: outstanding.toCollect,
        outstandingToPay: outstanding.toPay,
      },
      incomeStatementActivity: income,
      metadata: {
        accountingDateBasis:
          "Income Statement Activity uses journal_entries.business_date, the ACCOUNTING date. It is date-only and is not filtered by the Cash Activity confirmation-time window.",
        authoritativeTimestamps: cashSourceDeclarations.map((source) => ({ ...source })),
        businessDate: filters.businessDate,
        dateBasis: filters.dateBasis ?? "calendar",
        businessDayStart: window.businessDayStart,
        displayEnd: window.displayEnd,
        endUtc: window.endUtc,
        excludedRowsWithoutTimestamp: excluded,
        segments: window.segments,
        spansRuleChange: window.spansRuleChange,
        startUtc: window.startUtc,
        timezone: window.timezone,
      },
    };
  }

  private activityWindow(filters: DailyCashActivityFilters): Promise<BusinessDayWindow> {
    return filters.dateBasis === "business"
      ? this.businessDays.window(filters.businessDate, filters.businessDate)
      : this.businessDays.calendarWindow(filters.businessDate, filters.businessDate);
  }

  /**
   * Every filtered movement in the window, for export.
   *
   * Separate from `rows()` only in its bound: the screen pages at 50 because a
   * person reads a page at a time, whereas an export that stopped at 50 would
   * be silently wrong. It runs the SAME CTE and the SAME predicate, so an
   * export can never disagree with the screen it was taken from.
   *
   * `exportRowLimit` is a safety ceiling, not a page size, and `truncated`
   * reports when it was reached. A cap that hides itself turns a partial
   * export into one that looks complete.
   */
  public async exportRows(filters: DailyCashActivityFilters): Promise<{
    readonly items: readonly DailyCashActivityRow[];
    readonly truncated: boolean;
  }> {
    const { companyId } = this.tenants.current();
    const window = await this.activityWindow(filters);
    const predicate = this.filterPredicate(window, filters);
    const result = await sql<DailyCashActivityRow>`
      with movements as (${this.movements(companyId)})
      select m.source_type as "sourceType", m.source_id as "sourceId",
             m.source_reference as "sourceReference", m.direction,
             m.payment_method as "paymentMethod", m.amount::text as amount,
             m.party_type as "partyType", m.party_id as "partyId",
             m.party_name as "partyName",
             m.cash_account_id as "cashAccountId", ca.cash_account_name as "cashAccountName",
             m.bank_account_id as "bankAccountId", ba.account_name as "bankAccountName",
             m.confirmed_at::text as "confirmedAt",
             e.id as "accountingEventId", j.id as "journalEntryId",
             j.journal_number as "journalNumber"
        from movements m
        left join company_cash_accounts ca
          on ca.id=m.cash_account_id and ca.company_id=m.company_id
        left join company_bank_accounts ba
          on ba.id=m.bank_account_id and ba.company_id=m.company_id
        left join accounting_events e
          on e.company_id=m.company_id and e.source_entity_type=m.event_entity_type
         and e.source_entity_id=m.source_id
        left join journal_entries j
          on j.company_id=m.company_id and j.source_id=m.source_id and j.status='posted'
       where ${predicate}
       order by m.confirmed_at desc, m.source_id
       limit ${exportRowLimit + 1}
    `.execute(this.database);
    const truncated = result.rows.length > exportRowLimit;
    const rows = truncated ? result.rows.slice(0, exportRowLimit) : result.rows;
    const businessDates = await this.businessDays.businessDatesFor(
      rows.map((row) => row.confirmedAt),
    );
    return {
      items: rows.map((row) => ({
        ...row,
        businessDate: businessDates.get(row.confirmedAt) ?? null,
      })),
      truncated,
    };
  }

  /**
   * Drill-down rows for the window, newest first.
   *
   * Paginated in SQL. Loading a day of movements into memory to slice it there
   * would work today and stop working the first busy month.
   */
  public async rows(filters: DailyCashActivityFilters): Promise<{
    readonly items: readonly DailyCashActivityRow[];
    readonly total: number;
  }> {
    const { companyId } = this.tenants.current();
    const window = await this.activityWindow(filters);
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);
    const movements = this.movements(companyId);
    const predicate = this.filterPredicate(window, filters);

    const [items, total] = await Promise.all([
      sql<DailyCashActivityRow>`
        with movements as (${movements})
        select m.source_type as "sourceType", m.source_id as "sourceId",
               m.source_reference as "sourceReference", m.direction, m.payment_method as "paymentMethod",
               m.amount::text as amount, m.party_type as "partyType", m.party_id as "partyId",
               m.party_name as "partyName",
               m.cash_account_id as "cashAccountId", ca.cash_account_name as "cashAccountName",
               m.bank_account_id as "bankAccountId", ba.account_name as "bankAccountName",
               m.confirmed_at::text as "confirmedAt",
               -- The Accounting Event and Journal are LEFT joins on purpose: an
               -- operational movement is real whether or not it has been posted
               -- yet, and hiding unposted rows would understate the cash.
               e.id as "accountingEventId", j.id as "journalEntryId",
               j.journal_number as "journalNumber"
          from movements m
          left join company_cash_accounts ca
            on ca.id=m.cash_account_id and ca.company_id=m.company_id
          left join company_bank_accounts ba
            on ba.id=m.bank_account_id and ba.company_id=m.company_id
          left join accounting_events e
            on e.company_id=m.company_id and e.source_entity_type=m.event_entity_type
           and e.source_entity_id=m.source_id
          left join journal_entries j
            on j.company_id=m.company_id and j.source_id=m.source_id and j.status='posted'
         where ${predicate}
         order by m.confirmed_at desc, m.source_id
         limit ${limit} offset ${offset}
      `.execute(this.database),
      sql<{ total: number }>`
        with movements as (${movements})
        select count(*)::int as total from movements m where ${predicate}
      `.execute(this.database),
    ]);

    const businessDates = await this.businessDays.businessDatesFor(
      items.rows.map((row) => row.confirmedAt),
    );
    return {
      items: items.rows.map((row) => ({
        ...row,
        // Calendar mode can contain two Business Dates around the configured
        // cutoff. Resolve the page in one configuration read rather than
        // copying the selected Calendar Date or issuing one query per row.
        businessDate: businessDates.get(row.confirmedAt) ?? null,
      })),
      total: total.rows[0]?.total ?? 0,
    };
  }

  /**
   * Every cash source, normalised to one movement shape.
   *
   * `company_id` is carried on every branch and every branch filters on it, so
   * tenant isolation holds inside the CTE rather than being bolted on outside
   * it where one forgotten branch would leak.
   */
  private movements(companyId: string) {
    return sql`
      -- IN: Driver cash handed over at reconciliation. Cash by definition;
      -- the table has no payment method because there is nothing else it can be.
      select r.company_id, 'driver_collection' as source_type, r.id as source_id,
             r.reconciliation_number as source_reference, 'in' as direction,
             'cash' as payment_method, r.net_amount_received as amount,
             'driver' as party_type, r.driver_id as party_id,
             coalesce(d.name_en, d.code) as party_name,
             null::uuid as cash_account_id, null::uuid as bank_account_id,
             r.confirmed_at, 'driver_reconciliation' as event_entity_type
        from driver_reconciliations r
        left join drivers d on d.id=r.driver_id and d.company_id=r.company_id
       where r.company_id=${companyId}::uuid and r.status='confirmed' and r.confirmed_at is not null

      union all
      -- IN: Trader paying down a receivable. Cash or bank transfer.
      select c.company_id, 'trader_collection', c.id, c.collection_number, 'in',
             case when c.payment_method='cash' then 'cash' else 'bank' end,
             c.amount_received, 'trader', c.trader_id,
             coalesce(t.name_en, t.code),
             null::uuid, c.company_bank_account_id, c.confirmed_at, 'trader_collection'
        from trader_collections c
        left join traders t on t.id=c.trader_id and t.company_id=c.company_id
       where c.company_id=${companyId}::uuid and c.status='confirmed' and c.confirmed_at is not null

      union all
      -- OUT: Settlement paid to a Trader. Method and bank account live on the
      -- payment rows, not the header, so one Settlement can be part cash and
      -- part transfer and each part lands in the correct column.
      select s.company_id, 'trader_settlement', s.id, s.settlement_number, 'out',
             case when p.payment_method='cash' then 'cash' else 'bank' end,
             p.amount, 'trader', s.trader_id,
             coalesce(t.name_en, t.code),
             null::uuid, p.company_bank_account_id, s.confirmed_at, 'trader_settlement'
        from trader_settlements s
        join trader_settlement_payments p on p.settlement_id=s.id and p.company_id=s.company_id
        left join traders t on t.id=s.trader_id and t.company_id=s.company_id
       where s.company_id=${companyId}::uuid and s.status='confirmed' and s.confirmed_at is not null

      union all
      -- OUT: Employee salary. Cash-only by CHECK constraint on the table.
      select p.company_id, 'payroll_payment', p.id, p.payment_number, 'out',
             'cash', p.total_amount, 'employee', null::uuid, null::text,
             null::uuid, null::uuid, p.confirmed_at, 'payroll_payment'
        from payroll_payments p
       where p.company_id=${companyId}::uuid and p.status='confirmed' and p.confirmed_at is not null

      union all
      -- OUT: Outsourced Driver fee, CASH ONLY. 'collection_offset' is excluded
      -- deliberately: it nets the fee against cash the Driver already owes, so
      -- no money leaves the drawer and counting it would overstate cash paid.
      select f.company_id, 'outsourced_driver_fee_payment', f.id, f.payment_number, 'out',
             'cash', f.amount_paid, 'driver', f.driver_id,
             coalesce(d.name_en, d.code),
             null::uuid, null::uuid, f.confirmed_at, 'outsourced_driver_fee_payment'
        from outsourced_driver_fee_payments f
        left join drivers d on d.id=f.driver_id and d.company_id=f.company_id
       where f.company_id=${companyId}::uuid and f.status='confirmed'
         and f.payment_method='cash' and f.confirmed_at is not null

      union all
      -- OUT: Expense settled in cash. The table splits cash and visa on the
      -- same row, so each half is emitted separately and a zero half is dropped.
      select g.company_id, 'general_expense_payment', g.id, g.payment_number, 'out',
             'cash', g.cash_amount, 'expense', g.general_expense_id, null::text,
             null::uuid, null::uuid, g.confirmed_at, 'general_expense_payment'
        from general_expense_payments g
       where g.company_id=${companyId}::uuid and g.status='confirmed' and g.cash_amount > 0

      union all
      -- OUT: same Expense payment, Visa/Bank half.
      select g.company_id, 'general_expense_payment', g.id, g.payment_number, 'out',
             'bank', g.visa_amount, 'expense', g.general_expense_id, null::text,
             null::uuid, null::uuid, g.confirmed_at, 'general_expense_payment'
        from general_expense_payments g
       where g.company_id=${companyId}::uuid and g.status='confirmed' and g.visa_amount > 0

      union all
      -- OUT: money leaving a Cash or Bank account through a Movement. A
      -- transfer emits BOTH this leg and the destination leg below, so an
      -- internal cash-to-bank transfer correctly reduces Cash and increases
      -- Bank while leaving their combined total unchanged.
      select m.company_id, 'cash_bank_movement', m.id, m.movement_number, 'out',
             case when m.source_cash_account_id is not null then 'cash' else 'bank' end,
             m.amount, 'internal', null::uuid, m.description,
             m.source_cash_account_id, m.source_bank_account_id, m.confirmed_at,
             'cash_bank_movement'
        from cash_bank_movements m
       where m.company_id=${companyId}::uuid and m.status='confirmed'
         and m.confirmed_at is not null
         -- Operational payments are already emitted by their authoritative
         -- tables above. Their linked Movement is a discoverability mirror,
         -- not a second movement of money.
         and not exists (
           select 1 from accounting_events e
            where e.id=m.accounting_event_id and e.company_id=m.company_id
              and e.source_entity_type<>'cash_bank_movement'
         )
         and (m.source_cash_account_id is not null or m.source_bank_account_id is not null)

      union all
      -- IN: destination leg of the same Movement. 'opening_balance' movements
      -- arrive here too, which is exactly how an account acquires its first
      -- balance without a dedicated column.
      select m.company_id, 'cash_bank_movement', m.id, m.movement_number, 'in',
             case when m.destination_cash_account_id is not null then 'cash' else 'bank' end,
             m.amount, 'internal', null::uuid, m.description,
             m.destination_cash_account_id, m.destination_bank_account_id, m.confirmed_at,
             'cash_bank_movement'
        from cash_bank_movements m
       where m.company_id=${companyId}::uuid and m.status='confirmed'
         and m.confirmed_at is not null
         and not exists (
           select 1 from accounting_events e
            where e.id=m.accounting_event_id and e.company_id=m.company_id
              and e.source_entity_type<>'cash_bank_movement'
         )
         and (m.destination_cash_account_id is not null
              or m.destination_bank_account_id is not null)
    `;
  }

  /**
   * The optional filters, as one fragment shared by every read.
   *
   * Built once so the summary, the drill-down and the count cannot drift apart:
   * a filtered total that does not match its own rows is worse than no filter.
   */
  private filterPredicate(
    window: BusinessDayWindow,
    filters: DailyCashActivityFilters,
    boundary: "before" | "within" = "within",
  ) {
    const account = filters.accountId ?? null;
    const method = filters.paymentMethod ?? null;
    const partyType = filters.partyType ?? null;
    const partyId = filters.partyId ?? null;
    // Half-open: >= start and < end. An inclusive end at 07:59:59 would drop
    // the final second of every business day.
    const period =
      boundary === "before"
        ? sql`m.confirmed_at < ${window.startUtc}::timestamptz`
        : sql`m.confirmed_at >= ${window.startUtc}::timestamptz
              and m.confirmed_at < ${window.endUtc}::timestamptz`;
    return sql`
      ${period}
      and (${method}::text is null or m.payment_method = ${method}::text)
      and (${partyType}::text is null or m.party_type = ${partyType}::text)
      and (${partyId}::uuid is null or m.party_id = ${partyId}::uuid)
      -- An account filter necessarily excludes sources that carry no account
      -- (payroll, Driver reconciliation). That is the honest answer to "what
      -- moved through THIS account", not an omission.
      and (${account}::uuid is null
           or m.cash_account_id = ${account}::uuid or m.bank_account_id = ${account}::uuid)
    `;
  }

  /**
   * Balance carried into the window.
   *
   * Every confirmed movement strictly before `startUtc`, summed by method and
   * signed by direction. There is no opening-balance column on Cash or Bank
   * accounts, and inventing one would make two sources of truth; a Company sets
   * its starting position with an `opening_balance` Movement, which this sum
   * already includes.
   */
  private async balanceBefore(
    companyId: string,
    startUtc: string,
    filters: DailyCashActivityFilters,
  ): Promise<{ readonly bank: string; readonly cash: string }> {
    const window = { endUtc: startUtc, startUtc } as BusinessDayWindow;
    const predicate = this.filterPredicate(window, filters, "before");
    const result = await sql<{ bank: string; cash: string }>`
      with movements as (${this.movements(companyId)})
      select
        coalesce(sum(case when m.payment_method='cash'
          then case when m.direction='in' then m.amount else -m.amount end end),0)::text as cash,
        coalesce(sum(case when m.payment_method='bank'
          then case when m.direction='in' then m.amount else -m.amount end end),0)::text as bank
        from movements m where ${predicate}
    `.execute(this.database);
    return { bank: result.rows[0]?.bank ?? "0.00", cash: result.rows[0]?.cash ?? "0.00" };
  }

  /** Collected and paid inside the window, Cash and Bank kept apart. */
  private async movementWithin(
    companyId: string,
    window: BusinessDayWindow,
    filters: DailyCashActivityFilters,
  ): Promise<{
    readonly bankIn: string;
    readonly bankOut: string;
    readonly cashIn: string;
    readonly cashOut: string;
  }> {
    const predicate = this.filterPredicate(window, filters);
    const result = await sql<{
      bankIn: string;
      bankOut: string;
      cashIn: string;
      cashOut: string;
    }>`
      with movements as (${this.movements(companyId)})
      select
        coalesce(sum(m.amount) filter (where m.payment_method='cash' and m.direction='in'),0)::text
          as "cashIn",
        coalesce(sum(m.amount) filter (where m.payment_method='cash' and m.direction='out'),0)::text
          as "cashOut",
        coalesce(sum(m.amount) filter (where m.payment_method='bank' and m.direction='in'),0)::text
          as "bankIn",
        coalesce(sum(m.amount) filter (where m.payment_method='bank' and m.direction='out'),0)::text
          as "bankOut"
        from movements m where ${predicate}
    `.execute(this.database);
    const row = result.rows[0];
    return {
      bankIn: row?.bankIn ?? "0.00",
      bankOut: row?.bankOut ?? "0.00",
      cashIn: row?.cashIn ?? "0.00",
      cashOut: row?.cashOut ?? "0.00",
    };
  }

  /**
   * Outstanding to collect and to pay, AS OF NOW.
   *
   * Deliberately not window-scoped: "what is still owed" is a position, not an
   * activity, and clipping it to a business day would answer a question nobody
   * asked. It sits in the Cash section because it is what the Cash section is
   * for -- money expected to move -- and never touches the Income Statement.
   */
  private async outstanding(
    companyId: string,
  ): Promise<{ readonly toCollect: string; readonly toPay: string }> {
    const result = await sql<{ toCollect: string; toPay: string }>`
      select
        ((select coalesce(sum(r.outstanding_amount),0)
            from trader_receivables r
           where r.company_id=${companyId}::uuid
             and r.status in ('outstanding','partially_collected'))
         + (select coalesce(sum(o.amount_collected),0)
              from orders o
             where o.company_id=${companyId}::uuid
               and o.driver_reconciliation_status='pending'))::text as "toCollect",
        ((select coalesce(sum(o.trader_net_payable),0)
            from orders o
           where o.company_id=${companyId}::uuid
             and o.trader_settlement_status='unsettled')
         + (select coalesce(sum(l.outstanding_amount),0)
              from payroll_entries l
             where l.company_id=${companyId}::uuid
               and l.status not in ('held','reversed')))::text as "toPay"
    `.execute(this.database);
    return {
      toCollect: result.rows[0]?.toCollect ?? "0.00",
      toPay: result.rows[0]?.toPay ?? "0.00",
    };
  }

  /**
   * Revenue and expense RECOGNISED on the Accounting Date.
   *
   * Posted Journal lines only, classified by the account's own type rather than
   * by which operational module produced them. This query touches no payment,
   * collection or settlement table, which is the structural reason cash can
   * never leak into it.
   *
   * The filter is `business_date = <the Business Date>` treated as a CALENDAR
   * date. Despite its name that column is the Journal's ACCOUNTING date; it has
   * no time of day, so the 08:00-08:00 window does not and cannot apply.
   */
  private async incomeStatement(
    companyId: string,
    businessDate: string,
  ): Promise<DailyIncomeStatementSection> {
    const result = await sql<{ expenses: string; revenue: string }>`
      select
        coalesce(sum(case when a.account_type='revenue' then l.credit - l.debit end),0)::text
          as revenue,
        coalesce(sum(case when a.account_type='expense' then l.debit - l.credit end),0)::text
          as expenses
        from journal_lines l
        join journal_entries j on j.id=l.journal_entry_id and j.company_id=l.company_id
        join chart_of_accounts a on a.id=l.account_id and a.company_id=l.company_id
       where l.company_id=${companyId}::uuid
         and j.status='posted'
         and j.business_date = ${businessDate}::date
         and a.account_type in ('revenue','expense')
    `.execute(this.database);
    const revenue = result.rows[0]?.revenue ?? "0.00";
    const expenses = result.rows[0]?.expenses ?? "0.00";
    return {
      expensesRecognized: expenses,
      netIncomeActivity: subtract(revenue, expenses),
      revenueRecognized: revenue,
    };
  }

  /**
   * How many confirmed rows carry no authoritative instant.
   *
   * Reported, not repaired. These are pre-migration rows on the three tables
   * that gained `confirmed_at` prospectively; they are absent from every figure
   * above, and the report must be able to say how many rather than presenting a
   * quietly incomplete total as a complete one.
   */
  private async rowsWithoutTimestamp(companyId: string): Promise<number> {
    const result = await sql<{ total: number }>`
      select (
        (select count(*) from trader_collections
          where company_id=${companyId}::uuid and status='confirmed' and confirmed_at is null)
      + (select count(*) from payroll_payments
          where company_id=${companyId}::uuid and status='confirmed' and confirmed_at is null)
      + (select count(*) from outsourced_driver_fee_payments
          where company_id=${companyId}::uuid and status='confirmed' and confirmed_at is null)
      )::int as total
    `.execute(this.database);
    return result.rows[0]?.total ?? 0;
  }
}

/** Money stays a string end to end; these keep the two decimals intact. */
function add(left: string, right: string): string {
  return (Number(left) + Number(right)).toFixed(2);
}

function subtract(left: string, right: string): string {
  return (Number(left) - Number(right)).toFixed(2);
}
