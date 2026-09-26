import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type {
  KyselyTransactionManager,
  TransactionWork,
} from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import type { IdentityContextAccessor } from "../security/identity-context.js";
import type { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { AccountingClosingReadinessService } from "./accounting-closing-readiness.service.js";
import { AccountingClosingService } from "./accounting-closing.service.js";
import { AccountingOperationSupport } from "./accounting-operation.support.js";
import { AccountingReportService } from "./accounting-report.service.js";

/**
 * Automated readiness checks, against a real database.
 *
 * Every case asserts the SAME two things a defect would break: that a source
 * problem produces a `failed` result on the right template key, and that a
 * failed result actually stops the workflow reaching approval. A check that
 * reported correctly but did not block would look healthy in every screenshot
 * and let a period be signed off over an incomplete ledger.
 *
 * The real services run against real fixtures -- nothing is stubbed -- because
 * the claim under test is what the SQL counts, and a stub would only confirm
 * the test author's belief about it.
 *
 * Everything runs inside one transaction that is rolled back, so no Company,
 * period, Journal, Event or financial row created here outlives the test.
 */

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `closing_r_${++this.sequence}`;
    await sql.raw(`savepoint ${savepoint}`).execute(this.transaction);
    try {
      const result = await work(this.transaction);
      await sql.raw(`release savepoint ${savepoint}`).execute(this.transaction);
      return result;
    } catch (error) {
      await sql.raw(`rollback to savepoint ${savepoint}`).execute(this.transaction);
      await sql.raw(`release savepoint ${savepoint}`).execute(this.transaction);
      throw error;
    }
  }
}

interface Fixture {
  readonly approverId: string;
  readonly cashGl: string;
  readonly companyId: string;
  readonly fiscalYearId: string;
  readonly periodEnd: string;
  readonly periodId: string;
  readonly periodStart: string;
  readonly preparerId: string;
  readonly revenueGl: string;
}

/** A mutable identity, so one test can act as preparer then as approver. */
class MutableIdentity {
  public actorId: string;
  public permissions: Set<string>;
  public constructor(
    private readonly companyId: string,
    actorId: string,
    permissions: readonly string[],
  ) {
    this.actorId = actorId;
    this.permissions = new Set(permissions);
  }
  public current() {
    return {
      companyId: this.companyId,
      forcePasswordChange: false,
      identityId: this.actorId,
      kind: "company_user" as const,
      permissions: this.permissions,
      sessionId: randomUUID(),
    };
  }
}

/**
 * A Company whose period passes every blocking check.
 *
 * One posted, balanced Journal (Cash debit / Revenue credit) is enough to make
 * the Trial Balance, the Profit and Loss and the Balance Sheet all available
 * and in agreement. Each failure case then adds exactly one problem, so a
 * failing assertion names its own cause.
 */
async function seed(transaction: Transaction<DatabaseSchema>): Promise<Fixture> {
  const companyId = randomUUID();
  const preparerId = randomUUID();
  const approverId = randomUUID();
  const cashGl = randomUUID();
  const revenueGl = randomUUID();
  const fiscalYearId = randomUUID();
  const periodId = randomUUID();
  const journalId = randomUUID();
  const short = companyId.slice(0, 8);

  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${companyId}::uuid,${`CR-${short}`},${`cr-${short}`},'Closing Readiness Test','active',now())`.execute(
    transaction,
  );
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash) values
    (${preparerId}::uuid,${companyId}::uuid,'company_user',${`cr.p.${preparerId}`},'x'),
    (${approverId}::uuid,${companyId}::uuid,'company_user',${`cr.a.${approverId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into chart_of_accounts(
      id,company_id,code,name_en,account_type,account_class,normal_balance,is_posting_account,is_active
    ) values
      (${cashGl}::uuid,${companyId}::uuid,'1010','Cash on hand','asset','cash','debit',true,true),
      (${revenueGl}::uuid,${companyId}::uuid,'4010','Delivery revenue','revenue','delivery_revenue',
        'credit',true,true)`.execute(transaction);

  const periodStart = new Date(Date.UTC(2026, 0, 1)).toISOString().slice(0, 10);
  const periodEnd = new Date(Date.UTC(2026, 0, 31)).toISOString().slice(0, 10);
  await sql`insert into fiscal_years(
      id,company_id,fiscal_year_code,name,start_date,end_date,status,created_by_account_id
    ) values(${fiscalYearId}::uuid,${companyId}::uuid,'FY-2026','FY 2026',
      '2026-01-01'::date,'2026-12-31'::date,'open',${preparerId}::uuid)`.execute(transaction);
  await sql`insert into accounting_periods(
      id,company_id,fiscal_year_id,period_code,name,period_number,period_start,period_end,status
    ) values(${periodId}::uuid,${companyId}::uuid,${fiscalYearId}::uuid,'P01','January 2026',1,
      ${periodStart}::date,${periodEnd}::date,'open')`.execute(transaction);

  await postedJournal(transaction, {
    accountingPeriodId: periodId,
    actorId: preparerId,
    companyId,
    creditAccountId: revenueGl,
    creditAmount: "100",
    debitAccountId: cashGl,
    debitAmount: "100",
    fiscalYearId,
    id: journalId,
    journalNumber: "JRN-BASE-1",
    journalType: "operational",
  });

  return {
    approverId,
    cashGl,
    companyId,
    fiscalYearId,
    periodEnd,
    periodId,
    periodStart,
    preparerId,
    revenueGl,
  };
}

/** Draft, then lines, then balanced → approved → posted: the real lifecycle. */
async function postedJournal(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly accountingPeriodId: string;
    readonly actorId: string;
    readonly companyId: string;
    readonly creditAccountId: string;
    readonly creditAmount: string;
    readonly debitAccountId: string;
    readonly debitAmount: string;
    readonly fiscalYearId: string;
    readonly id: string;
    readonly journalNumber: string;
    readonly journalType: string;
  },
): Promise<void> {
  await sql`insert into journal_entries(
      id,company_id,journal_number,accounting_period_id,fiscal_year_id,business_date,source_type,
      description,status,journal_type,created_by_account_id,total_debit,total_credit
    ) values(${input.id}::uuid,${input.companyId}::uuid,${input.journalNumber},
      ${input.accountingPeriodId}::uuid,${input.fiscalYearId}::uuid,'2026-01-15'::date,'manual',
      'Fixture journal','draft',${input.journalType},${input.actorId}::uuid,
      ${input.debitAmount}::numeric,${input.creditAmount}::numeric)`.execute(transaction);
  await sql`insert into journal_lines(
      company_id,journal_entry_id,line_number,account_id,debit,credit,account_code_snapshot
    ) values
      (${input.companyId}::uuid,${input.id}::uuid,1,${input.debitAccountId}::uuid,
        ${input.debitAmount}::numeric,0,'1010'),
      (${input.companyId}::uuid,${input.id}::uuid,2,${input.creditAccountId}::uuid,
        0,${input.creditAmount}::numeric,'4010')`.execute(transaction);
  for (const step of ["balanced", "approved", "posted"]) {
    await sql`update journal_entries
         set status = ${step},
             approved_by_account_id = case when ${step} = 'approved' then ${input.actorId}::uuid
               else approved_by_account_id end,
             approved_at = case when ${step} = 'approved' then now() else approved_at end,
             posted_by_account_id = case when ${step} = 'posted' then ${input.actorId}::uuid
               else posted_by_account_id end,
             posted_at = case when ${step} = 'posted' then now() else posted_at end
       where id = ${input.id}::uuid and company_id = ${input.companyId}::uuid`.execute(transaction);
  }
}

function buildServices(transaction: Transaction<DatabaseSchema>, fixture: Fixture) {
  const identity = new MutableIdentity(fixture.companyId, fixture.preparerId, [
    "accounting.manage",
    "accounting.view",
    "accounting.approve",
  ]);
  const tenants = {
    current: () => ({ companyId: fixture.companyId, identityId: identity.actorId }),
  } as unknown as TenantContextAccessor;
  const identities = identity as unknown as IdentityContextAccessor;
  const database = transaction as unknown as Kysely<DatabaseSchema>;
  const manager = new SavepointTransactionManager(
    transaction,
  ) as unknown as KyselyTransactionManager;
  const history = new OperationsHistoryWriter();
  const support = new AccountingOperationSupport(tenants, identities, history);
  const readiness = new AccountingClosingReadinessService(
    database,
    manager,
    support,
    new AccountingReportService(database, support),
  );
  const closing = new AccountingClosingService(database, manager, support, history, readiness);
  return { closing, identity, readiness };
}

const createWorkflow = async (
  closing: AccountingClosingService,
  fixture: Fixture,
  type: "monthly" | "year_end",
) =>
  (await closing.create(
    {
      ...(type === "monthly" ? { accountingPeriodId: fixture.periodId } : {}),
      assignedToAccountId: fixture.preparerId,
      dueDate: "2026-02-15",
      fiscalYearId: fixture.fiscalYearId,
      priority: "normal",
      workflowType: type,
    },
    `closing-${randomUUID()}`,
  )) as { id: string; workflowNumber: string };

/** taskKey → stored result, for readable assertions. */
const byKey = (result: { checks: readonly { status: string; taskKey: string }[] }) =>
  new Map(result.checks.map((check) => [check.taskKey, check]));

async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
): Promise<void> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const marker = new Error("rollback closing readiness test");
  try {
    await expect(
      database.transaction().execute(async (transaction) => {
        await work(transaction);
        throw marker;
      }),
    ).rejects.toBe(marker);
  } finally {
    // destroy() ends the underlying pool; calling pool.end() as well throws.
    await database.destroy();
  }
}

/** An Accounting Event in a chosen processing state, inside the period. */
const insertEvent = (
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  processingStatus: string,
) =>
  sql`insert into accounting_events(
      company_id,event_type,event_version,source_entity_type,source_entity_id,
      effective_accounting_date,correlation_id,idempotency_key,event_hash,actor_type,
      description,processing_status
    ) values(${fixture.companyId}::uuid,'general_expense_approved',1,'general_expense',
      ${randomUUID()}::uuid,'2026-01-10'::date,${randomUUID()}::uuid,${randomUUID()},
      ${randomUUID()},'system','Fixture event',${processingStatus})`.execute(transaction);

describe.skipIf(!runDatabaseTests)("Closing readiness — Monthly", () => {
  it("passes every blocking check on a clean period", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, readiness } = buildServices(transaction, fixture);
      const workflow = await createWorkflow(closing, fixture, "monthly");
      const result = await readiness.run(workflow.id);
      const checks = byKey(result);
      for (const key of [
        "operational_transactions_posted",
        "failed_accounting_events_resolved",
        "unposted_journals_reviewed",
        "cash_bank_reconciled",
        "payroll_reviewed",
        "expenses_reviewed",
        "trial_balance_reviewed",
        "profit_and_loss_reviewed",
        "balance_sheet_reviewed",
      ]) {
        expect(checks.get(key)?.status, key).toBe("passed");
      }
      expect(result.summary.failed).toBe(0);
      expect(result.readyForApproval).toBe(true);
      // A person's sign-off: recorded as not applicable, never as passed.
      expect(checks.get("final_approval")?.status).toBe("not_applicable");
    });
  });

  it("blocks on failed and blocked Accounting Events", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, readiness } = buildServices(transaction, fixture);
      const workflow = await createWorkflow(closing, fixture, "monthly");
      await insertEvent(transaction, fixture, "failed");
      // `blocked_configuration` needs a person exactly as `failed` does, and
      // used to count as neither failed nor waiting.
      await insertEvent(transaction, fixture, "blocked_configuration");
      const checks = byKey(await readiness.run(workflow.id));
      expect(checks.get("failed_accounting_events_resolved")?.status).toBe("failed");
      expect(
        (checks.get("failed_accounting_events_resolved") as unknown as { count: number }).count,
      ).toBe(2);
    });
  });

  it("blocks on Accounting Events still awaiting processing", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, readiness } = buildServices(transaction, fixture);
      const workflow = await createWorkflow(closing, fixture, "monthly");
      // Every unfinished state, including the two that were previously missed.
      for (const state of ["received", "processing", "validated", "retry_pending"]) {
        await insertEvent(transaction, fixture, state);
      }
      const checks = byKey(await readiness.run(workflow.id));
      expect(checks.get("operational_transactions_posted")?.status).toBe("failed");
      expect(
        (checks.get("operational_transactions_posted") as unknown as { count: number }).count,
      ).toBe(4);
    });
  });

  it("blocks on unposted Journals", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, readiness } = buildServices(transaction, fixture);
      const workflow = await createWorkflow(closing, fixture, "monthly");
      await sql`insert into journal_entries(
          company_id,journal_number,accounting_period_id,fiscal_year_id,business_date,source_type,
          description,status,journal_type,created_by_account_id
        ) values(${fixture.companyId}::uuid,'JRN-DRAFT-1',${fixture.periodId}::uuid,
          ${fixture.fiscalYearId}::uuid,'2026-01-20'::date,'manual','Unposted','draft','manual',
          ${fixture.preparerId}::uuid)`.execute(transaction);
      const checks = byKey(await readiness.run(workflow.id));
      expect(checks.get("unposted_journals_reviewed")?.status).toBe("failed");
    });
  });

  it("blocks on a confirmed Cash/Bank Movement with no posted Event", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, readiness } = buildServices(transaction, fixture);
      const workflow = await createWorkflow(closing, fixture, "monthly");
      const cashAccountId = randomUUID();
      await sql`insert into company_cash_accounts(
          id,company_id,cash_account_code,cash_account_name,cash_account_type,
          linked_gl_account_id,effective_from,created_by_account_id
        ) values(${cashAccountId}::uuid,${fixture.companyId}::uuid,'CASH-0001','Main','main_cash',
          ${fixture.cashGl}::uuid,'2026-01-01'::date,${fixture.preparerId}::uuid)`.execute(
        transaction,
      );
      await sql`insert into cash_bank_movements(
          company_id,movement_number,movement_type,movement_date,accounting_date,
          source_cash_account_id,amount,fee_amount,payment_method,correlation_id,
          idempotency_identity,status,created_by_account_id,confirmed_by_account_id,confirmed_at,
          classification_mapping_key
        ) values(${fixture.companyId}::uuid,'CBM-0001','cash_withdrawal','2026-01-10'::date,
          '2026-01-10'::date,${cashAccountId}::uuid,50,0,'cash',${randomUUID()}::uuid,
          ${randomUUID()},'confirmed',${fixture.preparerId}::uuid,${fixture.preparerId}::uuid,
          now(),'cash_bank_withdrawal_owner')`.execute(transaction);
      const checks = byKey(await readiness.run(workflow.id));
      expect(checks.get("cash_bank_reconciled")?.status).toBe("failed");
    });
  });

  it("blocks on Payroll periods that are not approved", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, readiness } = buildServices(transaction, fixture);
      const workflow = await createWorkflow(closing, fixture, "monthly");
      await sql`insert into payroll_periods(
          company_id,period_start,period_end,payroll_month,period_reference,status
        ) values(${fixture.companyId}::uuid,'2026-01-01'::date,'2026-01-31'::date,
          '2026-01-01'::date,'PAY-2026-01','calculated')`.execute(transaction);
      const checks = byKey(await readiness.run(workflow.id));
      expect(checks.get("payroll_reviewed")?.status).toBe("failed");
    });
  });

  it("blocks on General Expenses still draft or submitted", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, readiness } = buildServices(transaction, fixture);
      const workflow = await createWorkflow(closing, fixture, "monthly");
      await sql`insert into general_expenses(
          company_id,expense_number,expense_date,accounting_date,subtotal,vat_amount,
          recoverable_vat_amount,nonrecoverable_vat_amount,total_amount,approved_amount,
          paid_amount,outstanding_amount,status,created_by_account_id,updated_by_account_id
        ) values(${fixture.companyId}::uuid,'EXP-0001','2026-01-05'::date,'2026-01-05'::date,
          100,0,0,0,100,100,0,100,'draft',${fixture.preparerId}::uuid,
          ${fixture.preparerId}::uuid)`.execute(transaction);
      const checks = byKey(await readiness.run(workflow.id));
      expect(checks.get("expenses_reviewed")?.status).toBe("failed");
    });
  });

  it("cannot be reached by an unbalanced Trial Balance, because the ledger forbids one", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const skewed = randomUUID();
      await sql`insert into journal_entries(
          id,company_id,journal_number,accounting_period_id,fiscal_year_id,business_date,
          source_type,description,status,journal_type,created_by_account_id,
          total_debit,total_credit
        ) values(${skewed}::uuid,${fixture.companyId}::uuid,'JRN-SKEW-1',${fixture.periodId}::uuid,
          ${fixture.fiscalYearId}::uuid,'2026-01-18'::date,'manual','Skewed','draft','manual',
          ${fixture.preparerId}::uuid,25,0)`.execute(transaction);
      await sql`insert into journal_lines(
          company_id,journal_entry_id,line_number,account_id,debit,credit,account_code_snapshot
        ) values(${fixture.companyId}::uuid,${skewed}::uuid,1,${fixture.cashGl}::uuid,
          25,0,'1010')`.execute(transaction);
      // `validate_posted_journal_balance` refuses to post lines that do not
      // agree, so the readiness check's "does not balance" branch is
      // defensive: the database prevents the state it describes. Asserting the
      // guarantee is worth more than testing an unreachable branch.
      await sql.raw("savepoint skew_probe").execute(transaction);
      await expect(
        sql`update journal_entries set status='balanced'
           where id=${skewed}::uuid and company_id=${fixture.companyId}::uuid`.execute(transaction),
      ).rejects.toBeDefined();
      await sql.raw("rollback to savepoint skew_probe").execute(transaction);
      await sql.raw("release savepoint skew_probe").execute(transaction);
    });
  });

  it("blocks when the period has no posted activity at all", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, readiness } = buildServices(transaction, fixture);
      // A SECOND period with no activity. The baseline period's dates cannot be
      // moved -- the fiscal calendar is immutable -- so an empty month is
      // created rather than an existing one emptied.
      const emptyPeriodId = randomUUID();
      await sql`insert into accounting_periods(
          id,company_id,fiscal_year_id,period_code,name,period_number,period_start,period_end,status
        ) values(${emptyPeriodId}::uuid,${fixture.companyId}::uuid,${fixture.fiscalYearId}::uuid,
          'P02','February 2026',2,'2026-02-01'::date,'2026-02-28'::date,'open')`.execute(
        transaction,
      );
      const workflow = (await closing.create(
        {
          accountingPeriodId: emptyPeriodId,
          assignedToAccountId: fixture.preparerId,
          dueDate: "2026-03-15",
          fiscalYearId: fixture.fiscalYearId,
          priority: "normal",
          workflowType: "monthly",
        },
        `closing-${randomUUID()}`,
      )) as { id: string };
      const checks = byKey(await readiness.run(workflow.id));
      // Profit and Loss is period activity, and February has none.
      expect(checks.get("profit_and_loss_reviewed")?.status).toBe("failed");
      // The Trial Balance is NOT failed, and should not be: January's activity
      // carries into February as an opening balance, so a Trial Balance for a
      // month with no movement is still a real, balancing statement. Asserted
      // explicitly so a future change that started failing it is noticed.
      expect(checks.get("trial_balance_reviewed")?.status).toBe("passed");
    });
  });

  it("warns, but does not block, on outstanding Trader and Driver balances", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, readiness } = buildServices(transaction, fixture);
      const workflow = await createWorkflow(closing, fixture, "monthly");
      await seedOutstandingTrader(transaction, fixture);
      const result = await readiness.run(workflow.id);
      const checks = byKey(result);
      expect(checks.get("trader_driver_balances_reviewed")?.status).toBe("warning");
      // The decisive part: a warning leaves the workflow approvable.
      expect(result.summary.failed).toBe(0);
      expect(result.readyForApproval).toBe(true);
    });
  });
});

/** A delivered Order that still owes its Trader. */
async function seedOutstandingTrader(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
): Promise<void> {
  const traderAccountId = randomUUID();
  const traderId = randomUUID();
  const areaId = randomUUID();
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${traderAccountId}::uuid,${fixture.companyId}::uuid,'trader',
      ${`cr.t.${traderId}`},'x')`.execute(transaction);
  await sql`insert into traders(id,company_id,account_id,code,name_en,mobile_number,created_by_account_id)
    values(${traderId}::uuid,${fixture.companyId}::uuid,${traderAccountId}::uuid,'TRD-000001',
      'Readiness Trader','971501234567',${fixture.preparerId}::uuid)`.execute(transaction);
  const dubai = (
    await sql<{ id: string }>`select id from emirates where code='DXB'`.execute(transaction)
  ).rows[0]!.id;
  await sql`insert into areas(id,company_id,emirate_id,code,name_en)
    values(${areaId}::uuid,${fixture.companyId}::uuid,${dubai}::uuid,'AREA-000001','Deira')`.execute(
    transaction,
  );
  await sql`insert into orders(
      service_fee_override_reason,id,company_id,order_number,order_date,trader_id,area_id,
      created_by_account_id,customer_name,customer_mobile_number,customer_address,package_count,
      payment_condition,final_service_fee_snapshot,customer_provenance_status,
      pricing_provenance_status,trader_gross_payable,trader_net_payable,
      delivery_status,driver_reconciliation_status,trader_settlement_status,return_status
    ) values(
      'Zero configured Service Fee (fixture)',${randomUUID()}::uuid,${fixture.companyId}::uuid,
      'ORD-READY-1','2026-01-08'::date,${traderId}::uuid,${areaId}::uuid,
      ${fixture.preparerId}::uuid,'Readiness Customer','971509999999','Address',1,
      'customer_pays_cod_and_fee',0,'legacy_unattributed','legacy_unattributed',100,100,
      'delivered','reconciled','unsettled','not_applicable')`.execute(transaction);
}

describe.skipIf(!runDatabaseTests)("Closing readiness — Year-End", () => {
  it("blocks while accounting periods in the year are not closed", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, readiness } = buildServices(transaction, fixture);
      const workflow = await createWorkflow(closing, fixture, "year_end");
      const checks = byKey(await readiness.run(workflow.id));
      expect(checks.get("all_monthly_periods_closed")?.status).toBe("failed");
    });
  });

  it("passes the final statements on a closed, balanced year", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, readiness } = buildServices(transaction, fixture);
      const workflow = await createWorkflow(closing, fixture, "year_end");
      await sql`update accounting_periods set status='closed',
             closed_by_account_id=${fixture.preparerId}::uuid, closed_at=now()
         where id=${fixture.periodId}::uuid and company_id=${fixture.companyId}::uuid`.execute(
        transaction,
      );
      const checks = byKey(await readiness.run(workflow.id));
      expect(checks.get("all_monthly_periods_closed")?.status).toBe("passed");
      expect(checks.get("final_trial_balance")?.status).toBe("passed");
      expect(checks.get("final_profit_and_loss")?.status).toBe("passed");
      expect(checks.get("final_balance_sheet")?.status).toBe("passed");
      // No Closing Journal yet is the healthy state, not a warning.
      expect(checks.get("closing_journal_prepared")?.status).toBe("passed");
    });
  });

  it("warns when a Closing Journal already exists", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, readiness } = buildServices(transaction, fixture);
      const workflow = await createWorkflow(closing, fixture, "year_end");
      await postedJournal(transaction, {
        accountingPeriodId: fixture.periodId,
        actorId: fixture.preparerId,
        companyId: fixture.companyId,
        creditAccountId: fixture.revenueGl,
        creditAmount: "10",
        debitAccountId: fixture.cashGl,
        debitAmount: "10",
        fiscalYearId: fixture.fiscalYearId,
        id: randomUUID(),
        journalNumber: "JRN-CLOSE-1",
        journalType: "closing",
      });
      const result = await readiness.run(workflow.id);
      const checks = byKey(result);
      // A year closed twice is the mistake this watches for -- but it warns
      // rather than blocks, so it never becomes unresolvable.
      expect(checks.get("closing_journal_prepared")?.status).toBe("warning");
      expect(result.summary.warning).toBeGreaterThan(0);
    });
  });

  it("warns on a missing next fiscal year and missing next periods", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, readiness } = buildServices(transaction, fixture);
      const workflow = await createWorkflow(closing, fixture, "year_end");
      const checks = byKey(await readiness.run(workflow.id));
      expect(checks.get("next_fiscal_year_created")?.status).toBe("warning");
      expect(checks.get("next_periods_created")?.status).toBe("warning");
      expect(checks.get("first_new_period_opened")?.status).toBe("warning");
    });
  });

  it("records execution-only tasks as not applicable", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, readiness } = buildServices(transaction, fixture);
      const workflow = await createWorkflow(closing, fixture, "year_end");
      const checks = byKey(await readiness.run(workflow.id));
      for (const key of [
        "profit_loss_transferred",
        "balances_carried_forward",
        "prior_year_locked",
      ]) {
        expect(checks.get(key)?.status, key).toBe("not_applicable");
      }
    });
  });

  it("creates no fiscal year, period, Journal or Event of its own", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, readiness } = buildServices(transaction, fixture);
      const workflow = await createWorkflow(closing, fixture, "year_end");
      const census = async () => {
        const row = (
          await sql<{ e: string; j: string; p: string; y: string }>`
            select
              (select count(*)::text from fiscal_years where company_id=${fixture.companyId}::uuid) as y,
              (select count(*)::text from accounting_periods where company_id=${fixture.companyId}::uuid) as p,
              (select count(*)::text from journal_entries where company_id=${fixture.companyId}::uuid) as j,
              (select count(*)::text from accounting_events where company_id=${fixture.companyId}::uuid) as e
          `.execute(transaction)
        ).rows[0]!;
        return row;
      };
      const before = await census();
      await readiness.run(workflow.id);
      await readiness.run(workflow.id);
      expect(await census()).toEqual(before);
    });
  });
});

describe.skipIf(!runDatabaseTests)("Closing readiness — persistence and rerun", () => {
  it("stores one result per task and replaces it on rerun without duplicating tasks", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, readiness } = buildServices(transaction, fixture);
      const workflow = await createWorkflow(closing, fixture, "monthly");

      // Manual state that a rerun must not disturb.
      const detail = (await closing.detail(workflow.id)) as unknown as {
        tasks: readonly { id: string }[];
      };
      const taskId = detail.tasks[0]!.id;
      await closing.updateTask(workflow.id, taskId, { notes: "Manual note", status: "completed" });
      await closing.assignTask(workflow.id, taskId, {
        assignedToAccountId: fixture.approverId,
      });
      await closing.addComment(workflow.id, { body: "A comment" });
      await closing.addAttachment(workflow.id, {
        fileName: "evidence.pdf",
        storageKey: "external/evidence.pdf",
      });

      await readiness.run(workflow.id);
      const firstPass = (
        await sql<{ count: string }>`
          select count(*)::text as count from closing_workflow_tasks
           where company_id=${fixture.companyId}::uuid and closing_workflow_id=${workflow.id}::uuid
             and check_result is not null
        `.execute(transaction)
      ).rows[0]!.count;

      // Introduce a failure and rerun: the stored result must CHANGE, not
      // accumulate.
      await insertEvent(transaction, fixture, "failed");
      await readiness.run(workflow.id);

      const after = (
        await sql<{
          assigned: string | null;
          notes: string | null;
          status: string;
          taskCount: string;
          taskStatus: string;
          withResult: string;
        }>`
          select
            (select count(*)::text from closing_workflow_tasks
              where company_id=${fixture.companyId}::uuid
                and closing_workflow_id=${workflow.id}::uuid) as "taskCount",
            (select count(*)::text from closing_workflow_tasks
              where company_id=${fixture.companyId}::uuid
                and closing_workflow_id=${workflow.id}::uuid and check_result is not null)
              as "withResult",
            (select notes from closing_workflow_tasks where id=${taskId}::uuid) as notes,
            (select status from closing_workflow_tasks where id=${taskId}::uuid) as "taskStatus",
            (select assigned_to_account_id::text from closing_workflow_tasks
              where id=${taskId}::uuid) as assigned,
            (select check_result->>'status' from closing_workflow_tasks
              where company_id=${fixture.companyId}::uuid
                and closing_workflow_id=${workflow.id}::uuid
                and task_key='failed_accounting_events_resolved') as status
        `.execute(transaction)
      ).rows[0]!;

      // Eleven template tasks, unchanged in number, one result each.
      expect(after.taskCount).toBe("11");
      expect(after.withResult).toBe(firstPass);
      expect(after.status).toBe("failed");
      // Manual state survived untouched.
      expect(after.notes).toBe("Manual note");
      expect(after.taskStatus).toBe("completed");
      expect(after.assigned).toBe(fixture.approverId);

      const survivors = (
        await sql<{ attachments: string; comments: string }>`
          select
            (select count(*)::text from closing_task_comments
              where company_id=${fixture.companyId}::uuid
                and closing_workflow_id=${workflow.id}::uuid) as comments,
            (select count(*)::text from closing_task_attachments
              where company_id=${fixture.companyId}::uuid
                and closing_workflow_id=${workflow.id}::uuid) as attachments
        `.execute(transaction)
      ).rows[0]!;
      expect(survivors).toEqual({ attachments: "1", comments: "1" });
    });
  });

  it("preserves each prior result set in the audit trail", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, readiness } = buildServices(transaction, fixture);
      const workflow = await createWorkflow(closing, fixture, "monthly");
      await readiness.run(workflow.id);
      await insertEvent(transaction, fixture, "failed");
      await readiness.run(workflow.id);

      const audits = await sql<{ after: { checks: readonly { status: string; taskKey: string }[] } }>`
        select after_data as after from audit_events
         where company_id=${fixture.companyId}::uuid
           and action='accounting.closing_workflow.readiness_checked'
         order by occurred_at, id
      `.execute(transaction);
      // Two runs, two full snapshots -- the schema has no per-task history
      // table, so this is where a previous answer survives.
      expect(audits.rows).toHaveLength(2);
      // Order-independent on purpose: `now()` is the TRANSACTION timestamp, so
      // both rows share an `occurred_at` and any ordering between them is
      // arbitrary. What matters is that both answers are present -- the earlier
      // 'passed' was not overwritten by the later 'failed'.
      const recorded = audits.rows
        .map(
          (row) =>
            row.after.checks.find(
              (check) => check.taskKey === "failed_accounting_events_resolved",
            )?.status,
        )
        .sort();
      expect(recorded).toEqual(["failed", "passed"]);
    });
  });
});

describe.skipIf(!runDatabaseTests)("Closing readiness — transition gate", () => {
  /** draft → in_progress → ready_for_review → under_review, preparer then approver. */
  async function advanceToUnderReview(
    closing: AccountingClosingService,
    identity: MutableIdentity,
    fixture: Fixture,
    workflowId: string,
  ): Promise<number> {
    let version = 1;
    const move = async (toStatus: string) => {
      const result = (await closing.transition(
        workflowId,
        { toStatus: toStatus as never, version },
        `t-${randomUUID()}`,
      )) as { version: number };
      version = result.version;
    };
    await move("in_progress");
    await move("ready_for_review");
    // The reviewer must not be the submitter.
    identity.actorId = fixture.approverId;
    await move("under_review");
    return version;
  }

  it("blocks Ready for Approval when a mandatory check failed", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, identity, readiness } = buildServices(transaction, fixture);
      const workflow = await createWorkflow(closing, fixture, "monthly");
      await insertEvent(transaction, fixture, "failed");
      await readiness.run(workflow.id);
      const version = await advanceToUnderReview(closing, identity, fixture, workflow.id);
      await expect(
        closing.transition(
          workflow.id,
          { toStatus: "ready_for_approval", version },
          `t-${randomUUID()}`,
        ),
      ).rejects.toMatchObject({ errorCode: "accounting_closing_readiness_not_passed" });
    });
  });

  it("blocks Ready for Approval when readiness was never run", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, identity } = buildServices(transaction, fixture);
      const workflow = await createWorkflow(closing, fixture, "monthly");
      const version = await advanceToUnderReview(closing, identity, fixture, workflow.id);
      // Never evaluated is not a pass: otherwise approval is reachable by
      // simply never running the checks.
      await expect(
        closing.transition(
          workflow.id,
          { toStatus: "ready_for_approval", version },
          `t-${randomUUID()}`,
        ),
      ).rejects.toMatchObject({ errorCode: "accounting_closing_readiness_not_passed" });
    });
  });

  it("allows Ready for Approval and Approve when checks pass, warnings included", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, identity, readiness } = buildServices(transaction, fixture);
      const workflow = await createWorkflow(closing, fixture, "monthly");
      // A warning is present and must not block.
      await seedOutstandingTrader(transaction, fixture);
      const result = await readiness.run(workflow.id);
      expect(result.summary.warning).toBeGreaterThan(0);

      let version = await advanceToUnderReview(closing, identity, fixture, workflow.id);
      const ready = (await closing.transition(
        workflow.id,
        { toStatus: "ready_for_approval", version },
        `t-${randomUUID()}`,
      )) as { status: string; version: number };
      expect(ready.status).toBe("ready_for_approval");
      version = ready.version;

      const approved = (await closing.transition(
        workflow.id,
        { toStatus: "approved", version },
        `t-${randomUUID()}`,
      )) as { status: string };
      expect(approved.status).toBe("approved");
    });
  });

  it("applies the same gate to Approve after readiness regresses", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { closing, identity, readiness } = buildServices(transaction, fixture);
      const workflow = await createWorkflow(closing, fixture, "monthly");
      await readiness.run(workflow.id);
      let version = await advanceToUnderReview(closing, identity, fixture, workflow.id);
      const ready = (await closing.transition(
        workflow.id,
        { toStatus: "ready_for_approval", version },
        `t-${randomUUID()}`,
      )) as { version: number };
      version = ready.version;

      // Something breaks after review; a re-check records it. Approve must now
      // refuse, using the same gate.
      await insertEvent(transaction, fixture, "failed");
      await readiness.run(workflow.id);
      await expect(
        closing.transition(workflow.id, { toStatus: "approved", version }, `t-${randomUUID()}`),
      ).rejects.toMatchObject({ errorCode: "accounting_closing_readiness_not_passed" });
    });
  });
});

describe.skipIf(!runDatabaseTests)("Closing readiness — Company isolation", () => {
  it("refuses to run or read another Company's workflow", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const owner = await seed(transaction);
      const intruder = await seed(transaction);
      const ownerServices = buildServices(transaction, owner);
      const workflow = await createWorkflow(ownerServices.closing, owner, "monthly");

      const intruderServices = buildServices(transaction, intruder);
      // Identical to a workflow that does not exist: distinguishing them would
      // let a caller enumerate another tenant's ids.
      await expect(intruderServices.readiness.run(workflow.id)).rejects.toMatchObject({
        errorCode: "accounting_closing_workflow_not_found",
      });
      await expect(intruderServices.readiness.latest(workflow.id)).rejects.toMatchObject({
        errorCode: "accounting_closing_workflow_not_found",
      });
    });
  });

  it("does not let one Company's source records satisfy another's checks", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const owner = await seed(transaction);
      const other = await seed(transaction);
      const ownerServices = buildServices(transaction, owner);
      const workflow = await createWorkflow(ownerServices.closing, owner, "monthly");

      // A failure in the OTHER Company must not appear here...
      await insertEvent(transaction, other, "failed");
      let checks = byKey(await ownerServices.readiness.run(workflow.id));
      expect(checks.get("failed_accounting_events_resolved")?.status).toBe("passed");

      // ...and this Company's own failure must.
      await insertEvent(transaction, owner, "failed");
      checks = byKey(await ownerServices.readiness.run(workflow.id));
      expect(checks.get("failed_accounting_events_resolved")?.status).toBe("failed");
    });
  });
});
