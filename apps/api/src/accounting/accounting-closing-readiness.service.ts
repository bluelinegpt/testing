import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import { AccountingReportService } from "./accounting-report.service.js";

/**
 * Automated readiness checks for a closing workflow.
 *
 * ===========================================================================
 * IT EVALUATES; IT NEVER ADVANCES
 * ===========================================================================
 *
 * Running the checks writes ONE thing: the automated result on each checklist
 * task. It does not move the workflow's status, close or reopen a period,
 * create a Journal, a fiscal year, a period or any financial record, and it
 * writes to no financial source table. Every source is read.
 *
 * That separation is what makes rerunning safe. A check that also advanced the
 * workflow would make "run the checks again" a state change, and nobody would
 * be able to re-examine a failure without altering the thing they were
 * examining.
 *
 * ===========================================================================
 * THE CHECKLIST IS THE TEMPLATE'S, NOT THIS FILE'S
 * ===========================================================================
 *
 * Every result is keyed by a task_key that already exists in
 * accounting-closing.templates.ts. No check invents a checklist item, and a
 * template item with no automated equivalent is recorded as `not_applicable`
 * rather than left blank -- "nobody has checked this" and "there is nothing to
 * check automatically" are different answers and must stay distinguishable.
 *
 * ===========================================================================
 * ONE GROUPED READ, NOT ONE PER TASK
 * ===========================================================================
 *
 * All operational counts come from a single statement. A per-task query would
 * be eleven round trips for one button, and eleven separate snapshots of a
 * moving database -- the Trial Balance check could then disagree with the
 * unposted-Journal check about what was posted.
 *
 * The three statement availability checks reuse `AccountingReportService`
 * rather than recomputing a Trial Balance, a Profit and Loss or a Balance
 * Sheet here. A second implementation of those would eventually disagree with
 * the report a person is looking at, which is the disagreement that matters
 * most at a period close.
 */

/** Bumped when a check's meaning changes, so a stored result says which rule produced it. */
const checkVersion = 1;

export type ReadinessStatus = "failed" | "not_applicable" | "passed" | "warning";

export interface ReadinessCheck {
  readonly amount?: string;
  readonly count?: number;
  readonly message: string;
  /** Where to go and look. A route the application actually serves, or absent. */
  readonly reference?: string;
  readonly status: ReadinessStatus;
  readonly taskKey: string;
}

interface WorkflowContext {
  readonly accountingPeriodId: string | null;
  readonly fiscalYearEnd: string;
  readonly fiscalYearId: string;
  readonly fiscalYearStart: string;
  readonly id: string;
  readonly periodEnd: string | null;
  readonly periodStart: string | null;
  readonly status: string;
  readonly workflowType: "monthly" | "year_end";
}

/** Every operational count this feature needs, in one statement. */
interface OperationalCounts {
  readonly closingJournals: number;
  readonly driverOutstandingAmount: string;
  readonly driverOutstandingCount: number;
  readonly expensesOutstandingAmount: string;
  readonly expensesOutstandingCount: number;
  readonly expensesUnapproved: number;
  readonly failedEvents: number;
  readonly nextPeriodCount: number;
  readonly nextYearExists: number;
  readonly nextYearFirstPeriodOpen: number;
  readonly openMonthlyPeriods: number;
  readonly payrollOutstandingAmount: string;
  readonly payrollUnapproved: number;
  readonly traderOutstandingAmount: string;
  readonly traderOutstandingCount: number;
  readonly unpostedJournals: number;
  readonly unreconciledMovements: number;
  readonly waitingEvents: number;
}

@Injectable()
export class AccountingClosingReadinessService {
  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager)
    private readonly transactions: KyselyTransactionManager,
    @Inject(AccountingOperationSupport)
    private readonly support: AccountingOperationSupport,
    @Inject(AccountingReportService) private readonly reports: AccountingReportService,
  ) {}

  /**
   * Evaluate every automated check and persist the results.
   *
   * Safe to rerun: each run REPLACES the automated result on each task and
   * touches nothing else -- not the task's status, assignee, notes, comments or
   * attachments, and not the workflow's status.
   */
  public async run(workflowId: string) {
    this.support.assertPermission("accounting.manage");
    const { actorId } = this.support.context();
    const workflow = await this.workflowContext(this.database, workflowId);
    if (workflow.status === "closed" || workflow.status === "cancelled") {
      throw new ApplicationException(
        "accounting_closing_workflow_not_editable",
        "A closed or cancelled workflow cannot be re-checked",
        HttpStatus.CONFLICT,
      );
    }
    const checks = await this.evaluate(workflow);
    const checkedAt = new Date().toISOString();

    await this.transactions.execute(async (transaction) => {
      // ONE statement for every task, not one per check: eleven updates would
      // be eleven round trips and eleven timestamps for a single evaluation.
      await sql`
        update closing_workflow_tasks t
           set check_result = v.payload, checked_at = ${checkedAt}::timestamptz,
               updated_at = now(), version = t.version + 1
          from (
            select * from jsonb_to_recordset(${JSON.stringify(
              checks.map((check) => ({
                payload: {
                  ...check,
                  checkVersion,
                  checkedAt,
                  checkedByAccountId: actorId,
                },
                taskKey: check.taskKey,
              })),
            )}::jsonb) as x("taskKey" text, payload jsonb)
          ) v
         where t.company_id = ${this.support.context().companyId}::uuid
           and t.closing_workflow_id = ${workflowId}::uuid
           and t.task_key = v."taskKey"
      `.execute(transaction);

      // Previous results are preserved through the audit trail, not by a
      // history table -- see the reported schema limitation.
      await this.support.audit(transaction, {
        action: "accounting.closing_workflow.readiness_checked",
        after: { checkVersion, checkedAt, checks, workflowId },
        correlationId: workflowId,
        subjectId: workflowId,
        subjectType: "closing_workflow",
      });
    });

    return this.summarise(workflow, checks, checkedAt);
  }

  /** Read-only view of the LAST stored results. Runs nothing and writes nothing. */
  public async latest(workflowId: string) {
    this.support.assertPermission("accounting.view");
    const { companyId } = this.support.context();
    const workflow = await this.workflowContext(this.database, workflowId);
    const rows = await sql<{
      checkResult: Record<string, unknown> | null;
      checkedAt: string | null;
      isMandatory: boolean;
      taskKey: string;
    }>`
      select task_key as "taskKey", is_mandatory as "isMandatory",
             check_result as "checkResult", checked_at::text as "checkedAt"
        from closing_workflow_tasks
       where company_id = ${companyId}::uuid and closing_workflow_id = ${workflowId}::uuid
       order by sequence, id
    `.execute(this.database);
    const checks = rows.rows
      .filter((row) => row.checkResult !== null)
      .map((row) => row.checkResult as unknown as ReadinessCheck);
    return this.summarise(workflow, checks, rows.rows[0]?.checkedAt ?? null);
  }

  /**
   * The gate the transition path calls.
   *
   * A task is blocking when it is MANDATORY, has an automated check defined,
   * and either failed or was never evaluated. An unevaluated automated check is
   * not a pass: treating it as one would let a workflow reach approval by
   * simply never running the checks.
   *
   * Manual tasks -- those with no automated equivalent -- never block here.
   * They are the checklist the person completes, and the checklist status is a
   * separate question from the automated evidence.
   */
  public async assertReadyForApproval(
    database: Kysely<DatabaseSchema>,
    workflowId: string,
  ): Promise<void> {
    const { companyId } = this.support.context();
    const rows = await sql<{
      status: string | null;
      taskKey: string;
    }>`
      select task_key as "taskKey", check_result->>'status' as status
        from closing_workflow_tasks
       where company_id = ${companyId}::uuid and closing_workflow_id = ${workflowId}::uuid
         and is_mandatory
       order by sequence, id
    `.execute(database);
    const automated = new Set(automatedTaskKeys);
    const blocking = rows.rows.filter(
      (row) => automated.has(row.taskKey) && row.status !== "passed" && row.status !== "warning"
        && row.status !== "not_applicable",
    );
    if (blocking.length === 0) return;
    throw new ApplicationException(
      "accounting_closing_readiness_not_passed",
      "Mandatory readiness checks have not passed for this closing workflow",
      HttpStatus.CONFLICT,
      blocking.map((row) =>
        row.status === null
          ? `${row.taskKey}: not evaluated`
          : `${row.taskKey}: ${row.status}`,
      ),
    );
  }

  private summarise(
    workflow: WorkflowContext,
    checks: readonly ReadinessCheck[],
    checkedAt: string | null,
  ) {
    const counts = {
      failed: checks.filter((check) => check.status === "failed").length,
      notApplicable: checks.filter((check) => check.status === "not_applicable").length,
      passed: checks.filter((check) => check.status === "passed").length,
      warning: checks.filter((check) => check.status === "warning").length,
    };
    return {
      checkVersion,
      checkedAt,
      checks,
      // Advisory: the caller decides what to do. Nothing here moves a status.
      readyForApproval: counts.failed === 0 && checks.length > 0,
      summary: counts,
      workflowId: workflow.id,
      workflowType: workflow.workflowType,
    };
  }

  private async evaluate(workflow: WorkflowContext): Promise<readonly ReadinessCheck[]> {
    const from = workflow.workflowType === "monthly" ? workflow.periodStart! : workflow.fiscalYearStart;
    const to = workflow.workflowType === "monthly" ? workflow.periodEnd! : workflow.fiscalYearEnd;
    const [counts, statements] = await Promise.all([
      this.operationalCounts(workflow, from, to),
      this.statementAvailability(from, to),
    ]);
    return workflow.workflowType === "monthly"
      ? this.monthlyChecks(counts, statements)
      : this.yearEndChecks(counts, statements);
  }

  /** Every operational count, in one round trip. */
  private async operationalCounts(
    workflow: WorkflowContext,
    from: string,
    to: string,
  ): Promise<OperationalCounts> {
    const { companyId } = this.support.context();
    const result = await sql<OperationalCounts>`
      select
        -- Every status the CHECK constraint permits is accounted for. An event
        -- stuck in 'processing', 'retry_pending' or 'blocked_configuration'
        -- used to count as neither failed nor waiting, so both checks passed
        -- while the ledger was incomplete -- the exact thing they exist to
        -- catch. 'blocked_configuration' is a failure: it needs a person.
        (select count(*)::int from accounting_events
          where company_id = ${companyId}::uuid
            and effective_accounting_date between ${from}::date and ${to}::date
            and processing_status in ('failed', 'blocked_configuration')) as "failedEvents",
        (select count(*)::int from accounting_events
          where company_id = ${companyId}::uuid
            and effective_accounting_date between ${from}::date and ${to}::date
            and processing_status in ('received', 'processing', 'validated', 'retry_pending'))
          as "waitingEvents",
        (select count(*)::int from journal_entries
          where company_id = ${companyId}::uuid
            and business_date between ${from}::date and ${to}::date
            and status not in ('posted', 'reversed', 'cancelled')) as "unpostedJournals",
        -- Confirmed money movement with no posted Journal behind it.
        (select count(*)::int from cash_bank_movements m
          left join accounting_events e
            on e.id = m.accounting_event_id and e.company_id = m.company_id
          where m.company_id = ${companyId}::uuid
            and m.accounting_date between ${from}::date and ${to}::date
            and m.status = 'confirmed'
            and (e.id is null or e.processing_status <> 'posted')) as "unreconciledMovements",
        (select count(*)::int from orders
          where company_id = ${companyId}::uuid and order_date <= ${to}::date
            and trader_outstanding_balance > 0) as "traderOutstandingCount",
        (select coalesce(sum(trader_outstanding_balance), 0)::text from orders
          where company_id = ${companyId}::uuid and order_date <= ${to}::date
            and trader_outstanding_balance > 0) as "traderOutstandingAmount",
        (select count(*)::int from outsourced_driver_fee_accruals
          where company_id = ${companyId}::uuid and accrual_business_date <= ${to}::date
            and status in ('accrued', 'partially_paid')
            and outstanding_amount > 0) as "driverOutstandingCount",
        (select coalesce(sum(outstanding_amount), 0)::text from outsourced_driver_fee_accruals
          where company_id = ${companyId}::uuid and accrual_business_date <= ${to}::date
            and status in ('accrued', 'partially_paid')
            and outstanding_amount > 0) as "driverOutstandingAmount",
        (select count(*)::int from payroll_periods
          where company_id = ${companyId}::uuid
            and payroll_month between date_trunc('month', ${from}::date)::date and ${to}::date
            and status in ('draft', 'calculated')) as "payrollUnapproved",
        (select coalesce(sum(total_outstanding), 0)::text from payroll_periods
          where company_id = ${companyId}::uuid
            and payroll_month between date_trunc('month', ${from}::date)::date and ${to}::date
            and status not in ('reversed')) as "payrollOutstandingAmount",
        (select count(*)::int from general_expenses
          where company_id = ${companyId}::uuid
            and accounting_date between ${from}::date and ${to}::date
            and status in ('draft', 'submitted')) as "expensesUnapproved",
        (select count(*)::int from general_expenses
          where company_id = ${companyId}::uuid
            and accounting_date between ${from}::date and ${to}::date
            and outstanding_amount > 0 and status not in ('cancelled', 'reversed'))
          as "expensesOutstandingCount",
        (select coalesce(sum(outstanding_amount), 0)::text from general_expenses
          where company_id = ${companyId}::uuid
            and accounting_date between ${from}::date and ${to}::date
            and outstanding_amount > 0 and status not in ('cancelled', 'reversed'))
          as "expensesOutstandingAmount",
        -- Year-End only. Monthly periods of this fiscal year still open.
        -- Compared against 'closed' alone rather than a NOT IN list: the
        -- permitted statuses are future/open/soft_closed/closed/reopened, and
        -- the earlier list named 'locked', which does not exist. Only a period
        -- in 'closed' is closed.
        (select count(*)::int from accounting_periods
          where company_id = ${companyId}::uuid
            and fiscal_year_id = ${workflow.fiscalYearId}::uuid
            and status <> 'closed') as "openMonthlyPeriods",
        (select count(*)::int from journal_entries
          where company_id = ${companyId}::uuid
            and fiscal_year_id = ${workflow.fiscalYearId}::uuid
            and journal_type = 'closing') as "closingJournals",
        (select count(*)::int from fiscal_years
          where company_id = ${companyId}::uuid
            and start_date > ${workflow.fiscalYearEnd}::date) as "nextYearExists",
        (select count(*)::int from accounting_periods p
          join fiscal_years y on y.id = p.fiscal_year_id and y.company_id = p.company_id
          where p.company_id = ${companyId}::uuid
            and y.start_date > ${workflow.fiscalYearEnd}::date) as "nextPeriodCount",
        (select count(*)::int from accounting_periods p
          join fiscal_years y on y.id = p.fiscal_year_id and y.company_id = p.company_id
          where p.company_id = ${companyId}::uuid
            and y.start_date > ${workflow.fiscalYearEnd}::date
            and p.period_number = 1 and p.status in ('open', 'reopened'))
          as "nextYearFirstPeriodOpen"
    `.execute(this.database);
    return result.rows[0]!;
  }

  /**
   * Statement availability, from the REPORT service.
   *
   * Not recomputed here. A second Trial Balance implementation would
   * eventually disagree with the one a person is reading, and a period close is
   * the worst possible moment to discover that.
   */
  private async statementAvailability(from: string, to: string) {
    const query = { dateFrom: from, dateTo: to };
    const [trial, profitAndLoss, balanceSheet] = await Promise.all([
      this.reports.report("trial-balance", query),
      this.reports.report("profit-and-loss", query),
      this.reports.report("balance-sheet", query),
    ]);
    return {
      balanceSheetRows: balanceSheet.total,
      profitAndLossRows: profitAndLoss.total,
      // A non-zero difference means debits and credits do not agree.
      trialBalanceDifference: String(trial.totals.difference ?? "0"),
      trialBalanceRows: trial.total,
    };
  }

  private monthlyChecks(
    counts: OperationalCounts,
    statements: Awaited<ReturnType<AccountingClosingReadinessService["statementAvailability"]>>,
  ): readonly ReadinessCheck[] {
    const balanced = Number(statements.trialBalanceDifference) === 0;
    return [
      // Waiting Events mean the ledger is still catching up with operations.
      this.check("operational_transactions_posted", counts.waitingEvents === 0, {
        count: counts.waitingEvents,
        failMessage: "Accounting Events are still awaiting processing for this period.",
        passMessage: "Every Accounting Event for this period has been processed.",
        reference: "/accounting/events",
      }),
      this.check("failed_accounting_events_resolved", counts.failedEvents === 0, {
        count: counts.failedEvents,
        failMessage: "Accounting Events failed to post and are unresolved.",
        passMessage: "No Accounting Event failed in this period.",
        reference: "/accounting/events",
      }),
      this.check("unposted_journals_reviewed", counts.unpostedJournals === 0, {
        count: counts.unpostedJournals,
        failMessage: "Journals in this period are not posted.",
        passMessage: "Every Journal in this period is posted.",
        reference: "/accounting/journals",
      }),
      this.check("cash_bank_reconciled", counts.unreconciledMovements === 0, {
        count: counts.unreconciledMovements,
        failMessage: "Confirmed Cash/Bank Movements have no posted Journal.",
        passMessage: "Every confirmed Cash/Bank Movement is posted.",
        reference: "/accounting/reconciliation",
      }),
      // An outstanding balance is not an error -- it is normal trading -- so
      // this warns rather than blocks. It exists so the figure is SEEN before
      // the period is signed off, not to prevent signing off.
      this.warn(
        "trader_driver_balances_reviewed",
        counts.traderOutstandingCount === 0 && counts.driverOutstandingCount === 0,
        {
          amount: counts.traderOutstandingAmount,
          count: counts.traderOutstandingCount + counts.driverOutstandingCount,
          passMessage: "No Trader or Driver balance is outstanding.",
          reference: "/accounting/payment-position",
          warnMessage: "Trader and Driver balances remain outstanding. Review before closing.",
        },
      ),
      this.check("payroll_reviewed", counts.payrollUnapproved === 0, {
        amount: counts.payrollOutstandingAmount,
        count: counts.payrollUnapproved,
        failMessage: "Payroll periods covering this month are not approved.",
        passMessage: "Payroll for this period is approved.",
        reference: "/payroll",
      }),
      this.check("expenses_reviewed", counts.expensesUnapproved === 0, {
        amount: counts.expensesOutstandingAmount,
        count: counts.expensesUnapproved,
        failMessage: "General Expenses in this period are not approved.",
        passMessage: "Every General Expense in this period is approved.",
        reference: "/accounting/expenses",
      }),
      this.check("trial_balance_reviewed", statements.trialBalanceRows > 0 && balanced, {
        amount: statements.trialBalanceDifference,
        count: statements.trialBalanceRows,
        failMessage:
          statements.trialBalanceRows === 0
            ? "No posted activity: a Trial Balance cannot be produced for this period."
            : "The Trial Balance does not balance.",
        passMessage: "The Trial Balance is available and balances.",
        reference: "/accounting/reports/trial-balance",
      }),
      this.check("profit_and_loss_reviewed", statements.profitAndLossRows > 0, {
        count: statements.profitAndLossRows,
        failMessage: "No Profit and Loss activity exists for this period.",
        passMessage: "The Profit and Loss statement is available.",
        reference: "/accounting/reports/profit-and-loss",
      }),
      this.check("balance_sheet_reviewed", statements.balanceSheetRows > 0, {
        count: statements.balanceSheetRows,
        failMessage: "No Balance Sheet activity exists for this period.",
        passMessage: "The Balance Sheet is available.",
        reference: "/accounting/reports/balance-sheet",
      }),
      // A person's sign-off. Nothing automated can stand in for it.
      this.manual("final_approval", "Final approval is a manual decision and is not checked here."),
    ];
  }

  private yearEndChecks(
    counts: OperationalCounts,
    statements: Awaited<ReturnType<AccountingClosingReadinessService["statementAvailability"]>>,
  ): readonly ReadinessCheck[] {
    const balanced = Number(statements.trialBalanceDifference) === 0;
    // Failed Events and unposted Journals have no Year-End template key of
    // their own, and inventing one is forbidden. They are folded into the final
    // Trial Balance check, which is where they actually matter: a Trial Balance
    // computed over an incomplete ledger is not final.
    const ledgerComplete = counts.failedEvents === 0 && counts.unpostedJournals === 0;
    return [
      this.check("all_monthly_periods_closed", counts.openMonthlyPeriods === 0, {
        count: counts.openMonthlyPeriods,
        failMessage: "Accounting periods in this fiscal year are still open.",
        passMessage: "Every accounting period in this fiscal year is closed.",
        reference: "/accounting/fiscal-periods",
      }),
      this.check(
        "final_trial_balance",
        statements.trialBalanceRows > 0 && balanced && ledgerComplete,
        {
          amount: statements.trialBalanceDifference,
          count: counts.failedEvents + counts.unpostedJournals,
          failMessage: ledgerComplete
            ? "The final Trial Balance does not balance or has no activity."
            : "The ledger is incomplete: Accounting Events failed or Journals are unposted.",
          passMessage: "The final Trial Balance is available, balances, and the ledger is complete.",
          reference: "/accounting/reports/trial-balance",
        },
      ),
      this.check("final_profit_and_loss", statements.profitAndLossRows > 0, {
        count: statements.profitAndLossRows,
        failMessage: "No Profit and Loss activity exists for this fiscal year.",
        passMessage: "The final Profit and Loss statement is available.",
        reference: "/accounting/reports/profit-and-loss",
      }),
      this.check("final_balance_sheet", statements.balanceSheetRows > 0, {
        count: statements.balanceSheetRows,
        failMessage: "No Balance Sheet activity exists for this fiscal year.",
        passMessage: "The final Balance Sheet is available.",
        reference: "/accounting/reports/balance-sheet",
      }),
      // Reports whether one ALREADY exists. It does not create one, and an
      // existing closing Journal is a warning rather than a pass, because a
      // year closed twice is the mistake this is watching for.
      this.warn("closing_journal_prepared", counts.closingJournals === 0, {
        count: counts.closingJournals,
        passMessage: "No Closing Journal exists yet for this fiscal year.",
        reference: "/accounting/journals",
        warnMessage: "A Closing Journal already exists for this fiscal year.",
      }),
      this.manual(
        "profit_loss_transferred",
        "Transferring the result to retained earnings is not performed or checked by this feature.",
      ),
      this.manual(
        "balances_carried_forward",
        "Carrying balances forward is not performed or checked by this feature.",
      ),
      this.warn("next_fiscal_year_created", counts.nextYearExists > 0, {
        count: counts.nextYearExists,
        passMessage: "The next fiscal year exists.",
        reference: "/accounting/fiscal-years",
        warnMessage: "No fiscal year follows this one. It is not created by this feature.",
      }),
      this.warn("next_periods_created", counts.nextPeriodCount >= 12, {
        count: counts.nextPeriodCount,
        passMessage: "The next fiscal year has its accounting periods.",
        reference: "/accounting/fiscal-periods",
        warnMessage: "The next fiscal year does not have twelve accounting periods.",
      }),
      this.warn("first_new_period_opened", counts.nextYearFirstPeriodOpen > 0, {
        count: counts.nextYearFirstPeriodOpen,
        passMessage: "The first period of the next fiscal year is open.",
        reference: "/accounting/fiscal-periods",
        warnMessage: "The first period of the next fiscal year is not open.",
      }),
      this.manual(
        "prior_year_locked",
        "Locking the prior year is not performed or checked by this feature.",
      ),
    ];
  }

  /** A binary check: passed, or a blocking failure. */
  private check(
    taskKey: string,
    passed: boolean,
    detail: {
      readonly amount?: string;
      readonly count?: number;
      readonly failMessage: string;
      readonly passMessage: string;
      readonly reference?: string;
    },
  ): ReadinessCheck {
    return {
      ...(detail.amount === undefined ? {} : { amount: detail.amount }),
      ...(detail.count === undefined ? {} : { count: detail.count }),
      message: passed ? detail.passMessage : detail.failMessage,
      ...(detail.reference === undefined ? {} : { reference: detail.reference }),
      status: passed ? "passed" : "failed",
      taskKey,
    };
  }

  /** A check whose negative answer is informative rather than disqualifying. */
  private warn(
    taskKey: string,
    passed: boolean,
    detail: {
      readonly amount?: string;
      readonly count?: number;
      readonly passMessage: string;
      readonly reference?: string;
      readonly warnMessage: string;
    },
  ): ReadinessCheck {
    return {
      ...(detail.amount === undefined ? {} : { amount: detail.amount }),
      ...(detail.count === undefined ? {} : { count: detail.count }),
      message: passed ? detail.passMessage : detail.warnMessage,
      ...(detail.reference === undefined ? {} : { reference: detail.reference }),
      status: passed ? "passed" : "warning",
      taskKey,
    };
  }

  /** Recorded explicitly, so "nothing to check" never looks like "not checked". */
  private manual(taskKey: string, message: string): ReadinessCheck {
    return { message, status: "not_applicable", taskKey };
  }

  private async workflowContext(
    database: Kysely<DatabaseSchema>,
    workflowId: string,
  ): Promise<WorkflowContext> {
    const { companyId } = this.support.context();
    const result = await sql<WorkflowContext>`
      select w.id, w.workflow_type as "workflowType", w.status,
             w.fiscal_year_id as "fiscalYearId",
             w.accounting_period_id as "accountingPeriodId",
             y.start_date::text as "fiscalYearStart", y.end_date::text as "fiscalYearEnd",
             p.period_start::text as "periodStart", p.period_end::text as "periodEnd"
        from closing_workflows w
        join fiscal_years y on y.id = w.fiscal_year_id and y.company_id = w.company_id
        left join accounting_periods p
          on p.id = w.accounting_period_id and p.company_id = w.company_id
       where w.id = ${workflowId}::uuid and w.company_id = ${companyId}::uuid
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
}

/**
 * Template keys that HAVE an automated check.
 *
 * Anything absent here is a manual item and never blocks approval. Kept beside
 * the checks rather than derived from them so the blocking gate does not have
 * to run an evaluation to find out what it is gating on.
 */
export const automatedTaskKeys: readonly string[] = [
  "operational_transactions_posted",
  "failed_accounting_events_resolved",
  "unposted_journals_reviewed",
  "cash_bank_reconciled",
  "trader_driver_balances_reviewed",
  "payroll_reviewed",
  "expenses_reviewed",
  "trial_balance_reviewed",
  "profit_and_loss_reviewed",
  "balance_sheet_reviewed",
  "all_monthly_periods_closed",
  "final_trial_balance",
  "final_profit_and_loss",
  "final_balance_sheet",
  "closing_journal_prepared",
  "next_fiscal_year_created",
  "next_periods_created",
  "first_new_period_opened",
];
