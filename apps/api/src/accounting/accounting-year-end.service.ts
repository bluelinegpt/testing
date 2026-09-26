import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { Decimal } from "decimal.js";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { AccountingClosingReadinessService } from "./accounting-closing-readiness.service.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import { FiscalCalendarService } from "./fiscal-calendar.service.js";
import type { YearEndExecuteDto } from "./accounting-closing.dto.js";

/**
 * Year-End financial execution.
 *
 * ===========================================================================
 * ONE TRANSACTION, OR NOTHING
 * ===========================================================================
 *
 * This is the only operation in the system that posts a Closing Journal,
 * carries balances into a new fiscal year, creates that year and its periods,
 * and locks the year behind it. Every one of those is written in a SINGLE
 * transaction.
 *
 * A partial year-end is worse than none: a Closing Journal without a
 * carry-forward leaves the new year with no opening position; a carry-forward
 * without a locked prior year invites a second execution that would double it.
 * There is no step here that is safe to have succeeded alone.
 *
 * ===========================================================================
 * WHY IT DOES NOT USE ManualJournalService
 * ===========================================================================
 *
 * That service enforces posting segregation -- the poster must differ from the
 * approver -- which is right for a human-authored Journal and impossible for an
 * automated one, where a single actor authorises the whole execution.
 *
 * This follows the pattern `OperationalJournalPostingService` already
 * established for system-generated Journals: insert as draft, write the lines,
 * then step balanced -> approved -> posted. The application asserts balance
 * before writing, and the database's own `validate_posted_journal_balance`
 * trigger refuses to post lines that do not agree, so the entry is validated
 * twice and by the same rules a manual Journal faces.
 *
 * ===========================================================================
 * WHAT THE CARRY-FORWARD KEEPS, AND WHAT IT DELIBERATELY DROPS
 * ===========================================================================
 *
 * Balance-sheet balances are carried forward per account AND per PARTY --
 * subledger type/id, Trader, Driver, Employee. Those dimensions describe a
 * balance that genuinely continues into the new year: a Trader who is owed
 * money on 31 December is owed it on 1 January, and losing that detail would
 * make the new year's receivables un-ageable.
 *
 * Document references -- Order, Settlement, Collection, Payroll Payment, fee
 * accrual, General Expense, Cash/Bank Movement -- are deliberately NOT copied.
 * An opening balance is a statement of position, not a re-issue of last year's
 * documents, and stamping a new-year opening line with a prior-year Order id
 * would attach it to a transaction that is closed and cannot move again.
 *
 * That line is a judgement, and it is the one part of this file most worth
 * challenging before the first real year-end is run.
 */

/** Balance-sheet account types. Revenue and Expense never carry forward. */
const balanceSheetTypes = ["asset", "liability", "equity"] as const;

interface WorkflowRow {
  readonly accountingPeriodId: string | null;
  readonly fiscalYearId: string;
  readonly id: string;
  readonly status: string;
  readonly submittedByAccountId: string | null;
  readonly version: number;
  readonly workflowNumber: string;
  readonly workflowType: string;
}

interface FiscalYearRow {
  readonly code: string;
  readonly endDate: string;
  readonly id: string;
  readonly startDate: string;
  readonly status: string;
}

/** The checklist keys this execution can answer for. */
const executedTaskKeys = [
  "closing_journal_prepared",
  "profit_loss_transferred",
  "balances_carried_forward",
  "next_fiscal_year_created",
  "next_periods_created",
  "first_new_period_opened",
  "prior_year_locked",
] as const;

@Injectable()
export class AccountingYearEndService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(AccountingOperationSupport)
    private readonly support: AccountingOperationSupport,
    @Inject(OperationsHistoryWriter) private readonly history: OperationsHistoryWriter,
    @Inject(AccountingClosingReadinessService)
    private readonly readiness: AccountingClosingReadinessService,
    @Inject(FiscalCalendarService) private readonly calendar: FiscalCalendarService,
  ) {}

  public async execute(
    workflowId: string,
    input: YearEndExecuteDto,
    idempotencyKey?: string,
  ) {
    this.support.assertPermission("accounting.approve");
    const { actorId, companyId } = this.support.context();
    const reason = input.reason?.trim() || null;

    return this.transactions.execute(async (transaction) => {
      // Lock the workflow first, then fingerprint what was locked -- a replay
      // is judged against the row as it actually stands.
      const workflow = await this.lockWorkflow(transaction, workflowId);
      const reservation = await this.support.reserveIdempotency(transaction, {
        idempotencyKey,
        operation: "accounting.closing-workflow.year-end-execute",
        payload: { reason: reason ?? "", version: input.version, workflowId },
      });
      if (reservation.replayResponse !== undefined) return reservation.replayResponse;

      // ---- eligibility -------------------------------------------------
      if (workflow.workflowType !== "year_end") {
        this.conflict("accounting_year_end_requires_year_end_workflow");
      }
      if (workflow.status !== "approved") {
        this.conflict("accounting_closing_workflow_not_closable");
      }
      if (workflow.version !== input.version) {
        this.conflict("accounting_closing_workflow_stale_version");
      }
      if (workflow.submittedByAccountId !== null && workflow.submittedByAccountId === actorId) {
        this.conflict("accounting_closing_closer_is_submitter");
      }
      await this.readiness.assertReadyForApproval(transaction, workflowId);

      // The fiscal-year lock is what makes the whole operation single-threaded
      // for this year: two executions cannot both read "not yet closed".
      const year = await this.lockFiscalYear(transaction, workflow.fiscalYearId);
      if (year.status === "closed") {
        this.conflict("accounting_year_end_already_closed");
      }
      const openPeriods = await sql<{ count: number }>`
        select count(*)::int as count from accounting_periods
         where company_id = ${companyId}::uuid and fiscal_year_id = ${year.id}::uuid
           and status <> 'closed'
      `.execute(transaction);
      if ((openPeriods.rows[0]?.count ?? 0) > 0) {
        this.conflict("accounting_year_end_periods_not_closed");
      }
      // A Closing Journal already in this year means a prior execution
      // succeeded. Refused rather than repeated -- a doubled close would
      // transfer the result twice.
      const priorClosing = await sql<{ count: number }>`
        select count(*)::int as count from journal_entries
         where company_id = ${companyId}::uuid and fiscal_year_id = ${year.id}::uuid
           and journal_type = 'closing' and status in ('posted', 'reversed')
      `.execute(transaction);
      if ((priorClosing.rows[0]?.count ?? 0) > 0) {
        this.conflict("accounting_year_end_already_executed");
      }
      const retainedEarningsId = await this.retainedEarningsAccount(transaction);

      // ---- 1. Closing Journal: Profit and Loss -> retained earnings ------
      const closing = await this.postClosingJournal(transaction, {
        actorId,
        companyId,
        reason,
        retainedEarningsId,
        workflow,
        year,
      });

      // ---- 2. Next fiscal year and its periods --------------------------
      const nextYear = await this.resolveNextFiscalYear(transaction, year);
      const periods = await this.resolveNextPeriods(transaction, nextYear);
      const firstPeriod = periods.find((period) => period.periodNumber === 1);
      if (firstPeriod === undefined) {
        this.conflict("accounting_year_end_next_periods_inconsistent");
      }
      await sql`
        update accounting_periods
           set status = 'open', opened_by_account_id = ${actorId}::uuid, opened_at = now(),
               version = version + 1
         where id = ${firstPeriod!.id}::uuid and company_id = ${companyId}::uuid
           and status <> 'open'
      `.execute(transaction);

      // ---- 3. Carry-forward into the new year ---------------------------
      const carryForward = await this.postCarryForwardJournal(transaction, {
        actorId,
        companyId,
        firstPeriodId: firstPeriod!.id,
        nextYear,
        workflow,
        year,
      });

      // ---- 4. Lock the prior year --------------------------------------
      await sql`
        update fiscal_years
           set status = 'closed', closed_by_account_id = ${actorId}::uuid, closed_at = now(),
               close_reason = ${reason}, version = version + 1
         where id = ${year.id}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);

      // ---- 5. Workflow, transition, checklist ---------------------------
      await sql`
        update closing_workflows
           set status = 'closed', closed_at = now(), updated_by_account_id = ${actorId}::uuid,
               updated_at = now(), version = version + 1
         where id = ${workflowId}::uuid and company_id = ${companyId}::uuid
      `.execute(transaction);
      const correlationId = randomUUID();
      await sql`
        insert into closing_workflow_transitions (
          company_id, closing_workflow_id, from_status, to_status, reason,
          actor_account_id, correlation_id
        ) values (
          ${companyId}::uuid, ${workflowId}::uuid, 'approved', 'closed', ${reason},
          ${actorId}::uuid, ${correlationId}::uuid
        )
      `.execute(transaction);

      const response = {
        carryForwardJournalId: carryForward.journalId,
        carryForwardJournalNumber: carryForward.journalNumber,
        closingJournalId: closing.journalId,
        closingJournalNumber: closing.journalNumber,
        firstPeriodId: firstPeriod!.id,
        fiscalYearId: year.id,
        id: workflowId,
        netResult: closing.netResult,
        nextFiscalYearId: nextYear.id,
        periodCount: periods.length,
        status: "closed",
        version: workflow.version + 1,
      };

      await this.markExecutedTasks(transaction, workflowId, response, actorId);

      await this.support.audit(transaction, {
        action: "accounting.closing_workflow.year_end_executed",
        after: { ...response, reason },
        correlationId,
        subjectId: workflowId,
        subjectType: "closing_workflow",
      });
      if (idempotencyKey !== undefined) {
        await this.support.completeIdempotency(transaction, {
          idempotencyKey,
          operation: "accounting.closing-workflow.year-end-execute",
          resourceId: workflowId,
          resourceType: "closing_workflow",
          responseBody: response,
        });
      }
      return response;
    });
  }

  /**
   * Zero every Revenue and Expense account and move the net to retained
   * earnings.
   *
   * Balance-sheet accounts are untouched: their balances are carried forward as
   * balances, not transferred as results. Transferring them here would move an
   * asset into equity.
   */
  private async postClosingJournal(
    transaction: Kysely<DatabaseSchema>,
    input: {
      readonly actorId: string;
      readonly companyId: string;
      readonly reason: string | null;
      readonly retainedEarningsId: string;
      readonly workflow: WorkflowRow;
      readonly year: FiscalYearRow;
    },
  ) {
    const balances = await sql<{ accountId: string; code: string; netDebit: string }>`
      select l.account_id as "accountId", a.code,
             sum(l.debit - l.credit)::text as "netDebit"
        from journal_lines l
        join journal_entries j on j.id = l.journal_entry_id and j.company_id = l.company_id
        join chart_of_accounts a on a.id = l.account_id and a.company_id = l.company_id
       where j.company_id = ${input.companyId}::uuid and j.status in ('posted', 'reversed')
         and j.business_date between ${input.year.startDate}::date and ${input.year.endDate}::date
         and a.account_type in ('revenue', 'expense')
       group by l.account_id, a.code
      having sum(l.debit - l.credit) <> 0
       order by a.code
    `.execute(transaction);

    // Each account is zeroed by posting its own balance back against it, so the
    // lines net to exactly the year's result and nothing is rounded into place.
    let net = new Decimal(0);
    const lines = balances.rows.map((row, index) => {
      const balance = new Decimal(row.netDebit);
      net = net.plus(balance);
      return {
        accountId: row.accountId,
        credit: balance.greaterThan(0) ? balance : new Decimal(0),
        debit: balance.lessThan(0) ? balance.negated() : new Decimal(0),
        lineNumber: index + 1,
      };
    });
    // net = expenses - revenue. Profit is its negation, and profit CREDITS
    // retained earnings.
    const profit = net.negated();
    if (!profit.isZero()) {
      lines.push({
        accountId: input.retainedEarningsId,
        credit: profit.greaterThan(0) ? profit : new Decimal(0),
        debit: profit.lessThan(0) ? profit.negated() : new Decimal(0),
        lineNumber: lines.length + 1,
      });
    }

    const journal = await this.writePostedJournal(transaction, {
      accountingDate: input.year.endDate,
      actorId: input.actorId,
      companyId: input.companyId,
      description: `Year-End Closing ${input.year.code} (${input.workflow.workflowNumber})`,
      journalType: "closing",
      lines,
      sourceReference: input.workflow.workflowNumber,
      workflowId: input.workflow.id,
      // The final period of the year being closed.
      periodPredicate: sql`period_end = ${input.year.endDate}::date`,
      fiscalYearId: input.year.id,
    });
    return { ...journal, netResult: profit.toFixed(2) };
  }

  /**
   * Opening balances for the new year, from Balance Sheet accounts only.
   *
   * Read AFTER the Closing Journal is posted, so the current-year result has
   * already moved into retained earnings and the position being carried is the
   * final one.
   */
  private async postCarryForwardJournal(
    transaction: Kysely<DatabaseSchema>,
    input: {
      readonly actorId: string;
      readonly companyId: string;
      readonly firstPeriodId: string;
      readonly nextYear: FiscalYearRow;
      readonly workflow: WorkflowRow;
      readonly year: FiscalYearRow;
    },
  ) {
    // Party dimensions are grouped and carried; document references are not.
    const balances = await sql<{
      accountId: string;
      driverId: string | null;
      employeeId: string | null;
      netDebit: string;
      subledgerId: string | null;
      subledgerType: string | null;
      traderId: string | null;
    }>`
      select l.account_id as "accountId", l.subledger_type as "subledgerType",
             l.subledger_id as "subledgerId", l.trader_id as "traderId",
             l.driver_id as "driverId", l.employee_id as "employeeId",
             sum(l.debit - l.credit)::text as "netDebit"
        from journal_lines l
        join journal_entries j on j.id = l.journal_entry_id and j.company_id = l.company_id
        join chart_of_accounts a on a.id = l.account_id and a.company_id = l.company_id
       where j.company_id = ${input.companyId}::uuid and j.status in ('posted', 'reversed')
         and j.business_date <= ${input.year.endDate}::date
         and a.account_type in (${sql.join(balanceSheetTypes.map((type) => sql`${type}`))})
       group by l.account_id, l.subledger_type, l.subledger_id, l.trader_id,
                l.driver_id, l.employee_id
      having sum(l.debit - l.credit) <> 0
       order by l.account_id
    `.execute(transaction);

    const lines = balances.rows.map((row, index) => {
      const balance = new Decimal(row.netDebit);
      return {
        accountId: row.accountId,
        credit: balance.lessThan(0) ? balance.negated() : new Decimal(0),
        debit: balance.greaterThan(0) ? balance : new Decimal(0),
        dimensions: {
          driverId: row.driverId,
          employeeId: row.employeeId,
          subledgerId: row.subledgerId,
          subledgerType: row.subledgerType,
          traderId: row.traderId,
        },
        lineNumber: index + 1,
      };
    });

    return this.writePostedJournal(transaction, {
      accountingDate: input.nextYear.startDate,
      actorId: input.actorId,
      companyId: input.companyId,
      description: `Opening balances carried forward from ${input.year.code}`,
      fiscalYearId: input.nextYear.id,
      journalType: "opening_balance",
      lines,
      periodId: input.firstPeriodId,
      sourceReference: input.workflow.workflowNumber,
      workflowId: input.workflow.id,
    });
  }

  /**
   * Insert, line, balance, approve, post -- the same sequence
   * `OperationalJournalPostingService` uses for a system-generated Journal.
   *
   * Balance is asserted here before anything is written AND enforced by the
   * database trigger on posting. A Journal that cannot balance is a bug in the
   * caller, not a condition to report to a user.
   */
  private async writePostedJournal(
    transaction: Kysely<DatabaseSchema>,
    input: {
      readonly accountingDate: string;
      readonly actorId: string;
      readonly companyId: string;
      readonly description: string;
      readonly fiscalYearId: string;
      readonly journalType: "closing" | "opening_balance";
      readonly lines: readonly {
        readonly accountId: string;
        readonly credit: Decimal;
        readonly debit: Decimal;
        readonly dimensions?: {
          readonly driverId: string | null;
          readonly employeeId: string | null;
          readonly subledgerId: string | null;
          readonly subledgerType: string | null;
          readonly traderId: string | null;
        };
        readonly lineNumber: number;
      }[];
      readonly periodId?: string;
      readonly periodPredicate?: ReturnType<typeof sql>;
      readonly sourceReference: string;
      readonly workflowId: string;
    },
  ): Promise<{ journalId: string; journalNumber: string; lineCount: number }> {
    const debit = input.lines.reduce((sum, line) => sum.plus(line.debit), new Decimal(0));
    const credit = input.lines.reduce((sum, line) => sum.plus(line.credit), new Decimal(0));
    if (!debit.equals(credit)) {
      throw new ApplicationException(
        "accounting_year_end_journal_not_balanced",
        "The Year-End Journal did not balance and was not written",
        HttpStatus.INTERNAL_SERVER_ERROR,
        [`debit ${debit.toFixed(2)} vs credit ${credit.toFixed(2)}`],
      );
    }
    if (input.lines.length === 0) {
      return { journalId: "", journalNumber: "", lineCount: 0 };
    }

    const periodId =
      input.periodId ??
      (
        await sql<{ id: string }>`
          select id from accounting_periods
           where company_id = ${input.companyId}::uuid
             and fiscal_year_id = ${input.fiscalYearId}::uuid
             and ${input.periodPredicate ?? sql`true`}
           order by period_number desc limit 1
        `.execute(transaction)
      ).rows[0]?.id;
    if (periodId === undefined) {
      this.conflict("accounting_year_end_period_not_found");
    }

    const journalId = randomUUID();
    const journalNumber = await this.history.nextReferenceNumber(
      transaction,
      input.companyId,
      "journal",
      "JRN",
    );
    await sql`
      insert into journal_entries (
        id, company_id, journal_number, accounting_period_id, fiscal_year_id,
        business_date, journal_type, source_type, description, currency, exchange_rate,
        status, source_entity_type, source_entity_id, source_reference, correlation_id,
        total_debit, total_credit, created_by_account_id, updated_by_account_id
      ) values (
        ${journalId}::uuid, ${input.companyId}::uuid, ${journalNumber}, ${periodId}::uuid,
        ${input.fiscalYearId}::uuid, ${input.accountingDate}::date, ${input.journalType},
        ${input.journalType === "closing" ? "period_close" : "opening_balance"},
        ${input.description}, 'AED', 1, 'draft', 'closing_workflow',
        ${input.workflowId}::uuid, ${input.sourceReference}, ${randomUUID()}::uuid,
        ${debit.toFixed(2)}::numeric, ${credit.toFixed(2)}::numeric,
        ${input.actorId}::uuid, ${input.actorId}::uuid
      )
    `.execute(transaction);

    for (const line of input.lines) {
      await sql`
        insert into journal_lines (
          company_id, journal_entry_id, line_number, account_id, debit, credit,
          description, subledger_type, subledger_id, trader_id, driver_id, employee_id,
          account_code_snapshot, created_by_account_id
        )
        select ${input.companyId}::uuid, ${journalId}::uuid, ${line.lineNumber},
               ${line.accountId}::uuid, ${line.debit.toFixed(2)}::numeric,
               ${line.credit.toFixed(2)}::numeric, ${input.description},
               ${line.dimensions?.subledgerType ?? null},
               ${line.dimensions?.subledgerId ?? null}::uuid,
               ${line.dimensions?.traderId ?? null}::uuid,
               ${line.dimensions?.driverId ?? null}::uuid,
               ${line.dimensions?.employeeId ?? null}::uuid,
               a.code, ${input.actorId}::uuid
          from chart_of_accounts a
         where a.id = ${line.accountId}::uuid and a.company_id = ${input.companyId}::uuid
      `.execute(transaction);
    }

    for (const step of ["balanced", "approved", "posted"] as const) {
      await sql`
        update journal_entries
           set status = ${step}, version = version + 1,
               approved_by_account_id = case when ${step} = 'approved' then ${input.actorId}::uuid
                 else approved_by_account_id end,
               approved_at = case when ${step} = 'approved' then now() else approved_at end,
               approval_note = case when ${step} = 'approved'
                 then 'Automatically approved by Year-End execution' else approval_note end,
               posted_by_account_id = case when ${step} = 'posted' then ${input.actorId}::uuid
                 else posted_by_account_id end,
               posted_at = case when ${step} = 'posted' then now() else posted_at end
         where id = ${journalId}::uuid and company_id = ${input.companyId}::uuid
      `.execute(transaction);
    }
    return { journalId, journalNumber, lineCount: input.lines.length };
  }

  /**
   * The next fiscal year: reused when it already matches, created when absent,
   * refused when it exists with different dates.
   *
   * Silently adopting a year whose dates disagree would carry balances into a
   * period the Company did not intend.
   */
  private async resolveNextFiscalYear(
    transaction: Kysely<DatabaseSchema>,
    year: FiscalYearRow,
  ): Promise<FiscalYearRow> {
    const { actorId, companyId } = this.support.context();
    const expected = await sql<{ endDate: string; startDate: string }>`
      select (${year.endDate}::date + interval '1 day')::date::text as "startDate",
             (${year.endDate}::date + interval '1 year')::date::text as "endDate"
    `.execute(transaction);
    const startDate = expected.rows[0]!.startDate;
    const endDate = expected.rows[0]!.endDate;

    const existing = await sql<FiscalYearRow>`
      select id, fiscal_year_code as code, status,
             start_date::text as "startDate", end_date::text as "endDate"
        from fiscal_years
       where company_id = ${companyId}::uuid and start_date = ${startDate}::date
       for update
    `.execute(transaction);
    const found = existing.rows[0];
    if (found !== undefined) {
      if (found.endDate !== endDate) {
        this.conflict("accounting_year_end_next_year_inconsistent");
      }
      return found;
    }

    const id = randomUUID();
    const code = `FY-${startDate.slice(0, 4)}`;
    const created = await sql<FiscalYearRow>`
      insert into fiscal_years (
        id, company_id, fiscal_year_code, name, start_date, end_date, status,
        created_by_account_id
      ) values (
        ${id}::uuid, ${companyId}::uuid, ${code}, ${code}, ${startDate}::date,
        ${endDate}::date, 'open', ${actorId}::uuid
      )
      returning id, fiscal_year_code as code, status,
                start_date::text as "startDate", end_date::text as "endDate"
    `.execute(transaction);
    return created.rows[0]!;
  }

  /**
   * Twelve periods for the new year: generated when absent, reused when
   * complete, refused when partial.
   *
   * A half-generated calendar is the one state that must not be extended --
   * adding the missing periods would silently accept whatever produced the
   * partial set.
   */
  private async resolveNextPeriods(
    transaction: Kysely<DatabaseSchema>,
    nextYear: FiscalYearRow,
  ): Promise<readonly { id: string; periodNumber: number }[]> {
    const { companyId } = this.support.context();
    const existing = await sql<{ id: string; periodNumber: number }>`
      select id, period_number as "periodNumber" from accounting_periods
       where company_id = ${companyId}::uuid and fiscal_year_id = ${nextYear.id}::uuid
       order by period_number
    `.execute(transaction);
    if (existing.rows.length === 12) return existing.rows;
    if (existing.rows.length !== 0) {
      this.conflict("accounting_year_end_next_periods_inconsistent");
    }
    // Reused, not reimplemented: the repository's own generator owns the
    // period code, naming and date conventions.
    const generated = await this.calendar.generatePeriodsInTransaction(transaction, {
      fiscalYearId: nextYear.id,
    });
    return generated.map((row) => ({
      id: String(row.id),
      periodNumber: Number(row.periodNumber),
    }));
  }

  /** The Company's configured retained-earnings account, validated for posting. */
  private async retainedEarningsAccount(transaction: Kysely<DatabaseSchema>): Promise<string> {
    const { companyId } = this.support.context();
    const result = await sql<{ id: string }>`
      select a.id
        from accounting_configurations c
        join chart_of_accounts a
          on a.id = c.retained_earnings_account_id and a.company_id = c.company_id
       where c.company_id = ${companyId}::uuid
         and a.is_active and a.is_posting_account and a.account_type = 'equity'
    `.execute(transaction);
    if (result.rows[0] === undefined) {
      this.conflict("accounting_year_end_retained_earnings_not_configured");
    }
    return result.rows[0]!.id;
  }

  /**
   * Record the execution against the checklist items it satisfied.
   *
   * Written to `check_result` like any readiness answer, so the two are read
   * the same way. Previous readiness audit entries are untouched -- this
   * appends its own audit event rather than rewriting theirs.
   */
  private async markExecutedTasks(
    transaction: Kysely<DatabaseSchema>,
    workflowId: string,
    response: Record<string, unknown>,
    actorId: string,
  ): Promise<void> {
    const { companyId } = this.support.context();
    const checkedAt = new Date().toISOString();
    const payloads = executedTaskKeys.map((taskKey) => ({
      payload: {
        checkedAt,
        checkedByAccountId: actorId,
        executedBy: "year_end_execution",
        message: "Completed by Year-End execution.",
        status: "passed",
        taskKey,
      },
      taskKey,
    }));
    await sql`
      update closing_workflow_tasks t
         set check_result = v.payload, checked_at = ${checkedAt}::timestamptz,
             status = 'completed', completed_by_account_id = ${actorId}::uuid,
             completed_at = now(), updated_at = now(), version = t.version + 1
        from (
          select * from jsonb_to_recordset(${JSON.stringify(payloads)}::jsonb)
            as x("taskKey" text, payload jsonb)
        ) v
       where t.company_id = ${companyId}::uuid and t.closing_workflow_id = ${workflowId}::uuid
         and t.task_key = v."taskKey"
    `.execute(transaction);
    await this.support.audit(transaction, {
      action: "accounting.closing_workflow.year_end_tasks_completed",
      after: { taskKeys: executedTaskKeys, workflowId, ...response },
      correlationId: workflowId,
      subjectId: workflowId,
      subjectType: "closing_workflow",
    });
  }

  private async lockWorkflow(
    database: Kysely<DatabaseSchema>,
    workflowId: string,
  ): Promise<WorkflowRow> {
    const { companyId } = this.support.context();
    const result = await sql<WorkflowRow>`
      select id, workflow_number as "workflowNumber", status, version,
             workflow_type as "workflowType", fiscal_year_id as "fiscalYearId",
             accounting_period_id as "accountingPeriodId",
             submitted_by_account_id as "submittedByAccountId"
        from closing_workflows
       where id = ${workflowId}::uuid and company_id = ${companyId}::uuid
       for update
    `.execute(database);
    if (result.rows[0] === undefined) {
      throw new ApplicationException(
        "accounting_closing_workflow_not_found",
        "The closing workflow was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return result.rows[0]!;
  }

  private async lockFiscalYear(
    database: Kysely<DatabaseSchema>,
    fiscalYearId: string,
  ): Promise<FiscalYearRow> {
    const { companyId } = this.support.context();
    const result = await sql<FiscalYearRow>`
      select id, fiscal_year_code as code, status,
             start_date::text as "startDate", end_date::text as "endDate"
        from fiscal_years
       where id = ${fiscalYearId}::uuid and company_id = ${companyId}::uuid
       for update
    `.execute(database);
    if (result.rows[0] === undefined) {
      throw new ApplicationException(
        "accounting_closing_fiscal_year_not_found",
        "The fiscal year was not found",
        HttpStatus.NOT_FOUND,
      );
    }
    return result.rows[0]!;
  }

  private conflict(code: string): never {
    throw new ApplicationException(
      code,
      "The Year-End execution is not allowed",
      HttpStatus.CONFLICT,
    );
  }
}
