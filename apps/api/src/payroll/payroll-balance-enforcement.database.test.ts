import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";

import { AccountingOperationSupport } from "../accounting/accounting-operation.support.js";
import { BalanceControlService } from "../accounting/balance-control.service.js";
import { BalanceEnforcementCoordinator } from "../accounting/balance-enforcement.coordinator.js";
import { CashBankQueryService } from "../accounting/cash-bank-query.service.js";
import { FundingAccountBalanceService } from "../accounting/funding-account-balance.service.js";
import { FundingAccountLockService } from "../accounting/funding-account-lock.service.js";
import { GeneralExpenseQueryService } from "../accounting/general-expense-query.service.js";
import { PaymentFundingAccountService } from "../accounting/payment-funding-account.service.js";
import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type {
  KyselyTransactionManager,
  TransactionWork,
} from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import type { IdentityContextAccessor } from "../security/identity-context.js";
import type { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { PayrollOperationSupport } from "./payroll-operation.support.js";
import { PayrollOperationalRepository } from "./payroll-operational.repository.js";
import { PayrollPaymentService } from "./payroll-payment.service.js";

/**
 * Payroll Payment confirmation with balance control wired in.
 *
 * The point is not that the coordinator returns the right verdict -- that is
 * covered directly in balance-enforcement.coordinator.test.ts. It is that the
 * SERVICE honours the verdict: a refusal leaves no payment and no allocation
 * behind, an accepted override is audited exactly once and only after the
 * payment exists, and reversal and replay never reach the coordinator at all.
 *
 * The real coordinator runs against a real database rather than a stub, because
 * the claim under test IS the wiring; a stub would prove the test author's
 * belief about the wiring instead of the wiring itself.
 */

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

/** Maps each service transaction onto a savepoint of one outer, rolled-back one. */
class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `payroll_be_${++this.sequence}`;
    await sql.raw(`savepoint ${savepoint}`).execute(this.transaction);
    try {
      const result = await work(this.transaction);
      await sql.raw(`release savepoint ${savepoint}`).execute(this.transaction);
      return result;
    } catch (error) {
      // A rejected confirmation unwinds to here -- exactly the production
      // guarantee under test: nothing it wrote survives.
      await sql.raw(`rollback to savepoint ${savepoint}`).execute(this.transaction);
      await sql.raw(`release savepoint ${savepoint}`).execute(this.transaction);
      throw error;
    }
  }
}

interface Fixture {
  readonly actorId: string;
  readonly cashAccountId: string;
  readonly companyId: string;
  readonly employeeId: string;
  readonly lineId: string;
  readonly periodId: string;
}

/**
 * An approved Payroll period with one Employee owed 1,000, funded from a Cash
 * account whose opening balance the caller chooses.
 *
 * The opening balance is a posted `opening_balance` Journal against the Cash
 * account's GL -- the same source the authoritative balance reads -- rather
 * than a number injected somewhere convenient.
 */
async function seed(
  transaction: Transaction<DatabaseSchema>,
  options: { readonly cashPolicy: string; readonly openingBalance: string },
): Promise<Fixture> {
  const companyId = randomUUID();
  const actorId = randomUUID();
  const employeeId = randomUUID();
  const periodId = randomUUID();
  const lineId = randomUUID();
  const cashGl = randomUUID();
  const equityGl = randomUUID();
  const cashAccountId = randomUUID();
  const short = companyId.slice(0, 8);

  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${companyId}::uuid,${`PB-${short}`},${`pb-${short}`},'Payroll Balance Test','active',now())`.execute(
    transaction,
  );
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${actorId}::uuid,${companyId}::uuid,'company_user',${`pb.a.${actorId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into chart_of_accounts(
      id,company_id,code,name_en,account_type,account_class,normal_balance,is_posting_account,is_active
    ) values
      (${cashGl}::uuid,${companyId}::uuid,'1010','Cash on hand','asset','cash','debit',true,true),
      (${equityGl}::uuid,${companyId}::uuid,'3010','Owner equity','equity','owner_equity','credit',true,true)`.execute(
    transaction,
  );
  await sql`insert into company_cash_accounts(
      id,company_id,cash_account_code,cash_account_name,cash_account_type,
      linked_gl_account_id,effective_from,created_by_account_id
    ) values(${cashAccountId}::uuid,${companyId}::uuid,'CASH-0001','Main Cash','main_cash',
      ${cashGl}::uuid,current_date,${actorId}::uuid)`.execute(transaction);
  await sql`insert into company_balance_policies(
      company_id,cash_policy,bank_policy,bank_overdraft_limit,effective_from,
      change_reason,created_by_account_id
    ) values(${companyId}::uuid,${options.cashPolicy},'allow_within_overdraft',0,'-infinity'::date,
      'Fixture policy',${actorId}::uuid)`.execute(transaction);

  if (options.openingBalance !== "0") {
    const fiscalYearId = randomUUID();
    const accountingPeriodId = randomUUID();
    const journalId = randomUUID();
    await sql`insert into fiscal_years(
        id,company_id,fiscal_year_code,name,start_date,end_date,status,created_by_account_id
      ) values(${fiscalYearId}::uuid,${companyId}::uuid,'FY-2026','FY',
        date_trunc('year',current_date)::date,
        (date_trunc('year',current_date)+interval '1 year -1 day')::date,'open',${actorId}::uuid)`.execute(
      transaction,
    );
    await sql`insert into accounting_periods(
        id,company_id,fiscal_year_id,period_code,name,period_number,period_start,period_end,status
      ) values(${accountingPeriodId}::uuid,${companyId}::uuid,${fiscalYearId}::uuid,'P01','Period 1',1,
        date_trunc('month',current_date)::date,
        (date_trunc('month',current_date)+interval '1 month -1 day')::date,'open')`.execute(transaction);
    // Draft first, then lines, then posted. A posted Journal is immutable --
    // `accounting_journal_not_editable` rejects a line added to one -- so the
    // fixture follows the same order a real posting does.
    await sql`insert into journal_entries(
        id,company_id,journal_number,accounting_period_id,fiscal_year_id,business_date,source_type,
        description,status,journal_type,created_by_account_id,total_debit,total_credit
      ) values(${journalId}::uuid,${companyId}::uuid,'JRN-OPEN-1',${accountingPeriodId}::uuid,
        ${fiscalYearId}::uuid,current_date,
        'opening_balance','Opening balance','draft','opening_balance',${actorId}::uuid,
        ${options.openingBalance}::numeric,${options.openingBalance}::numeric)`.execute(
      transaction,
    );
    // Balanced: the Cash debit against an equity credit, so the Journal is a
    // real one rather than a half-entry the totals check would reject.
    await sql`insert into journal_lines(
        company_id,journal_entry_id,line_number,account_id,debit,credit,account_code_snapshot
      ) values
        (${companyId}::uuid,${journalId}::uuid,1,${cashGl}::uuid,
          ${options.openingBalance}::numeric,0,'1010'),
        (${companyId}::uuid,${journalId}::uuid,2,${equityGl}::uuid,
          0,${options.openingBalance}::numeric,'3010')`.execute(transaction);
    // One step at a time: the lifecycle trigger permits only
    // draft -> balanced -> approved -> posted.
    await sql`update journal_entries set status='balanced'
       where id=${journalId}::uuid and company_id=${companyId}::uuid`.execute(transaction);
    await sql`update journal_entries
         set status='approved',approved_by_account_id=${actorId}::uuid,approved_at=now()
       where id=${journalId}::uuid and company_id=${companyId}::uuid`.execute(transaction);
    await sql`update journal_entries
         set status='posted',posted_by_account_id=${actorId}::uuid,posted_at=now()
       where id=${journalId}::uuid and company_id=${companyId}::uuid`.execute(transaction);
  }

  await sql`insert into employees(id,company_id,name_en,employee_number,basic_salary)
    values(${employeeId}::uuid,${companyId}::uuid,'Test Employee','EMP-0001',1000)`.execute(
    transaction,
  );
  // Totals must already AGREE with the line below. An approved period only
  // permits status/total_paid/total_outstanding to move, and the service
  // recalculates every total on payment: if the fixture's other totals were
  // wrong, recalculation would try to correct them and the immutability
  // trigger would refuse -- a fixture artefact that would look like a defect.
  await sql`insert into payroll_periods(
      id,company_id,period_start,period_end,payroll_month,period_reference,status,
      total_employees,total_basic_salary,total_allowances,
      total_employee_driver_commission,total_delivered_order_earnings,
      total_earning_adjustments,total_deductions,
      total_net_salary,total_paid,total_outstanding
    ) values(${periodId}::uuid,${companyId}::uuid,
      date_trunc('month',current_date)::date,
      (date_trunc('month',current_date)+interval '1 month -1 day')::date,
      date_trunc('month',current_date)::date,'PAY-FIXTURE','calculated',
      1,1000,0,0,0,0,0,1000,0,1000)`.execute(transaction);
  await sql`insert into payroll_entries(
      id,company_id,payroll_number,payroll_period_id,employee_id,created_by_account_id,
      employee_number_snapshot,employee_name_snapshot,
      basic_salary_snapshot,allowance_total,employee_driver_commission,earning_adjustments_total,
      deduction_adjustments_total,advances,gross_earnings,net_salary,amount_paid,outstanding_amount,
      status
    ) values(${lineId}::uuid,${companyId}::uuid,'PR-0001',${periodId}::uuid,${employeeId}::uuid,
      ${actorId}::uuid,'EMP-0001','Test Employee',
      1000,0,0,0,0,0,1000,1000,0,1000,'approved')`.execute(transaction);
  // Approved only AFTER the line exists: a trigger refuses lines added to an
  // already-approved period, which is the same order the real workflow uses.
  await sql`update payroll_periods set status='approved'
     where id=${periodId}::uuid and company_id=${companyId}::uuid`.execute(transaction);

  return { actorId, cashAccountId, companyId, employeeId, lineId, periodId };
}

/** The real service graph, on the outer transaction, with a call counter. */
function buildService(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  permissions: readonly string[],
) {
  const tenants = {
    current: () => ({ companyId: fixture.companyId, identityId: fixture.actorId }),
  } as unknown as TenantContextAccessor;
  const identities = {
    current: () => ({
      companyId: fixture.companyId,
      forcePasswordChange: false,
      identityId: fixture.actorId,
      kind: "company_user",
      permissions: new Set(permissions),
      sessionId: randomUUID(),
    }),
  } as unknown as IdentityContextAccessor;
  const database = transaction as unknown as Kysely<DatabaseSchema>;
  const manager = new SavepointTransactionManager(
    transaction,
  ) as unknown as KyselyTransactionManager;
  const history = new OperationsHistoryWriter();
  const accountingSupport = new AccountingOperationSupport(tenants, identities, history);
  const coordinator = new BalanceEnforcementCoordinator(
    new FundingAccountLockService(tenants),
    new FundingAccountBalanceService(
      new CashBankQueryService(
        database,
        accountingSupport,
        new GeneralExpenseQueryService(database, accountingSupport),
      ),
      tenants,
    ),
    new BalanceControlService(database, manager, tenants, identities),
    tenants,
  );

  // Counting calls is the only way to prove a NEGATIVE -- that reversal and
  // replay never consult the coordinator. An outcome assertion cannot: an
  // unblocked reversal looks identical whether it asked and was allowed or
  // never asked at all.
  const counters = { evaluate: 0, recordOverrides: 0 };
  const realEvaluate = coordinator.evaluate.bind(coordinator);
  const realRecord = coordinator.recordOverrides.bind(coordinator);
  Object.assign(coordinator, {
    evaluate: (...args: Parameters<typeof realEvaluate>) => {
      counters.evaluate += 1;
      return realEvaluate(...args);
    },
    recordOverrides: (...args: Parameters<typeof realRecord>) => {
      counters.recordOverrides += 1;
      return realRecord(...args);
    },
  });

  const service = new PayrollPaymentService(
    database,
    manager,
    new PayrollOperationSupport(tenants, identities),
    new PayrollOperationalRepository(),
    history,
    new PaymentFundingAccountService(database, tenants),
    coordinator,
  );
  return { counters, service };
}

const confirmInput = (fixture: Fixture, amount: string, overrideReason?: string) => ({
  accountId: fixture.cashAccountId,
  acknowledgementType: "checkbox" as const,
  allocations: [{ amount: Number(amount), employeeId: fixture.employeeId, lineId: fixture.lineId }],
  cashVoucherReference: "VOUCHER-1",
  paymentDate: new Date().toISOString().slice(0, 10),
  periodId: fixture.periodId,
  ...(overrideReason === undefined ? {} : { balanceOverrideReason: overrideReason }),
});

const counts = async (transaction: Transaction<DatabaseSchema>, companyId: string) => {
  const row = (
    await sql<{ allocations: string; audits: string; payments: string; paid: string }>`
      select
        (select count(*)::text from payroll_payments where company_id=${companyId}::uuid) as payments,
        (select count(*)::text from payroll_payment_allocations where company_id=${companyId}::uuid)
          as allocations,
        (select count(*)::text from balance_override_audits where company_id=${companyId}::uuid)
          as audits,
        (select coalesce(sum(amount_paid),0)::text from payroll_entries
          where company_id=${companyId}::uuid) as paid
    `.execute(transaction)
  ).rows[0]!;
  return {
    allocations: Number(row.allocations),
    audits: Number(row.audits),
    paid: row.paid,
    payments: Number(row.payments),
  };
};

async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
): Promise<void> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const marker = new Error("rollback payroll balance test");
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

const payPermissions = ["payroll.pay", "accounting.view"];
const overridePermissions = [...payPermissions, "accounting.manage"];

describe.skipIf(!runDatabaseTests)("Payroll payment balance enforcement", () => {
  it("confirms a Cash payment the balance covers", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, { cashPolicy: "block", openingBalance: "5000" });
      const { counters, service } = buildService(transaction, fixture, payPermissions);
      const result = await service.confirm(
        confirmInput(fixture, "1000"),
        `payroll-allowed-${randomUUID()}`,
        randomUUID(),
      );
      expect(result.status).toBe("confirmed");
      expect(result.totalAmount).toBe("1000.00");
      expect(counters.evaluate).toBe(1);
      expect(counters.recordOverrides).toBe(0);
      const after = await counts(transaction, fixture.companyId);
      expect(after).toMatchObject({ allocations: 1, audits: 0, paid: "1000.00", payments: 1 });
      // Coverage is reported alongside the result, never used to block.
      expect(result.balanceCoverageIncomplete).toBe(false);
    });
  });

  it("refuses a payment that would take Cash negative, leaving nothing behind", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, { cashPolicy: "block", openingBalance: "100" });
      const { counters, service } = buildService(transaction, fixture, payPermissions);
      await expect(
        service.confirm(confirmInput(fixture, "1000"), `payroll-blocked-${randomUUID()}`, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "balance_would_go_negative" });
      expect(counters.evaluate).toBe(1);
      expect(counters.recordOverrides).toBe(0);
      // The whole confirmation unwound: no payment, no allocation, no audit,
      // and the Employee is still owed the full amount.
      const after = await counts(transaction, fixture.companyId);
      expect(after).toEqual({ allocations: 0, audits: 0, paid: "0.00", payments: 0 });
    });
  });

  it("reports the balance figures on the refusal without leaking identifiers", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, { cashPolicy: "block", openingBalance: "100" });
      const { service } = buildService(transaction, fixture, payPermissions);
      const error = await service
        .confirm(confirmInput(fixture, "1000"), `payroll-detail-${randomUUID()}`, randomUUID())
        .then(() => undefined)
        .catch((cause: unknown) => cause as { validationDetails?: readonly string[] });
      // Shared coordinator formatting: one kind-labelled group per account.
      const details = error?.validationDetails ?? [];
      expect(details).toContain("Cash account — current balance: 100.00");
      expect(details).toContain("Cash account — payment amount: 1000.00");
      expect(details).toContain("Cash account — projected balance: -900.00");
      expect(details).toContain("Cash account — applied policy: block");
      expect(details).toContain("Cash account — overdraft limit: 0.00");
      expect(details.some((line) => line.includes(fixture.cashAccountId))).toBe(false);
    });
  });

  it("accepts an authorised override and writes exactly one audit for the payment", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, {
        cashPolicy: "allow_with_override",
        openingBalance: "100",
      });
      const { counters, service } = buildService(transaction, fixture, overridePermissions);
      const result = await service.confirm(
        confirmInput(fixture, "1000", "Authorised by the Finance Director"),
        `payroll-override-${randomUUID()}`,
        randomUUID(),
      );
      expect(counters.recordOverrides).toBe(1);
      const after = await counts(transaction, fixture.companyId);
      expect(after).toMatchObject({ audits: 1, payments: 1 });
      // The audit points at the payment it justifies, which only exists
      // because the audit was written after the insert.
      const audit = await sql<{
        accountKind: string;
        cash: string;
        entity: string;
        reference: string;
      }>`
        select account_kind as "accountKind", company_cash_account_id as cash,
               source_entity_id as entity, source_reference as reference
          from balance_override_audits where company_id=${fixture.companyId}::uuid
      `.execute(transaction);
      expect(audit.rows[0]?.entity).toBe(result.paymentId);
      expect(audit.rows[0]?.reference).toBe(result.paymentNumber);
      expect(audit.rows[0]?.cash).toBe(fixture.cashAccountId);
      expect(audit.rows[0]?.accountKind).toBe("cash");
    });
  });

  it("refuses an override with no reason, and writes no audit", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, {
        cashPolicy: "allow_with_override",
        openingBalance: "100",
      });
      const { counters, service } = buildService(transaction, fixture, overridePermissions);
      await expect(
        service.confirm(confirmInput(fixture, "1000"), `payroll-noreason-${randomUUID()}`, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "balance_override_reason_required" });
      expect(counters.recordOverrides).toBe(0);
      expect(await counts(transaction, fixture.companyId)).toEqual({
        allocations: 0,
        audits: 0,
        paid: "0.00",
        payments: 0,
      });
    });
  });

  it("refuses an override from an actor without the permission", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, {
        cashPolicy: "allow_with_override",
        openingBalance: "100",
      });
      const { service } = buildService(transaction, fixture, payPermissions);
      await expect(
        service.confirm(
          confirmInput(fixture, "1000", "Authorised by me"),
          `payroll-noperm-${randomUUID()}`,
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "balance_override_not_permitted" });
      expect(await counts(transaction, fixture.companyId)).toMatchObject({ audits: 0, payments: 0 });
    });
  });

  it("never consults the coordinator on reversal", async () => {
    await inRolledBackTransaction(async (transaction) => {
      // Opening exactly covers the payment, so the account sits at zero
      // afterwards and a 'block' policy would refuse any further outflow.
      const fixture = await seed(transaction, { cashPolicy: "block", openingBalance: "1000" });
      const { counters, service } = buildService(transaction, fixture, [
        ...payPermissions,
        "payroll.reverse",
      ]);
      const payment = await service.confirm(
        confirmInput(fixture, "1000"),
        `payroll-reverse-${randomUUID()}`,
        randomUUID(),
      );
      const afterConfirm = counters.evaluate;
      const reversed = await service.reverse(
        payment.paymentId,
        "Paid in error",
        `payroll-reverse-key-${randomUUID()}`,
        randomUUID(),
      );
      expect(reversed.status).toBe("reversed");

      // The decisive assertion: the counter did not move. An outcome check
      // could not tell "asked and allowed" from "never asked" -- reversal is
      // inbound, so even a wired-in coordinator would have permitted it.
      expect(counters.evaluate).toBe(afterConfirm);
      expect(counters.recordOverrides).toBe(0);

      // Reversal restores the funds and justifies nothing, so it writes no
      // override audit and leaves the Employee owed again.
      expect(await counts(transaction, fixture.companyId)).toMatchObject({
        audits: 0,
        paid: "0.00",
      });
      const state = await sql<{
        allocationsOpen: string;
        allocationsReversed: string;
        paymentStatus: string;
      }>`
        select
          (select status from payroll_payments
            where id=${payment.paymentId}::uuid and company_id=${fixture.companyId}::uuid)
            as "paymentStatus",
          (select count(*)::text from payroll_payment_allocations
            where company_id=${fixture.companyId}::uuid and reversed_at is not null)
            as "allocationsReversed",
          (select count(*)::text from payroll_payment_allocations
            where company_id=${fixture.companyId}::uuid and reversed_at is null)
            as "allocationsOpen"
      `.execute(transaction);
      expect(state.rows[0]?.paymentStatus).toBe("reversed");
      expect(state.rows[0]?.allocationsReversed).toBe("1");
      expect(state.rows[0]?.allocationsOpen).toBe("0");
    });
  });

  it("replays an identical request without re-evaluating or re-auditing", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, {
        cashPolicy: "allow_with_override",
        openingBalance: "100",
      });
      const { counters, service } = buildService(transaction, fixture, overridePermissions);
      const key = `payroll-replay-${randomUUID()}`;
      const input = confirmInput(fixture, "1000", "Authorised by the Finance Director");
      const first = await service.confirm(input, key, randomUUID());
      const second = await service.confirm(input, key, randomUUID());
      expect(second.paymentId).toBe(first.paymentId);
      // The replay returned before the coordinator was reached at all.
      expect(counters.evaluate).toBe(1);
      expect(counters.recordOverrides).toBe(1);
      expect(await counts(transaction, fixture.companyId)).toMatchObject({ audits: 1, payments: 1 });
    });
  });

  it("rejects the same key re-sent with a different override reason", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, {
        cashPolicy: "allow_with_override",
        openingBalance: "100",
      });
      const { service } = buildService(transaction, fixture, overridePermissions);
      const key = `payroll-fingerprint-${randomUUID()}`;
      await service.confirm(confirmInput(fixture, "1000", "First reason"), key, randomUUID());
      // A different reason is a different request -- it asks for the payment to
      // be authorised on different grounds -- so it must not replay the first.
      await expect(
        service.confirm(confirmInput(fixture, "1000", "Second reason"), key, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "idempotency_key_reused" });
      expect(await counts(transaction, fixture.companyId)).toMatchObject({ audits: 1, payments: 1 });
    });
  });
});
