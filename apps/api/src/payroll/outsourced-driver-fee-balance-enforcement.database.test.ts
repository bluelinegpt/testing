import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Decimal } from "decimal.js";
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
import { OutsourcedDriverFeeService } from "./outsourced-driver-fee.service.js";
import { PayrollOperationSupport } from "./payroll-operation.support.js";

/**
 * Outsourced Driver Fee payment confirmation with balance control wired in.
 *
 * The verdict logic is covered directly in
 * balance-enforcement.coordinator.test.ts. What is asserted here is that the
 * SERVICE honours it: that a refusal leaves no payment and no allocation, that
 * an accepted override is audited exactly once and only after the payment
 * exists, and -- the case unique to this workflow -- that a collection offset
 * never reaches the coordinator at all.
 *
 * The real coordinator, lock service, balance service and control service run
 * against a real database. The permissive stub in ../test/ is deliberately NOT
 * used: the claim under test IS the wiring, and a stub would prove the test
 * author's belief about it instead.
 */

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

/** Maps each service transaction onto a savepoint of one outer, rolled-back one. */
class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `fee_be_${++this.sequence}`;
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
  readonly accrualId: string;
  readonly actorId: string;
  readonly cashAccountId: string;
  readonly companyId: string;
  readonly driverId: string;
  readonly reconciliationId: string | null;
}

/**
 * An Outsourced Driver owed 1,000 in accrued fees, funded from a Cash account
 * whose opening balance the caller chooses.
 *
 * The opening balance is a posted `opening_balance` Journal against the Cash
 * account's GL -- the same source the authoritative balance reads.
 */
async function seed(
  transaction: Transaction<DatabaseSchema>,
  options: { readonly cashPolicy: string; readonly openingBalance: string },
): Promise<Fixture> {
  const companyId = randomUUID();
  const actorId = randomUUID();
  const traderAccountId = randomUUID();
  const traderId = randomUUID();
  const driverId = randomUUID();
  const orderId = randomUUID();
  const accrualId = randomUUID();
  const feeVersionId = randomUUID();
  const areaId = randomUUID();
  const cashGl = randomUUID();
  const equityGl = randomUUID();
  const cashAccountId = randomUUID();
  const short = companyId.slice(0, 8);

  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${companyId}::uuid,${`FB-${short}`},${`fb-${short}`},'Fee Balance Test','active',now())`.execute(
    transaction,
  );
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash) values
    (${actorId}::uuid,${companyId}::uuid,'company_user',${`fb.a.${actorId}`},'x'),
    (${traderAccountId}::uuid,${companyId}::uuid,'trader',${`fb.t.${traderId}`},'x')`.execute(
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
    // Draft first, then lines, then stepped to posted: a posted Journal is
    // immutable and the lifecycle trigger allows one transition at a time.
    await sql`insert into journal_entries(
        id,company_id,journal_number,accounting_period_id,fiscal_year_id,business_date,source_type,
        description,status,journal_type,created_by_account_id,total_debit,total_credit
      ) values(${journalId}::uuid,${companyId}::uuid,'JRN-OPEN-1',${accountingPeriodId}::uuid,
        ${fiscalYearId}::uuid,current_date,'opening_balance','Opening balance','draft',
        'opening_balance',${actorId}::uuid,
        ${options.openingBalance}::numeric,${options.openingBalance}::numeric)`.execute(transaction);
    await sql`insert into journal_lines(
        company_id,journal_entry_id,line_number,account_id,debit,credit,account_code_snapshot
      ) values
        (${companyId}::uuid,${journalId}::uuid,1,${cashGl}::uuid,
          ${options.openingBalance}::numeric,0,'1010'),
        (${companyId}::uuid,${journalId}::uuid,2,${equityGl}::uuid,
          0,${options.openingBalance}::numeric,'3010')`.execute(transaction);
    await sql`update journal_entries set status='balanced'
       where id=${journalId}::uuid and company_id=${companyId}::uuid`.execute(transaction);
    await sql`update journal_entries
         set status='approved',approved_by_account_id=${actorId}::uuid,approved_at=now()
       where id=${journalId}::uuid and company_id=${companyId}::uuid`.execute(transaction);
    await sql`update journal_entries
         set status='posted',posted_by_account_id=${actorId}::uuid,posted_at=now()
       where id=${journalId}::uuid and company_id=${companyId}::uuid`.execute(transaction);
  }

  // A delivered Order for an Outsourced Driver is the only thing a fee accrual
  // may attach to -- its own trigger enforces the Driver, the delivered status
  // and the matching delivery timestamp.
  await sql`insert into traders(id,company_id,account_id,code,name_en,mobile_number,created_by_account_id)
    values(${traderId}::uuid,${companyId}::uuid,${traderAccountId}::uuid,'TRD-000001','Fee Trader',
      '971501234567',${actorId}::uuid)`.execute(transaction);
  const dubai = (
    await sql<{ id: string }>`select id from emirates where code='DXB'`.execute(transaction)
  ).rows[0]!.id;
  await sql`insert into areas(id,company_id,emirate_id,code,name_en)
    values(${areaId}::uuid,${companyId}::uuid,${dubai}::uuid,'AREA-000001','Deira')`.execute(
    transaction,
  );
  await sql`insert into drivers(
      id,company_id,code,name_en,mobile_number,driver_type,outsourced_fee_per_delivered_order
    ) values(${driverId}::uuid,${companyId}::uuid,'DRV-000001','Fee Driver','971509876543',
      'outsourced',1000)`.execute(transaction);
  await sql`insert into orders(
      service_fee_override_reason,id,company_id,order_number,order_date,trader_id,area_id,
      created_by_account_id,customer_name,customer_mobile_number,customer_address,package_count,
      payment_condition,final_service_fee_snapshot,customer_provenance_status,
      pricing_provenance_status,assigned_driver_id,delivery_status,delivered_at,
      driver_reconciliation_status,trader_settlement_status,return_status
    ) values(
      'Zero configured Service Fee (fixture)',${orderId}::uuid,${companyId}::uuid,'ORD-FEE-1',
      current_date,${traderId}::uuid,${areaId}::uuid,${actorId}::uuid,'Fee Customer','971509999999',
      'Fee address',1,'customer_pays_cod_and_fee',0,'legacy_unattributed','legacy_unattributed',
      ${driverId}::uuid,'delivered',now(),'reconciled','unsettled','not_applicable'
    )`.execute(transaction);
  await sql`insert into outsourced_driver_fee_versions(
      id,company_id,driver_id,effective_from,fee_per_order,created_by_account_id,status
    ) values(${feeVersionId}::uuid,${companyId}::uuid,${driverId}::uuid,'-infinity'::date,1000,
      ${actorId}::uuid,'active')`.execute(transaction);
  await sql`insert into outsourced_driver_fee_accruals(
      id,company_id,driver_id,order_id,delivery_date,accrual_business_date,fee_rate_version_id,
      fee_rate_snapshot,earned_amount,paid_amount,outstanding_amount,accrual_source,status,
      created_by_account_id
    ) select ${accrualId}::uuid,${companyId}::uuid,${driverId}::uuid,${orderId}::uuid,
      o.delivered_at,current_date,${feeVersionId}::uuid,1000,1000,0,1000,'delivery','accrued',
      ${actorId}::uuid
      from orders o where o.id=${orderId}::uuid`.execute(transaction);

  // A Driver reconciliation for the same Driver: a collection offset must link
  // to one, and its own guard checks the Driver and Company match.
  const reconciliationId = randomUUID();
  await sql`insert into driver_reconciliations(
      id,company_id,reconciliation_number,driver_id,business_date,gross_collections,
      driver_payable_deduction,reconciliation_expenses,net_amount_received,status,
      created_by_account_id
    ) values(${reconciliationId}::uuid,${companyId}::uuid,'DRC-000001',${driverId}::uuid,
      current_date,1000,0,0,1000,'draft',${actorId}::uuid)`.execute(transaction);

  return { accrualId, actorId, cashAccountId, companyId, driverId, reconciliationId };
}

/** The real service graph, on the outer transaction, with call counters. */
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

  // Counting calls is the only way to prove a NEGATIVE -- that a collection
  // offset, a reversal and a replay never consult the coordinator. An outcome
  // check cannot: all three would be permitted anyway if they did ask.
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

  const service = new OutsourcedDriverFeeService(
    database,
    manager,
    new PayrollOperationSupport(tenants, identities),
    history,
    new PaymentFundingAccountService(database, tenants),
    coordinator,
  );
  return { counters, service };
}

const confirmInput = (fixture: Fixture, amount: number, overrideReason?: string) => ({
  accountId: fixture.cashAccountId,
  amount,
  cashVoucherReference: "VOUCHER-1",
  driverId: fixture.driverId,
  paymentDate: new Date().toISOString().slice(0, 10),
  ...(overrideReason === undefined ? {} : { balanceOverrideReason: overrideReason }),
});

const counts = async (transaction: Transaction<DatabaseSchema>, companyId: string) => {
  const row = (
    await sql<{
      allocations: string;
      audits: string;
      events: string;
      payments: string;
      paid: string;
    }>`
      select
        (select count(*)::text from outsourced_driver_fee_payments where company_id=${companyId}::uuid)
          as payments,
        (select count(*)::text from outsourced_driver_fee_payment_allocations
          where company_id=${companyId}::uuid) as allocations,
        (select count(*)::text from balance_override_audits where company_id=${companyId}::uuid)
          as audits,
        (select count(*)::text from accounting_events where company_id=${companyId}::uuid) as events,
        (select coalesce(sum(paid_amount),0)::text from outsourced_driver_fee_accruals
          where company_id=${companyId}::uuid) as paid
    `.execute(transaction)
  ).rows[0]!;
  return {
    allocations: Number(row.allocations),
    audits: Number(row.audits),
    events: Number(row.events),
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
  const marker = new Error("rollback driver fee balance test");
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

// `outsourced_driver_fees.view` is required by the collection-offset proposal;
// `accounting.view` by the authoritative balance read behind the coordinator.
const payPermissions = [
  "outsourced_driver_fees.pay",
  "outsourced_driver_fees.view",
  "accounting.view",
];
const overridePermissions = [...payPermissions, "accounting.manage"];

describe.skipIf(!runDatabaseTests)("Outsourced Driver Fee balance enforcement", () => {
  it("confirms a Cash payment the balance covers and records the Cash account", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, { cashPolicy: "block", openingBalance: "5000" });
      const { counters, service } = buildService(transaction, fixture, payPermissions);
      const result = await service.confirmPayment(
        confirmInput(fixture, 1000),
        `fee-allowed-${randomUUID()}`,
        randomUUID(),
      );
      expect(result.status).toBe("confirmed");
      expect(result.amount).toBe("1000.00");
      expect(counters.evaluate).toBe(1);
      expect(counters.recordOverrides).toBe(0);
      const after = await counts(transaction, fixture.companyId);
      expect(after).toMatchObject({ allocations: 1, audits: 0, paid: "1000.00", payments: 1 });
      // The payment row records the exact drawer it drew on.
      const row = await sql<{ cash: string; method: string }>`
        select company_cash_account_id as cash, payment_method as method
          from outsourced_driver_fee_payments where company_id=${fixture.companyId}::uuid
      `.execute(transaction);
      expect(row.rows[0]?.cash).toBe(fixture.cashAccountId);
      expect(row.rows[0]?.method).toBe("cash");
    });
  });

  it("refuses a Cash payment that would go negative, leaving nothing behind", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, { cashPolicy: "block", openingBalance: "100" });
      const { counters, service } = buildService(transaction, fixture, payPermissions);
      const before = await counts(transaction, fixture.companyId);
      await expect(
        service.confirmPayment(confirmInput(fixture, 1000), `fee-blocked-${randomUUID()}`, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "balance_would_go_negative" });
      expect(counters.evaluate).toBe(1);
      expect(counters.recordOverrides).toBe(0);
      // Every write the confirmation had made unwound: no payment, no
      // allocation, no override audit, no Accounting Event, and the Driver is
      // still owed in full.
      const after = await counts(transaction, fixture.companyId);
      expect(after).toEqual({
        allocations: 0,
        audits: 0,
        events: before.events,
        paid: "0.00",
        payments: 0,
      });
      // No Journal either -- there is no Event to post from.
      const journals = await sql<{ count: string }>`
        select count(*)::text as count from journal_entries
         where company_id=${fixture.companyId}::uuid and journal_type<>'opening_balance'
      `.execute(transaction);
      expect(journals.rows[0]?.count).toBe("0");
    });
  });

  it("reports the balance figures on the refusal without leaking identifiers", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, { cashPolicy: "block", openingBalance: "100" });
      const { service } = buildService(transaction, fixture, payPermissions);
      const error = await service
        .confirmPayment(confirmInput(fixture, 1000), `fee-detail-${randomUUID()}`, randomUUID())
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

  it("accepts an authorised override and writes exactly one matching audit", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, {
        cashPolicy: "allow_with_override",
        openingBalance: "100",
      });
      const { counters, service } = buildService(transaction, fixture, overridePermissions);
      const result = await service.confirmPayment(
        confirmInput(fixture, 1000, "Authorised by the Finance Director"),
        `fee-override-${randomUUID()}`,
        randomUUID(),
      );
      expect(counters.recordOverrides).toBe(1);
      expect(await counts(transaction, fixture.companyId)).toMatchObject({ audits: 1, payments: 1 });
      const audit = await sql<{
        applied: string;
        current: string;
        entity: string;
        kind: string;
        projected: string;
        reference: string;
        transactionAmount: string;
      }>`
        select source_entity_id as entity, source_reference as reference, account_kind as kind,
               transaction_amount::text as "transactionAmount", current_balance::text as current,
               projected_balance::text as projected, applied_policy as applied
          from balance_override_audits where company_id=${fixture.companyId}::uuid
      `.execute(transaction);
      const row = audit.rows[0]!;
      // Attributable to the payment, and carrying the SAME figures the
      // coordinator decided on -- not a recalculation that could disagree.
      expect(row.entity).toBe(result.paymentId);
      expect(row.reference).toBe(result.paymentNumber);
      expect(row.kind).toBe("cash");
      expect(new Decimal(row.transactionAmount).toFixed(2)).toBe("1000.00");
      expect(new Decimal(row.current).toFixed(2)).toBe("100.00");
      expect(new Decimal(row.projected).toFixed(2)).toBe("-900.00");
      expect(row.applied).toBe("allow_with_override");
    });
  });

  it("refuses an override with no reason, leaving no payment or audit", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, {
        cashPolicy: "allow_with_override",
        openingBalance: "100",
      });
      const { counters, service } = buildService(transaction, fixture, overridePermissions);
      await expect(
        service.confirmPayment(confirmInput(fixture, 1000), `fee-noreason-${randomUUID()}`, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "balance_override_reason_required" });
      expect(counters.recordOverrides).toBe(0);
      expect(await counts(transaction, fixture.companyId)).toMatchObject({
        allocations: 0,
        audits: 0,
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
      const { counters, service } = buildService(transaction, fixture, payPermissions);
      await expect(
        service.confirmPayment(
          confirmInput(fixture, 1000, "Authorised by me"),
          `fee-noperm-${randomUUID()}`,
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "balance_override_not_permitted" });
      expect(counters.recordOverrides).toBe(0);
      expect(await counts(transaction, fixture.companyId)).toMatchObject({ audits: 0, payments: 0 });
    });
  });

  it("never consults the coordinator for a collection offset", async () => {
    await inRolledBackTransaction(async (transaction) => {
      // A Cash policy that blocks, and an account balance of zero. If an offset
      // were balance-checked at all it would be refused here.
      const fixture = await seed(transaction, { cashPolicy: "block", openingBalance: "0" });
      const { counters, service } = buildService(transaction, fixture, payPermissions);
      const offset = await service.confirmCollectionOffset(
        transaction as unknown as Kysely<DatabaseSchema>,
        {
          actorId: fixture.actorId,
          amount: new Decimal(1000),
          companyId: fixture.companyId,
          correlationId: randomUUID(),
          driverId: fixture.driverId,
          idempotencyKey: `fee-offset-${randomUUID()}`,
          paymentDate: new Date().toISOString().slice(0, 10),
          reconciliationId: fixture.reconciliationId!,
          safeCollectionAmount: new Decimal(1000),
        },
      );
      expect(offset?.status).toBe("confirmed");
      // The decisive assertion: the coordinator was never asked.
      expect(counters.evaluate).toBe(0);
      expect(counters.recordOverrides).toBe(0);
      const row = await sql<{ bank: string | null; cash: string | null; method: string }>`
        select payment_method as method, company_cash_account_id as cash,
               company_bank_account_id as bank
          from outsourced_driver_fee_payments where company_id=${fixture.companyId}::uuid
      `.execute(transaction);
      // An offset moves no Company money, so it names no funding account.
      expect(row.rows[0]?.method).toBe("collection_offset");
      expect(row.rows[0]?.cash).toBeNull();
      expect(row.rows[0]?.bank).toBeNull();
      expect(await counts(transaction, fixture.companyId)).toMatchObject({ audits: 0 });
    });
  });

  it("replays an identical request without re-evaluating or re-auditing", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, {
        cashPolicy: "allow_with_override",
        openingBalance: "100",
      });
      const { counters, service } = buildService(transaction, fixture, overridePermissions);
      const key = `fee-replay-${randomUUID()}`;
      const input = confirmInput(fixture, 1000, "Authorised by the Finance Director");
      const first = await service.confirmPayment(input, key, randomUUID());
      const second = await service.confirmPayment(input, key, randomUUID());
      expect(second.paymentId).toBe(first.paymentId);
      // The replay returned before the coordinator was reached at all.
      expect(counters.evaluate).toBe(1);
      expect(counters.recordOverrides).toBe(1);
      expect(await counts(transaction, fixture.companyId)).toMatchObject({ audits: 1, payments: 1 });
    });
  });

  it("rejects the same key re-sent with a changed account, amount or override reason", async () => {
    await inRolledBackTransaction(async (transaction) => {
      // A balance that comfortably covers the payment: no override is needed,
      // so this case isolates the FINGERPRINT rather than the override path.
      const fixture = await seed(transaction, {
        cashPolicy: "allow_with_override",
        openingBalance: "5000",
      });
      const { service } = buildService(transaction, fixture, overridePermissions);
      const key = `fee-fingerprint-${randomUUID()}`;
      await service.confirmPayment(confirmInput(fixture, 1000, "First reason"), key, randomUUID());
      // Each of these is a DIFFERENT request under the same key, and must be
      // refused rather than silently replaying the original.
      await expect(
        service.confirmPayment(confirmInput(fixture, 1000, "Second reason"), key, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "idempotency_key_reused" });
      await expect(
        service.confirmPayment(confirmInput(fixture, 500, "First reason"), key, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "idempotency_key_reused" });
      await expect(
        service.confirmPayment(
          { ...confirmInput(fixture, 1000, "First reason"), accountId: randomUUID() },
          key,
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "idempotency_key_reused" });
      // One payment, and no audit: the balance covered it, so no override was
      // needed and none was recorded.
      expect(await counts(transaction, fixture.companyId)).toMatchObject({ audits: 0, payments: 1 });
    });
  });

  it("never consults the coordinator on reversal", async () => {
    await inRolledBackTransaction(async (transaction) => {
      // Opening exactly covers the payment, so the account sits at zero
      // afterwards and a 'block' policy would refuse any further outflow.
      const fixture = await seed(transaction, { cashPolicy: "block", openingBalance: "1000" });
      const { counters, service } = buildService(transaction, fixture, [
        ...payPermissions,
        "outsourced_driver_fees.reverse",
      ]);
      const payment = await service.confirmPayment(
        confirmInput(fixture, 1000),
        `fee-reverse-${randomUUID()}`,
        randomUUID(),
      );
      const afterConfirm = counters.evaluate;
      await service.reversePayment(
        payment.paymentId,
        "Paid in error",
        `fee-reverse-key-${randomUUID()}`,
        randomUUID(),
      );
      // The decisive assertion: the counter did not move.
      expect(counters.evaluate).toBe(afterConfirm);
      expect(counters.recordOverrides).toBe(0);
      const state = await sql<{ paid: string; status: string }>`
        select
          (select status from outsourced_driver_fee_payments
            where id=${payment.paymentId}::uuid and company_id=${fixture.companyId}::uuid) as status,
          (select coalesce(sum(paid_amount),0)::text from outsourced_driver_fee_accruals
            where company_id=${fixture.companyId}::uuid) as paid
      `.execute(transaction);
      expect(state.rows[0]?.status).toBe("reversed");
      expect(new Decimal(state.rows[0]!.paid).toFixed(2)).toBe("0.00");
      expect(await counts(transaction, fixture.companyId)).toMatchObject({ audits: 0 });
    });
  });

  it("reports the historical coverage gap alongside a successful payment", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, { cashPolicy: "block", openingBalance: "5000" });
      // A confirmed cash fee payment from before the funding-account columns
      // existed: it records no account and therefore cannot be attributed.
      await sql`insert into outsourced_driver_fee_payments(
          company_id,payment_number,driver_id,payment_date,payment_method,payment_source,
          amount_paid,status,paid_by_account_id,idempotency_key,request_hash
        ) values(${fixture.companyId}::uuid,'DFPAY-LEGACY',${fixture.driverId}::uuid,current_date,
          'cash','separate_payment',250,'confirmed',${fixture.actorId}::uuid,
          ${`legacy-${randomUUID()}`},'legacy-hash')`.execute(transaction);

      const { service } = buildService(transaction, fixture, payPermissions);
      const result = (await service.confirmPayment(
        confirmInput(fixture, 1000),
        `fee-coverage-${randomUUID()}`,
        randomUUID(),
      )) as {
        balanceCoverage?: { outsourcedDriverFeeCashPaymentsWithoutCashAccount: number };
        balanceCoverageIncomplete?: boolean;
      };
      expect(result.balanceCoverageIncomplete).toBe(true);
      expect(result.balanceCoverage?.outsourcedDriverFeeCashPaymentsWithoutCashAccount).toBe(1);
      // Reported, never assigned: the legacy row still carries no account.
      const legacy = await sql<{ count: string }>`
        select count(*)::text as count from outsourced_driver_fee_payments
         where company_id=${fixture.companyId}::uuid and company_cash_account_id is null
      `.execute(transaction);
      expect(legacy.rows[0]?.count).toBe("1");
    });
  });
});
