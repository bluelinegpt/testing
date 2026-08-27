import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { BusinessDayService } from "../company-configuration/business-day.service.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import { AccountingReportService } from "./accounting-report.service.js";
import { CashBankQueryService } from "./cash-bank-query.service.js";
import { PaymentPositionService } from "./payment-position.service.js";
import type { AccountingDashboardQueryDto } from "./accounting-dashboard.dto.js";

/**
 * Read-only Accounting Dashboard.
 *
 * ===========================================================================
 * IT ASKS; IT DOES NOT DECIDE
 * ===========================================================================
 *
 * Every figure on this screen already has an owner elsewhere. Cash and Bank
 * balances come from `CashBankQueryService.balances()`, the Money Position from
 * `PaymentPositionService`, and Revenue and Expenses from
 * `AccountingReportService`'s Profit and Loss. This service composes their
 * answers; it does not recompute any of them.
 *
 * That is the whole design constraint. A dashboard that carried its own version
 * of "the cash balance" would eventually disagree with the Cash/Bank screen,
 * and the disagreement would surface as a question nobody could answer without
 * reading both queries side by side. Where a number here differs from the
 * screen it summarises, that is a bug in this file, not a second opinion.
 *
 * ===========================================================================
 * WHAT IS COMPUTED HERE, AND WHY
 * ===========================================================================
 *
 * Two things have no existing owner and are computed here:
 *
 *  - the Accounting Health counts, which are status tallies rather than
 *    financial calculations;
 *  - the period NET MOVEMENT of Cash and Bank, because no existing service
 *    exposes a balance as at a date, so a true period delta cannot be asked for.
 *
 * The movement figure is deliberately scoped to `cash_bank_movements` ONLY and
 * named as a movement rather than a balance change. It is not the difference
 * between two balances: the widened balance also counts Payroll, Driver fee,
 * Settlement and Expense payments, which are not Movements. Reporting a
 * Movements-only delta beside a payments-inclusive balance would be misleading
 * if it were called a balance change, so it is not. `metadata.movementScope`
 * says the same thing in the response.
 *
 * Closing that gap properly means giving `balances()` an as-at date and
 * deriving both numbers from it. That is a change to an authoritative query
 * that four payment workflows depend on, and it is not made here.
 */

interface CompanySettingsRow {
  readonly timezone: string;
}

/**
 * Exported because it reaches the controller's public return type: with
 * declaration emit on, an inferred return type naming a module-private
 * interface cannot be written to the .d.ts (TS4053) and the build fails.
 */
export interface HealthRow {
  readonly activeClosingWorkflows: number;
  readonly failedEvents: number;
  readonly openPeriods: number;
  readonly unpostedJournals: number;
  readonly unreconciledMovements: number;
  readonly waitingEvents: number;
}

interface MovementRow {
  readonly netBank: string;
  readonly netCash: string;
}

@Injectable()
export class AccountingDashboardService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(AccountingOperationSupport)
    private readonly support: AccountingOperationSupport,
    @Inject(CashBankQueryService) private readonly cashBank: CashBankQueryService,
    @Inject(PaymentPositionService) private readonly positions: PaymentPositionService,
    @Inject(AccountingReportService) private readonly reports: AccountingReportService,
    @Inject(BusinessDayService) private readonly businessDays: BusinessDayService,
  ) {}

  /**
   * The default upper bound for Income and Expense.
   *
   * Without this the Dashboard asked the Profit and Loss report for ALL time
   * while the report screen asked it for everything up to today, so a posting
   * dated in the future appeared in one and not the other — the two disagreed
   * by the whole amount of that entry while the Dashboard linked straight to
   * the report it contradicted.
   *
   * The boundary is the Company's current BUSINESS date, resolved through
   * `BusinessDayService`, so the Company's timezone and business-day start
   * decide when "today" ends rather than the server's clock. A Company with no
   * business-day rule configured falls back to its `company_settings` timezone:
   * an unbounded Income figure is the defect being fixed here, so failing open
   * would reintroduce it, and failing closed would take the whole Dashboard
   * down over a missing optional rule.
   */
  private async defaultIncomeDateTo(timezone: string): Promise<string> {
    try {
      return await this.businessDays.businessDateOf(new Date().toISOString());
    } catch (error) {
      if ((error as { errorCode?: string }).errorCode !== "business_day_not_configured") throw error;
      return new Intl.DateTimeFormat("en-CA", {
        day: "2-digit",
        month: "2-digit",
        timeZone: timezone,
        year: "numeric",
      }).format(new Date());
    }
  }

  public async summary(query: AccountingDashboardQueryDto) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const dateFrom = query.dateFrom ?? null;
    const dateTo = query.dateTo ?? null;
    if (dateFrom !== null && dateTo !== null && dateFrom > dateTo) {
      throw new ApplicationException(
        "accounting_dashboard_date_range_invalid",
        "The start date must not be after the end date",
        HttpStatus.BAD_REQUEST,
      );
    }

    // Settings resolve first because the Income boundary depends on the
    // Company's timezone. One extra round trip, paid once, to stop the
    // Dashboard and the Profit and Loss report answering different questions.
    const settings = await sql<CompanySettingsRow>`
      select timezone from company_settings where company_id = ${companyId}::uuid
    `.execute(this.database);
    const timezone = settings.rows[0]?.timezone ?? "Asia/Dubai";
    // An explicit filter is honoured exactly as given -- including a future
    // date, which is how a user deliberately looks ahead at accrued postings.
    // Only the DEFAULT is bounded.
    const incomeDateTo = dateTo ?? (await this.defaultIncomeDateTo(timezone));

    // Every remaining section is independent, so they are issued together
    // rather than in sequence: six round trips of latency would otherwise be
    // paid serially for one screen.
    const [balances, movement, receivable, payable, profitAndLoss, health, activity] =
      await Promise.all([
        this.cashBank.balances(),
        this.netMovement(companyId, query),
        // The SAME service the Payment Position screen uses, asked once per
        // direction. Two calls rather than one because its totals are computed
        // across whatever is filtered, and "to collect" and "to pay" are two
        // different filters -- not two halves of one number.
        this.positions.summary({
          direction: "receivable",
          limit: 1,
          ...this.positionFilters(query),
        }),
        this.positions.summary({
          direction: "payable",
          limit: 1,
          ...this.positionFilters(query),
        }),
        // THE authoritative Profit and Loss path, asked with the same bound the
        // report screen uses. Nothing is recomputed here; the disagreement was
        // never in the arithmetic, only in the window.
        this.reports.report("profit-and-loss", {
          ...(dateFrom === null ? {} : { dateFrom }),
          dateTo: incomeDateTo,
        }),
        this.health(companyId, dateFrom, dateTo),
        this.recentActivity(companyId, query),
      ]);

    const accountFilter = query.accountId ?? null;
    const cashRows = balances.filter(
      (row) => row.kind === "cash" && (accountFilter === null || row.id === accountFilter),
    );
    const bankRows = balances.filter(
      (row) => row.kind === "bank" && (accountFilter === null || row.id === accountFilter),
    );
    const total = (rows: readonly Record<string, unknown>[]) =>
      rows
        .reduce((sum, row) => sum.plus(String(row.balance ?? "0")), new Decimal(0))
        .toFixed(2);
    // Carried from the authoritative balance rows, not recounted: the coverage
    // gap belongs to that calculation and travels with it.
    const coverage = (balances[0]?.coverage ?? null) as Record<string, number> | null;
    const coverageTotal =
      coverage === null ? 0 : Object.values(coverage).reduce((sum, count) => sum + count, 0);

    return {
      filters: {
        accountId: query.accountId ?? null,
        dateFrom,
        dateTo,
        partyId: query.partyId ?? null,
        partyType: query.partyType ?? null,
      },
      generatedAt: new Date().toISOString(),
      metadata: {
        // Stated rather than implied: see the header.
        balanceBasis: "opening_balances_movements_and_confirmed_payments",
        coverage,
        coverageIncomplete: coverageTotal > 0,
        coverageNote:
          coverageTotal > 0
            ? `${coverageTotal} confirmed payments recorded before funding accounts were captured are excluded from these balances and cannot be attributed to an account.`
            : null,
        incomeBasis: "posted_journals_by_accounting_date",
        // The window Income and Expense were actually measured over, stated so
        // the screen can show it and so a reader can reconcile these totals
        // against the Profit and Loss report without guessing the bound.
        incomeDateTo,
        incomeDateToSource: dateTo === null ? "company_business_date" : "requested_filter",
        movementScope: "cash_bank_movements_only",
        // A Movements-only delta beside a payments-inclusive balance.
        movementScopeNote:
          "Net movement covers Cash/Bank Movements only. It is not the difference between two balances, which would also include payment workflows.",
      },
      sections: {
        accountingHealth: health,
        cashAndBank: {
          bankAccountCount: bankRows.length,
          cashAccountCount: cashRows.length,
          currentBankBalance: total(bankRows),
          // Cash and Bank stay separate everywhere. A combined "liquidity"
          // figure would hide the one distinction the policy engine, the
          // overdraft rules and the reconciliation screens all turn on.
          currentCashBalance: total(cashRows),
          netBankMovement: movement.netBank,
          netCashMovement: movement.netCash,
        },
        incomeAndExpense: {
          // Straight from the Profit and Loss report's own totals. Revenue is
          // recognised revenue and Expenses are recognised expenses -- a
          // collection is not income and a payment is not a cost.
          expenses: String(profitAndLoss.totals.expenses ?? "0.00"),
          netIncome: String(profitAndLoss.totals.netProfit ?? "0.00"),
          revenue: String(profitAndLoss.totals.revenue ?? "0.00"),
        },
        moneyPosition: {
          overduePayables: payable.totals.overdueAmount,
          overdueReceivables: receivable.totals.overdueAmount,
          outstandingToCollect: receivable.totals.outstandingAmount,
          outstandingToPay: payable.totals.outstandingAmount,
          payableTransactionCount: payable.totals.transactionCount,
          receivableTransactionCount: receivable.totals.transactionCount,
        },
        recentActivity: activity,
      },
      timezone,
    };
  }

  /** Only the filters the Payment Position contract actually accepts. */
  private positionFilters(query: AccountingDashboardQueryDto) {
    return {
      ...(query.dateFrom === undefined ? {} : { dateFrom: query.dateFrom }),
      ...(query.dateTo === undefined ? {} : { dateTo: query.dateTo }),
      ...(query.partyId === undefined ? {} : { partyId: query.partyId }),
      ...(query.partyType === undefined ? {} : { partyType: query.partyType }),
    };
  }

  /**
   * Net Cash and Bank movement for the period, from Cash/Bank Movements.
   *
   * The leg treatment matches the Movements portion of the authoritative
   * balance exactly: a source gives up the amount PLUS the fee, a destination
   * receives the amount, a confirmed reversal undoes its original, and a
   * reversal row is never counted as a movement in its own right.
   */
  private async netMovement(
    companyId: string,
    query: AccountingDashboardQueryDto,
  ): Promise<MovementRow> {
    const from = query.dateFrom ?? null;
    const to = query.dateTo ?? null;
    const account = query.accountId ?? null;
    const result = await sql<MovementRow>`
      with legs as (
        select case when source_cash_account_id is not null then -(amount + fee_amount) else 0 end
                 + case when destination_cash_account_id is not null then amount else 0 end as cash,
               case when source_bank_account_id is not null then -(amount + fee_amount) else 0 end
                 + case when destination_bank_account_id is not null then amount else 0 end as bank
          from cash_bank_movements
         where company_id = ${companyId}::uuid
           and status in ('confirmed', 'reversed') and reversal_of_movement_id is null
           and (${from}::date is null or accounting_date >= ${from}::date)
           and (${to}::date is null or accounting_date <= ${to}::date)
           and (${account}::uuid is null or ${account}::uuid in (
             source_cash_account_id, destination_cash_account_id,
             source_bank_account_id, destination_bank_account_id))
        union all
        -- Undo legs for originals that were reversed inside the window.
        select -(case when o.source_cash_account_id is not null then -(o.amount + o.fee_amount) else 0 end
                 + case when o.destination_cash_account_id is not null then o.amount else 0 end),
               -(case when o.source_bank_account_id is not null then -(o.amount + o.fee_amount) else 0 end
                 + case when o.destination_bank_account_id is not null then o.amount else 0 end)
          from cash_bank_movements r
          join cash_bank_movements o
            on o.id = r.reversal_of_movement_id and o.company_id = r.company_id
         where r.company_id = ${companyId}::uuid and r.status = 'confirmed'
           and (${from}::date is null or r.accounting_date >= ${from}::date)
           and (${to}::date is null or r.accounting_date <= ${to}::date)
           and (${account}::uuid is null or ${account}::uuid in (
             o.source_cash_account_id, o.destination_cash_account_id,
             o.source_bank_account_id, o.destination_bank_account_id))
      )
      select coalesce(sum(cash), 0)::numeric(18,2)::text as "netCash",
             coalesce(sum(bank), 0)::numeric(18,2)::text as "netBank"
        from legs
    `.execute(this.database);
    return result.rows[0] ?? { netBank: "0.00", netCash: "0.00" };
  }

  /**
   * Status tallies, in one statement.
   *
   * Every vocabulary here is the CURRENT one from the live CHECK constraints,
   * not an older subset: an Event stuck in `processing`, `retry_pending` or
   * `blocked_configuration` is counted, and a period is open unless it is
   * exactly `closed`.
   */
  private async health(
    companyId: string,
    from: string | null,
    to: string | null,
  ): Promise<HealthRow> {
    const result = await sql<HealthRow>`
      select
        (select count(*)::int from accounting_events
          where company_id = ${companyId}::uuid
            and processing_status in ('failed', 'blocked_configuration')
            and (${from}::date is null or effective_accounting_date >= ${from}::date)
            and (${to}::date is null or effective_accounting_date <= ${to}::date))
          as "failedEvents",
        (select count(*)::int from accounting_events
          where company_id = ${companyId}::uuid
            and processing_status in ('received', 'processing', 'validated', 'retry_pending')
            and (${from}::date is null or effective_accounting_date >= ${from}::date)
            and (${to}::date is null or effective_accounting_date <= ${to}::date))
          as "waitingEvents",
        (select count(*)::int from journal_entries
          where company_id = ${companyId}::uuid
            and status not in ('posted', 'reversed', 'cancelled')
            and (${from}::date is null or business_date >= ${from}::date)
            and (${to}::date is null or business_date <= ${to}::date))
          as "unpostedJournals",
        (select count(*)::int from cash_bank_movements m
          left join accounting_events e
            on e.id = m.accounting_event_id and e.company_id = m.company_id
          where m.company_id = ${companyId}::uuid and m.status = 'confirmed'
            and (e.id is null or e.processing_status <> 'posted')
            and (${from}::date is null or m.accounting_date >= ${from}::date)
            and (${to}::date is null or m.accounting_date <= ${to}::date))
          as "unreconciledMovements",
        (select count(*)::int from accounting_periods
          where company_id = ${companyId}::uuid and status <> 'closed') as "openPeriods",
        -- "Requiring attention": stalled, sent back, or past its due date. A
        -- workflow progressing normally is not a health problem.
        (select count(*)::int from closing_workflows
          where company_id = ${companyId}::uuid and status not in ('closed', 'cancelled')
            and (status in ('blocked', 'changes_requested')
                 or (due_date is not null and due_date < current_date)))
          as "activeClosingWorkflows"
    `.execute(this.database);
    return (
      result.rows[0] ?? {
        activeClosingWorkflows: 0,
        failedEvents: 0,
        openPeriods: 0,
        unpostedJournals: 0,
        unreconciledMovements: 0,
        waitingEvents: 0,
      }
    );
  }

  /**
   * The latest records across every supported source, in one statement.
   *
   * Each branch is limited BEFORE the union, so the database never sorts nine
   * full histories to return twenty rows, and the union is limited again after
   * ordering. Nothing is aggregated in application memory.
   *
   * `route` is an in-application path the caller can follow. Sources whose
   * detail screen routes by reference rather than id carry that reference, and
   * a source with no detail screen carries none rather than an invented one.
   */
  private async recentActivity(companyId: string, query: AccountingDashboardQueryDto) {
    const from = query.dateFrom ?? null;
    const to = query.dateTo ?? null;
    const partyType = query.partyType ?? null;
    const perSource = 10;
    const overall = 40;
    const result = await sql<Record<string, unknown>>`
      with recent as (
        (select 'driver_collection' as "sourceType", r.reconciliation_number as "sourceReference",
                'driver' as "partyType", d.name_en as "partyName",
                r.net_amount_received::text as amount, r.status,
                r.business_date::text as "activityDate", r.created_at as "activityAt",
                ('/drivers/collections/' || r.id::text) as route,
                null::uuid as "accountingEventId", null::uuid as "journalId"
           from driver_reconciliations r
           left join drivers d on d.id = r.driver_id and d.company_id = r.company_id
          where r.company_id = ${companyId}::uuid
            and (${from}::date is null or r.business_date >= ${from}::date)
            and (${to}::date is null or r.business_date <= ${to}::date)
          order by r.created_at desc limit ${perSource})
        union all
        (select 'trader_settlement', s.settlement_number, 'trader', t.name_en,
                s.net_payable::text, s.status, s.business_date::text, s.created_at,
                ('/accounting/settlements/' || s.id::text), null::uuid, null::uuid
           from trader_settlements s
           left join traders t on t.id = s.trader_id and t.company_id = s.company_id
          where s.company_id = ${companyId}::uuid
            and (${from}::date is null or s.business_date >= ${from}::date)
            and (${to}::date is null or s.business_date <= ${to}::date)
          order by s.created_at desc limit ${perSource})
        union all
        (select 'payroll_payment', p.payment_number, 'employee', null,
                p.total_amount::text, p.status, p.payment_date::text, p.created_at,
                ('/payroll/payments/' || p.id::text), null::uuid, null::uuid
           from payroll_payments p
          where p.company_id = ${companyId}::uuid
            and (${from}::date is null or p.payment_date >= ${from}::date)
            and (${to}::date is null or p.payment_date <= ${to}::date)
          order by p.created_at desc limit ${perSource})
        union all
        (select 'outsourced_driver_fee_payment', f.payment_number, 'driver', d.name_en,
                f.amount_paid::text, f.status, f.payment_date::text, f.created_at,
                ('/payroll/driver-fees/payments/' || f.id::text), null::uuid, null::uuid
           from outsourced_driver_fee_payments f
           left join drivers d on d.id = f.driver_id and d.company_id = f.company_id
          where f.company_id = ${companyId}::uuid
            and (${from}::date is null or f.payment_date >= ${from}::date)
            and (${to}::date is null or f.payment_date <= ${to}::date)
          order by f.created_at desc limit ${perSource})
        union all
        (select 'general_expense_payment', g.payment_number, 'expense', null,
                g.amount::text, g.status, g.payment_date::text, g.created_at,
                ('/accounting/expense-payments/' || g.id::text), null::uuid, null::uuid
           from general_expense_payments g
          where g.company_id = ${companyId}::uuid
            and (${from}::date is null or g.payment_date >= ${from}::date)
            and (${to}::date is null or g.payment_date <= ${to}::date)
          order by g.created_at desc limit ${perSource})
        union all
        (select 'cash_bank_movement', m.movement_number, 'internal', null,
                m.amount::text, m.status, m.accounting_date::text, m.created_at,
                ('/accounting/cash-bank-movements/' || m.id::text),
                m.accounting_event_id, null::uuid
           from cash_bank_movements m
          where m.company_id = ${companyId}::uuid
            -- A linked operational-payment Movement is shown in the dedicated
            -- Movements screen, but the source payment already appears in this
            -- cross-source activity feed. Do not list the same cash event twice.
            and not exists (
              select 1 from accounting_events e
               where e.id=m.accounting_event_id and e.company_id=m.company_id
                 and e.source_entity_type<>'cash_bank_movement'
            )
            and (${from}::date is null or m.accounting_date >= ${from}::date)
            and (${to}::date is null or m.accounting_date <= ${to}::date)
          order by m.created_at desc limit ${perSource})
        union all
        (select 'journal', j.journal_number, null, null,
                j.total_debit::text, j.status, j.business_date::text, j.created_at,
                ('/accounting/journals/' || j.id::text), j.accounting_event_id, j.id
           from journal_entries j
          where j.company_id = ${companyId}::uuid
            and (${from}::date is null or j.business_date >= ${from}::date)
            and (${to}::date is null or j.business_date <= ${to}::date)
          order by j.created_at desc limit ${perSource})
        union all
        (select 'accounting_event', e.source_reference, null, null,
                null, e.processing_status, e.effective_accounting_date::text, e.created_at,
                ('/accounting/events/' || e.id::text), e.id, e.journal_id
           from accounting_events e
          where e.company_id = ${companyId}::uuid
            and (${from}::date is null or e.effective_accounting_date >= ${from}::date)
            and (${to}::date is null or e.effective_accounting_date <= ${to}::date)
          order by e.created_at desc limit ${perSource})
        union all
        (select 'closing_workflow', w.workflow_number, null, null,
                null, w.status, w.due_date::text, w.created_at,
                ('/accounting/closing-workflows/' || w.id::text), null::uuid, null::uuid
           from closing_workflows w
          where w.company_id = ${companyId}::uuid
            and (${from}::date is null or w.due_date >= ${from}::date)
            and (${to}::date is null or w.due_date <= ${to}::date)
          order by w.created_at desc limit ${perSource})
      )
      select * from recent
       where (${partyType}::text is null or "partyType" = ${partyType})
       order by "activityAt" desc nulls last, "sourceReference"
       limit ${overall}
    `.execute(this.database);
    return result.rows;
  }
}
