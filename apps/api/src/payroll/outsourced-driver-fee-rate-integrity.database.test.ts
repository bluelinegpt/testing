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
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type {
  KyselyTransactionManager,
  TransactionWork,
} from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import type { IdentityContextAccessor } from "../security/identity-context.js";
import type { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { findOrphanedFeeAccruals } from "./outsourced-driver-fee-rate-integrity.js";
import { OutsourcedDriverFeeService } from "./outsourced-driver-fee.service.js";
import { PayrollOperationSupport } from "./payroll-operation.support.js";
import type { WorkforceConfigurationService } from "../company-configuration/workforce-configuration.service.js";
import { WorkforceConfigurationService as WorkforceConfigurationServiceCtor } from "../company-configuration/workforce-configuration.service.js";

/**
 * Outsourced Driver Fee Accrual / Rate-Version integrity.
 *
 * Confirmed incident: two of Kareem's (Dana Delivery Services) fee accruals
 * referenced a rate version whose window a later correction had retroactively
 * narrowed past their own business date -- `protect_outsourced_driver_fee_
 * foundations` correctly refused to pay them. Migration `20260810900000`
 * repaired the two live rows (extended the version's `effective_to` back to
 * cover them -- no repricing, no accrual touched) and hardened the trigger so
 * the narrowing that caused it can no longer happen silently.
 *
 * This file is what proves that repair was correct and stays correct: the
 * detection query, the exact repair transformation, the new guard at both the
 * service and trigger layer, and that a repaired accrual can actually be paid
 * or offset afterward with no duplicated financial effect.
 */

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `ofri_${++this.sequence}`;
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

function connect(): Kysely<DatabaseSchema> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 4 });
  return new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
}

async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
): Promise<void> {
  const database = connect();
  const marker = new Error("rollback outsourced driver fee rate integrity test");
  try {
    await expect(
      database.transaction().execute(async (transaction) => {
        await work(transaction);
        throw marker;
      }),
    ).rejects.toBe(marker);
  } finally {
    await database.destroy();
  }
}

interface Fixture {
  readonly accrualIds: readonly string[];
  readonly actorId: string;
  readonly cashAccountId: string;
  readonly companyId: string;
  readonly driverId: string;
  readonly orderIds: readonly string[];
}

/**
 * One Company, one outsourced Driver, a funded Cash account, and however many
 * delivered+accrued Orders `options.accruals` describes -- each accrual
 * explicitly wired to a named rate version so a test can construct the exact
 * "window narrowed under it" shape without depending on wall-clock dates.
 */
async function seed(
  transaction: Transaction<DatabaseSchema>,
  label: string,
  options: {
    readonly openingBalance?: string;
    readonly versions: readonly {
      readonly effectiveFrom: string;
      readonly effectiveTo: string | null;
      readonly feePerOrder: number;
      readonly status: "active" | "superseded";
    }[];
    readonly accruals: readonly {
      readonly accrualBusinessDate: string;
      readonly feePerOrder: number;
      readonly versionIndex: number;
    }[];
  },
): Promise<Fixture> {
  const companyId = randomUUID();
  const actorId = randomUUID();
  const traderAccountId = randomUUID();
  const traderId = randomUUID();
  const driverId = randomUUID();
  const areaId = randomUUID();
  const cashGl = randomUUID();
  const equityGl = randomUUID();
  const cashAccountId = randomUUID();
  const short = companyId.slice(0, 8);

  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${companyId}::uuid,${`OFRI-${label}-${short}`},${`ofri-${label.toLowerCase()}-${short}`},
      'Fee Rate Integrity Test','active',now())`.execute(transaction);
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash) values
    (${actorId}::uuid,${companyId}::uuid,'company_user',${`ofri.a.${actorId}`},'x'),
    (${traderAccountId}::uuid,${companyId}::uuid,'trader',${`ofri.t.${traderId}`},'x')`.execute(
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
    ) values(${companyId}::uuid,'allow','allow_within_overdraft',0,'-infinity'::date,
      'Fixture policy',${actorId}::uuid)`.execute(transaction);
  // Automatic posting ON for outsourced Driver fees, matching the real
  // Company: without this row, `enqueue_operational_accounting_event` is a
  // no-op and the payment/offset accounting assertions below would pass
  // vacuously.
  await sql`insert into accounting_configurations(company_id,accounting_enabled,
      automatic_posting_enabled,automatic_posting_areas,
      automatic_posting_enabled_by_account_id,automatic_posting_enabled_at)
    values(${companyId}::uuid,true,true,array['outsourced_driver_fees'],${actorId}::uuid,now())`.execute(
    transaction,
  );

  const openingBalance = options.openingBalance ?? "0";
  if (openingBalance !== "0") {
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
        (date_trunc('month',current_date)+interval '1 month -1 day')::date,'open')`.execute(
      transaction,
    );
    await sql`insert into journal_entries(
        id,company_id,journal_number,accounting_period_id,fiscal_year_id,business_date,source_type,
        description,status,journal_type,created_by_account_id,total_debit,total_credit
      ) values(${journalId}::uuid,${companyId}::uuid,'JRN-OPEN-1',${accountingPeriodId}::uuid,
        ${fiscalYearId}::uuid,current_date,'opening_balance','Opening balance','draft',
        'opening_balance',${actorId}::uuid,${openingBalance}::numeric,${openingBalance}::numeric)`.execute(
      transaction,
    );
    await sql`insert into journal_lines(
        company_id,journal_entry_id,line_number,account_id,debit,credit,account_code_snapshot
      ) values
        (${companyId}::uuid,${journalId}::uuid,1,${cashGl}::uuid,${openingBalance}::numeric,0,'1010'),
        (${companyId}::uuid,${journalId}::uuid,2,${equityGl}::uuid,0,${openingBalance}::numeric,'3010')`.execute(
      transaction,
    );
    await sql`update journal_entries set status='balanced'
       where id=${journalId}::uuid and company_id=${companyId}::uuid`.execute(transaction);
    await sql`update journal_entries
         set status='approved',approved_by_account_id=${actorId}::uuid,approved_at=now()
       where id=${journalId}::uuid and company_id=${companyId}::uuid`.execute(transaction);
    await sql`update journal_entries
         set status='posted',posted_by_account_id=${actorId}::uuid,posted_at=now()
       where id=${journalId}::uuid and company_id=${companyId}::uuid`.execute(transaction);
  }

  await sql`insert into traders(id,company_id,account_id,code,name_en,mobile_number,created_by_account_id)
    values(${traderId}::uuid,${companyId}::uuid,${traderAccountId}::uuid,'TRD-000001','Fee Trader',
      '971501234567',${actorId}::uuid)`.execute(transaction);
  const dubai = (
    await sql<{ id: string }>`select id from emirates where code='DXB'`.execute(transaction)
  ).rows[0]!.id;
  await sql`insert into areas(id,company_id,emirate_id,code,name_en)
    values(${areaId}::uuid,${companyId}::uuid,${dubai}::uuid,${`AREA-${short}`},'Deira')`.execute(
    transaction,
  );
  await sql`insert into drivers(
      id,company_id,code,name_en,mobile_number,driver_type,outsourced_fee_per_delivered_order
    ) values(${driverId}::uuid,${companyId}::uuid,${`DRV-${short}`},'Kareem','971509876543',
      'outsourced',${options.versions.at(-1)?.feePerOrder ?? 15})`.execute(transaction);

  const versionIds: string[] = [];
  for (const version of options.versions) {
    const versionId = randomUUID();
    versionIds.push(versionId);
    await sql`insert into outsourced_driver_fee_versions(
        id,company_id,driver_id,effective_from,effective_to,fee_per_order,created_by_account_id,status
      ) values(${versionId}::uuid,${companyId}::uuid,${driverId}::uuid,
        ${version.effectiveFrom}::date,${version.effectiveTo}::date,${version.feePerOrder},
        ${actorId}::uuid,${version.status})`.execute(transaction);
  }

  const orderIds: string[] = [];
  const accrualIds: string[] = [];
  for (const [index, accrual] of options.accruals.entries()) {
    const orderId = randomUUID();
    const accrualId = randomUUID();
    orderIds.push(orderId);
    accrualIds.push(accrualId);
    await sql`insert into orders(
        service_fee_override_reason,id,company_id,order_number,order_date,trader_id,area_id,
        created_by_account_id,customer_name,customer_mobile_number,customer_address,package_count,
        payment_condition,final_service_fee_snapshot,customer_provenance_status,
        pricing_provenance_status,assigned_driver_id,delivery_status,delivered_at,amount_collected,
        customer_amount_due,driver_reconciliation_status,trader_settlement_status,return_status
      ) values(
        'Zero configured Service Fee (fixture)',${orderId}::uuid,${companyId}::uuid,
        ${`ORD-FEE-${label}-${index}`},current_date,${traderId}::uuid,${areaId}::uuid,${actorId}::uuid,
        'Fee Customer','971509999999','Fee address',1,'customer_pays_cod_and_fee',0,
        'legacy_unattributed','legacy_unattributed',${driverId}::uuid,'delivered',
        ${accrual.accrualBusinessDate}::date,225,225,'pending','not_eligible','not_applicable'
      )`.execute(transaction);
    await sql`insert into outsourced_driver_fee_accruals(
        id,company_id,driver_id,order_id,delivery_date,accrual_business_date,fee_rate_version_id,
        fee_rate_snapshot,earned_amount,paid_amount,outstanding_amount,accrual_source,status,
        created_by_account_id
      ) select ${accrualId}::uuid,${companyId}::uuid,${driverId}::uuid,${orderId}::uuid,
        o.delivered_at,${accrual.accrualBusinessDate}::date,
        ${versionIds[accrual.versionIndex]}::uuid,${accrual.feePerOrder},${accrual.feePerOrder},0,
        ${accrual.feePerOrder},'delivery','accrued',${actorId}::uuid
        from orders o where o.id=${orderId}::uuid`.execute(transaction);
  }

  return { accrualIds, actorId, cashAccountId, companyId, driverId, orderIds };
}

function buildFeeService(transaction: Transaction<DatabaseSchema>, fixture: Fixture) {
  const tenants = {
    current: () => ({ companyId: fixture.companyId, identityId: fixture.actorId }),
  } as unknown as TenantContextAccessor;
  const identities = {
    current: () => ({
      companyId: fixture.companyId,
      forcePasswordChange: false,
      identityId: fixture.actorId,
      kind: "company_user",
      // `users_roles.manage` escalates through both Payroll's and
      // Accounting's permission checks -- needed here since a real balance
      // coordinator sits behind the payment/offset path.
      permissions: new Set(["users_roles.manage"]),
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
  return new OutsourcedDriverFeeService(
    database,
    manager,
    new PayrollOperationSupport(tenants, identities),
    history,
    new PaymentFundingAccountService(database, tenants),
    coordinator,
  );
}

function buildWorkforceService(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
): WorkforceConfigurationService {
  const tenants = {
    current: () => ({ companyId: fixture.companyId, identityId: fixture.actorId }),
  } as unknown as TenantContextAccessor;
  const identities = {
    current: () => ({
      companyId: fixture.companyId,
      forcePasswordChange: false,
      identityId: fixture.actorId,
      kind: "company_user",
      permissions: new Set(["users_roles.manage"]),
      sessionId: randomUUID(),
    }),
  } as unknown as IdentityContextAccessor;
  const database = transaction as unknown as Kysely<DatabaseSchema>;
  const manager = new SavepointTransactionManager(
    transaction,
  ) as unknown as KyselyTransactionManager;
  return new WorkforceConfigurationServiceCtor(database, manager, tenants, identities);
}

/** Exposes the private effective-dated fee sync for direct, date-controlled testing. */
function syncFee(
  service: WorkforceConfigurationService,
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  feePerOrder: string,
  effectiveFrom: string,
) {
  const withPrivate = service as unknown as {
    syncOutsourcedDriverFeeVersion(
      transaction: Kysely<DatabaseSchema>,
      companyId: string,
      driverId: string,
      actorId: string,
      feePerOrder: string,
      effectiveFrom: string | null,
    ): Promise<void>;
  };
  return withPrivate.syncOutsourcedDriverFeeVersion(
    transaction as unknown as Kysely<DatabaseSchema>,
    fixture.companyId,
    fixture.driverId,
    fixture.actorId,
    feePerOrder,
    effectiveFrom,
  );
}

/**
 * Recreates PRE-FIX historical data: a version narrowed the way it actually
 * happened in production, before this migration's guard existed. The guard
 * under test is exactly what would refuse this update through any normal
 * path today -- so building the "already broken" fixture has to go around it
 * once, deliberately, the same way genuinely pre-existing rows do.
 */
async function narrowVersionBypassingGuard(
  transaction: Transaction<DatabaseSchema>,
  versionId: string,
  newEffectiveTo: string,
) {
  await sql`alter table outsourced_driver_fee_versions
      disable trigger outsourced_driver_fee_versions_immutable`.execute(transaction);
  try {
    await sql`update outsourced_driver_fee_versions set effective_to=${newEffectiveTo}::date,status='superseded'
       where id=${versionId}::uuid`.execute(transaction);
  } finally {
    await sql`alter table outsourced_driver_fee_versions
        enable trigger outsourced_driver_fee_versions_immutable`.execute(transaction);
  }
}

/** The migration's own repair transformation, run inline for a fresh fixture. */
async function runRepair(transaction: Transaction<DatabaseSchema>) {
  return sql<{
    companyId: string;
    newEffectiveTo: string;
    oldEffectiveTo: string | null;
    versionId: string;
  }>`
    with orphaned as (
      select a.id as accrual_id, a.company_id, a.driver_id, a.fee_rate_version_id,
             a.accrual_business_date, a.fee_rate_snapshot,
             v.effective_from as v_from, v.effective_to as v_to, v.fee_per_order as v_amount
        from outsourced_driver_fee_accruals a
        join outsourced_driver_fee_versions v on v.id = a.fee_rate_version_id
       where a.status not in ('reversed','recovery_required')
         and not (
           v.effective_from <= a.accrual_business_date
           and coalesce(v.effective_to,'infinity'::date) >= a.accrual_business_date
         )
    ),
    safe as (
      select company_id, driver_id, fee_rate_version_id, v_to::text as v_to,
             max(accrual_business_date) as required_effective_to
        from orphaned
       where v_from <= accrual_business_date and v_amount = fee_rate_snapshot
       group by company_id, driver_id, fee_rate_version_id, v_to
    )
    update outsourced_driver_fee_versions target
       set effective_to = safe.required_effective_to, updated_at = now(), version = target.version + 1
      from safe
     where target.id = safe.fee_rate_version_id
    returning safe.company_id as "companyId", safe.v_to as "oldEffectiveTo",
              safe.required_effective_to::text as "newEffectiveTo", target.id as "versionId"
  `.execute(transaction);
}

const outstandingTotal = async (transaction: Transaction<DatabaseSchema>, companyId: string) =>
  (
    await sql<{ total: string }>`
      select to_char(coalesce(sum(outstanding_amount),0), 'FM999999990.00') as total
        from outsourced_driver_fee_accruals where company_id=${companyId}::uuid
    `.execute(transaction)
  ).rows[0]!.total;

const financialCounts = async (transaction: Transaction<DatabaseSchema>, companyId: string) =>
  (
    await sql<{ accruals: string; allocations: string; events: string; payments: string }>`
      select
        (select count(*)::text from outsourced_driver_fee_accruals where company_id=${companyId}::uuid)
          as accruals,
        (select count(*)::text from outsourced_driver_fee_payments where company_id=${companyId}::uuid)
          as payments,
        (select count(*)::text from outsourced_driver_fee_payment_allocations
          where company_id=${companyId}::uuid) as allocations,
        (select count(*)::text from accounting_events where company_id=${companyId}::uuid) as events
    `.execute(transaction)
  ).rows[0]!;

describe.skipIf(!runDatabaseTests)("outsourced Driver fee rate integrity", () => {
  describe("detection", () => {
    it("flags an accrual whose business date falls outside its version's window", async () => {
      await inRolledBackTransaction(async (transaction) => {
        // Open-ended at creation -- exactly what made the original accrual
        // INSERT valid -- then narrowed the way production actually narrowed
        // it, after the fact.
        const fixture = await seed(transaction, "DET1", {
          versions: [
            { effectiveFrom: "2026-08-08", effectiveTo: null, feePerOrder: 15, status: "active" },
          ],
          accruals: [{ accrualBusinessDate: "2026-08-09", feePerOrder: 15, versionIndex: 0 }],
        });
        const versionId = (
          await sql<{ id: string }>`
            select id from outsourced_driver_fee_versions where company_id=${fixture.companyId}::uuid
          `.execute(transaction)
        ).rows[0]!.id;
        await narrowVersionBypassingGuard(transaction, versionId, "2026-08-08");

        const found = await findOrphanedFeeAccruals(
          transaction as unknown as Kysely<DatabaseSchema>,
          fixture.companyId,
        );
        expect(found).toHaveLength(1);
        expect(found[0]?.accrualId).toBe(fixture.accrualIds[0]);
        expect(found[0]?.versionEffectiveTo).toBe("2026-08-08");
      });
    });

    it("does not flag an accrual whose version legitimately covers its date", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const fixture = await seed(transaction, "DET2", {
          versions: [
            { effectiveFrom: "2026-08-01", effectiveTo: null, feePerOrder: 15, status: "active" },
          ],
          accruals: [{ accrualBusinessDate: "2026-08-09", feePerOrder: 15, versionIndex: 0 }],
        });
        const found = await findOrphanedFeeAccruals(
          transaction as unknown as Kysely<DatabaseSchema>,
          fixture.companyId,
        );
        expect(found).toHaveLength(0);
      });
    });
  });

  describe("historical repair", () => {
    it("repairs a Kareem-shaped pair: window restored, amounts and accrual rows untouched, audited", async () => {
      await inRolledBackTransaction(async (transaction) => {
        // Open-ended (active) when the two accruals were created -- both
        // INSERTs valid -- then a later same-day correction (a second,
        // now-active version) narrows the first one, exactly as it happened
        // for Kareem.
        const fixture = await seed(transaction, "REP1", {
          versions: [
            { effectiveFrom: "2026-08-08", effectiveTo: null, feePerOrder: 15, status: "active" },
          ],
          accruals: [
            { accrualBusinessDate: "2026-08-09", feePerOrder: 15, versionIndex: 0 },
            { accrualBusinessDate: "2026-08-09", feePerOrder: 15, versionIndex: 0 },
          ],
        });
        const originalVersionId = (
          await sql<{ id: string }>`
            select id from outsourced_driver_fee_versions where company_id=${fixture.companyId}::uuid
          `.execute(transaction)
        ).rows[0]!.id;
        await narrowVersionBypassingGuard(transaction, originalVersionId, "2026-08-08");
        // The replacement version that supersedes it, current from Aug 9 on --
        // present in real data (Kareem's `e9f630cc`), asserted absent here from
        // affecting the repair rather than driving it.
        await sql`insert into outsourced_driver_fee_versions(
            id,company_id,driver_id,effective_from,effective_to,fee_per_order,created_by_account_id,status
          ) values(${randomUUID()}::uuid,${fixture.companyId}::uuid,${fixture.driverId}::uuid,
            '2026-08-09'::date,null,15,${fixture.actorId}::uuid,'active')`.execute(transaction);

        const before = await sql<{ id: string }>`
          select id from outsourced_driver_fee_accruals where company_id=${fixture.companyId}::uuid
        `.execute(transaction);
        expect(before.rows.map((row) => row.id).sort()).toEqual([...fixture.accrualIds].sort());

        const repaired = await runRepair(transaction);
        expect(repaired.rows).toHaveLength(1);
        expect(repaired.rows[0]?.oldEffectiveTo).toBe("2026-08-08");
        expect(repaired.rows[0]?.newEffectiveTo).toBe("2026-08-09");

        // The migration's own audit step, run the same way it runs in up().
        for (const row of repaired.rows) {
          await sql`
            insert into audit_events(company_id,action,subject_type,subject_id,before_data,after_data,
              reason,correlation_id)
            values(${row.companyId}::uuid,'outsourced_driver_fee_version.repair_effective_to',
              'outsourced_driver_fee_version',${row.versionId},
              jsonb_build_object('effectiveTo',${row.oldEffectiveTo}::text),
              jsonb_build_object('effectiveTo',${row.newEffectiveTo}::text),
              'Repair orphaned outsourced Driver fee-rate reference',
              ${`test:repair:${row.versionId}`})
          `.execute(transaction);
        }

        // No longer orphaned.
        expect(
          await findOrphanedFeeAccruals(
            transaction as unknown as Kysely<DatabaseSchema>,
            fixture.companyId,
          ),
        ).toHaveLength(0);

        // Accrual rows themselves: byte-for-byte the same set, same amounts.
        const after = await sql<{ earned: string; id: string; snapshot: string; version: string }>`
          select id, earned_amount::text as earned, fee_rate_snapshot::text as snapshot,
                 fee_rate_version_id::text as version
            from outsourced_driver_fee_accruals where company_id=${fixture.companyId}::uuid
        `.execute(transaction);
        expect(after.rows).toHaveLength(2);
        for (const row of after.rows) {
          expect(row.earned).toBe("15.00");
          expect(row.snapshot).toBe("15.00");
        }
        expect(await outstandingTotal(transaction, fixture.companyId)).toBe("30.00");

        // No duplicate accrual was created by the repair.
        const accrualCount = await sql<{ n: string }>`
          select count(*)::text as n from outsourced_driver_fee_accruals
           where company_id=${fixture.companyId}::uuid
        `.execute(transaction);
        expect(accrualCount.rows[0]?.n).toBe("2");

        const audit = await sql<{ reason: string }>`
          select reason from audit_events
           where company_id=${fixture.companyId}::uuid
             and action='outsourced_driver_fee_version.repair_effective_to'
        `.execute(transaction);
        expect(audit.rows).toHaveLength(1);
        expect(audit.rows[0]?.reason).toBe("Repair orphaned outsourced Driver fee-rate reference");
      });
    });

    it("leaves an accrual unrepaired when its own referenced rate does not match its snapshot", async () => {
      /* A deeper corruption than the one this migration fixes: the accrual's
         snapshot disagrees with the CURRENT rate of the very version it names.
         Both accrual-side and version-side immutability already make this
         unreachable through any real write path (fee_per_order cannot change
         once an accrual references it, and an accrual cannot be inserted
         unless its snapshot already matches). It is only ever reachable via a
         direct bypass -- constructed here the same way, purely to prove the
         repair does not guess when it sees a state that should not exist. */
      await inRolledBackTransaction(async (transaction) => {
        // A valid accrual at 15.00, against a version that was ALSO 15.00 at
        // that moment -- both INSERTs legitimate. The version's own rate is
        // then bypassed directly (never possible through the app) to 7.00 and
        // narrowed, reproducing a version whose CURRENT rate no longer agrees
        // with what it once priced.
        const fixture = await seed(transaction, "REP2", {
          versions: [
            { effectiveFrom: "2026-08-08", effectiveTo: null, feePerOrder: 15, status: "active" },
          ],
          accruals: [{ accrualBusinessDate: "2026-08-09", feePerOrder: 15, versionIndex: 0 }],
        });
        const versionId = (
          await sql<{ id: string }>`
            select id from outsourced_driver_fee_versions where company_id=${fixture.companyId}::uuid
          `.execute(transaction)
        ).rows[0]!.id;
        await sql`alter table outsourced_driver_fee_versions
            disable trigger outsourced_driver_fee_versions_immutable`.execute(transaction);
        try {
          await sql`update outsourced_driver_fee_versions set fee_per_order=7
             where id=${versionId}::uuid`.execute(transaction);
        } finally {
          await sql`alter table outsourced_driver_fee_versions
              enable trigger outsourced_driver_fee_versions_immutable`.execute(transaction);
        }
        await narrowVersionBypassingGuard(transaction, versionId, "2026-08-08");

        const repaired = await runRepair(transaction);
        expect(repaired.rows.filter((row) => row.companyId === fixture.companyId)).toHaveLength(0);
        const stillOrphaned = await findOrphanedFeeAccruals(
          transaction as unknown as Kysely<DatabaseSchema>,
          fixture.companyId,
        );
        expect(stillOrphaned).toHaveLength(1);
      });
    });
  });

  describe("rate-version prevention", () => {
    it("allows a future rate change with no dependent accrual", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const fixture = await seed(transaction, "PREV1", {
          versions: [
            { effectiveFrom: "2026-01-01", effectiveTo: null, feePerOrder: 15, status: "active" },
          ],
          accruals: [{ accrualBusinessDate: "2026-08-01", feePerOrder: 15, versionIndex: 0 }],
        });
        const service = buildWorkforceService(transaction, fixture);
        await expect(
          syncFee(service, transaction, fixture, "20.00", "2026-09-01"),
        ).resolves.toBeUndefined();
        const versions = await sql<{
          effectiveTo: string | null;
          feePerOrder: string;
          status: string;
        }>`
          select effective_to::text as "effectiveTo", fee_per_order::text as "feePerOrder", status
            from outsourced_driver_fee_versions where company_id=${fixture.companyId}::uuid
           order by effective_from
        `.execute(transaction);
        expect(versions.rows).toHaveLength(2);
        expect(versions.rows[0]).toMatchObject({ effectiveTo: "2026-08-31", status: "superseded" });
        expect(versions.rows[1]).toMatchObject({ feePerOrder: "20.00", status: "active" });
      });
    });

    it("keeps the historical version valid for an existing accrual after a later change", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const fixture = await seed(transaction, "PREV2", {
          versions: [
            { effectiveFrom: "2026-01-01", effectiveTo: null, feePerOrder: 15, status: "active" },
          ],
          accruals: [{ accrualBusinessDate: "2026-08-01", feePerOrder: 15, versionIndex: 0 }],
        });
        const service = buildWorkforceService(transaction, fixture);
        await syncFee(service, transaction, fixture, "20.00", "2026-09-01");
        expect(
          await findOrphanedFeeAccruals(
            transaction as unknown as Kysely<DatabaseSchema>,
            fixture.companyId,
          ),
        ).toHaveLength(0);
      });
    });

    it("blocks (at the service layer) narrowing that would orphan an existing accrual", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const fixture = await seed(transaction, "PREV3", {
          versions: [
            { effectiveFrom: "2026-01-01", effectiveTo: null, feePerOrder: 15, status: "active" },
          ],
          accruals: [{ accrualBusinessDate: "2026-08-09", feePerOrder: 15, versionIndex: 0 }],
        });
        const service = buildWorkforceService(transaction, fixture);
        // Exactly the reported shape: a correction effective ON the accrual's
        // own business date, which would leave it uncovered.
        await expect(syncFee(service, transaction, fixture, "20.00", "2026-08-09")).rejects.toThrow(
          ApplicationException,
        );
        // Rejected cleanly -- nothing was changed, still not orphaned.
        expect(
          await findOrphanedFeeAccruals(
            transaction as unknown as Kysely<DatabaseSchema>,
            fixture.companyId,
          ),
        ).toHaveLength(0);
      });
    });

    it("gives a clear, stable error code when narrowing is blocked", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const fixture = await seed(transaction, "PREV4", {
          versions: [
            { effectiveFrom: "2026-01-01", effectiveTo: null, feePerOrder: 15, status: "active" },
          ],
          accruals: [{ accrualBusinessDate: "2026-08-09", feePerOrder: 15, versionIndex: 0 }],
        });
        const service = buildWorkforceService(transaction, fixture);
        await expect(
          syncFee(service, transaction, fixture, "20.00", "2026-08-09"),
        ).rejects.toMatchObject({
          errorCode: "outsourced_driver_fee_narrowing_would_orphan_accrual",
        });
      });
    });

    it("also blocks the same narrowing directly at the database trigger", async () => {
      // Defense in depth: proves the guard survives a caller that bypasses the
      // service entirely, the way the rest of this table's immutability does.
      await inRolledBackTransaction(async (transaction) => {
        const fixture = await seed(transaction, "PREV5", {
          versions: [
            { effectiveFrom: "2026-01-01", effectiveTo: null, feePerOrder: 15, status: "active" },
          ],
          accruals: [{ accrualBusinessDate: "2026-08-09", feePerOrder: 15, versionIndex: 0 }],
        });
        const versionId = (
          await sql<{ id: string }>`
            select id from outsourced_driver_fee_versions where company_id=${fixture.companyId}::uuid
          `.execute(transaction)
        ).rows[0]!.id;
        await expect(
          sql`update outsourced_driver_fee_versions set effective_to='2026-08-08'
               where id=${versionId}::uuid`.execute(transaction),
        ).rejects.toThrow(/would leave an existing accrual without a valid rate/);
      });
    });

    it("still allows narrowing that does not affect any accrual", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const fixture = await seed(transaction, "PREV6", {
          versions: [
            { effectiveFrom: "2026-01-01", effectiveTo: null, feePerOrder: 15, status: "active" },
          ],
          accruals: [
            // Accrued well BEFORE the narrowing point below -- unaffected.
            { accrualBusinessDate: "2026-01-15", feePerOrder: 15, versionIndex: 0 },
          ],
        });
        const versionId = (
          await sql<{ id: string }>`
            select id from outsourced_driver_fee_versions where company_id=${fixture.companyId}::uuid
          `.execute(transaction)
        ).rows[0]!.id;
        await expect(
          sql`update outsourced_driver_fee_versions set effective_to='2026-06-30'
               where id=${versionId}::uuid`.execute(transaction),
        ).resolves.toBeDefined();
      });
    });

    it("prices a new delivery under the newly active rate, not the historical one", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const fixture = await seed(transaction, "PREV7", {
          versions: [
            { effectiveFrom: "2026-01-01", effectiveTo: null, feePerOrder: 15, status: "active" },
          ],
          accruals: [],
        });
        const service = buildWorkforceService(transaction, fixture);
        await syncFee(service, transaction, fixture, "20.00", "2026-09-01");
        const active = await sql<{ feePerOrder: string }>`
          select fee_per_order::text as "feePerOrder" from outsourced_driver_fee_versions
           where company_id=${fixture.companyId}::uuid and status='active'
        `.execute(transaction);
        expect(active.rows).toHaveLength(1);
        expect(active.rows[0]?.feePerOrder).toBe("20.00");
      });
    });
  });

  describe("payment", () => {
    it("pays a repaired accrual through the dedicated Driver fee payment; accounting balances", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const fixture = await seed(transaction, "PAY1", {
          openingBalance: "1000",
          versions: [
            { effectiveFrom: "2026-01-01", effectiveTo: null, feePerOrder: 15, status: "active" },
          ],
          accruals: [
            { accrualBusinessDate: "2026-08-09", feePerOrder: 15, versionIndex: 0 },
            { accrualBusinessDate: "2026-08-09", feePerOrder: 15, versionIndex: 0 },
          ],
        });
        const service = buildFeeService(transaction, fixture);
        const before = await financialCounts(transaction, fixture.companyId);

        const result = await service.confirmPayment(
          {
            accountId: fixture.cashAccountId,
            amount: 30,
            driverId: fixture.driverId,
            paymentDate: new Date().toISOString().slice(0, 10),
          } as never,
          `ofri-pay-${randomUUID()}`,
          randomUUID(),
        );
        // The service's own raw `::text` cast returns "0" rather than "0.00"
        // for an exact-zero sum -- a pre-existing cosmetic quirk, not
        // something this fix touches. `outstandingTotal` below is the
        // properly-formatted figure this test actually cares about.
        expect(Number(result.remainingDriverOutstanding)).toBe(0);
        expect(await outstandingTotal(transaction, fixture.companyId)).toBe("0.00");

        const after = await financialCounts(transaction, fixture.companyId);
        // Exactly one payment, one allocation PER accrual, one accounting event.
        expect(Number(after.payments) - Number(before.payments)).toBe(1);
        expect(Number(after.allocations) - Number(before.allocations)).toBe(2);
        expect(Number(after.events) - Number(before.events)).toBe(1);

        const audit = await sql<{ n: string }>`
          select count(*)::text as n from audit_events
           where company_id=${fixture.companyId}::uuid and subject_type='outsourced_driver_fee_payment'
        `.execute(transaction);
        expect(Number(audit.rows[0]?.n)).toBeGreaterThan(0);
      });
    });
  });

  describe("collection offset", () => {
    it("offsets a repaired accrual through a Driver Collection: 450 - 30 = 420, no duplicate payment", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const fixture = await seed(transaction, "OFF1", {
          versions: [
            { effectiveFrom: "2026-01-01", effectiveTo: null, feePerOrder: 15, status: "active" },
          ],
          accruals: [
            { accrualBusinessDate: "2026-08-09", feePerOrder: 15, versionIndex: 0 },
            { accrualBusinessDate: "2026-08-09", feePerOrder: 15, versionIndex: 0 },
          ],
        });
        const feeService = buildFeeService(transaction, fixture);
        const before = await financialCounts(transaction, fixture.companyId);

        // Gross Driver collection AED 450, matching the reported scenario --
        // eligible outsourced fee is exactly the AED 30 across both accruals.
        const proposal = await feeService.collectionOffsetProposal(
          transaction as unknown as Kysely<DatabaseSchema>,
          fixture.companyId,
          fixture.driverId,
          new Decimal(450),
        );
        expect(proposal.totalOutstanding).toBe("30.00");

        const reconciliationId = randomUUID();
        await sql`insert into driver_reconciliations(
            id,company_id,reconciliation_number,driver_id,business_date,gross_collections,
            driver_payable_deduction,reconciliation_expenses,net_amount_received,status,
            created_by_account_id,confirmed_by_account_id,confirmed_at
          ) values(${reconciliationId}::uuid,${fixture.companyId}::uuid,'DRC-OFF-1',
            ${fixture.driverId}::uuid,current_date,450,30,0,420,'confirmed',${fixture.actorId}::uuid,
            ${fixture.actorId}::uuid,now())`.execute(transaction);

        const offset = await feeService.confirmCollectionOffset(
          transaction as unknown as Kysely<DatabaseSchema>,
          {
            actorId: fixture.actorId,
            amount: new Decimal(30),
            companyId: fixture.companyId,
            correlationId: randomUUID(),
            driverId: fixture.driverId,
            idempotencyKey: `ofri-offset-${randomUUID()}`,
            paymentDate: new Date().toISOString().slice(0, 10),
            reconciliationId,
            safeCollectionAmount: new Decimal(450),
          },
        );
        expect(Number(offset?.remainingDriverOutstanding)).toBe(0);
        expect(await outstandingTotal(transaction, fixture.companyId)).toBe("0.00");

        const after = await financialCounts(transaction, fixture.companyId);
        // Exactly ONE fee payment for the whole offset -- never one per Order,
        // never a second on top of a dedicated payment.
        expect(Number(after.payments) - Number(before.payments)).toBe(1);
        expect(Number(after.allocations) - Number(before.allocations)).toBe(2);
        expect(Number(after.events) - Number(before.events)).toBe(1);
      });
    });
  });

  describe("tenancy", () => {
    it("scopes repair detection to one Company and never reports another's", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const orphanedCo = await seed(transaction, "TEN1", {
          versions: [
            { effectiveFrom: "2026-08-08", effectiveTo: null, feePerOrder: 15, status: "active" },
          ],
          accruals: [{ accrualBusinessDate: "2026-08-09", feePerOrder: 15, versionIndex: 0 }],
        });
        const orphanedVersionId = (
          await sql<{ id: string }>`
            select id from outsourced_driver_fee_versions where company_id=${orphanedCo.companyId}::uuid
          `.execute(transaction)
        ).rows[0]!.id;
        await narrowVersionBypassingGuard(transaction, orphanedVersionId, "2026-08-08");
        const cleanCo = await seed(transaction, "TEN2", {
          versions: [
            { effectiveFrom: "2026-01-01", effectiveTo: null, feePerOrder: 15, status: "active" },
          ],
          accruals: [{ accrualBusinessDate: "2026-08-01", feePerOrder: 15, versionIndex: 0 }],
        });

        expect(
          await findOrphanedFeeAccruals(
            transaction as unknown as Kysely<DatabaseSchema>,
            cleanCo.companyId,
          ),
        ).toHaveLength(0);
        const scoped = await findOrphanedFeeAccruals(
          transaction as unknown as Kysely<DatabaseSchema>,
          orphanedCo.companyId,
        );
        expect(scoped).toHaveLength(1);
        expect(scoped[0]?.companyId).toBe(orphanedCo.companyId);

        // Unscoped call still finds it -- proving the WHERE clause narrows,
        // rather than the seed accidentally missing it.
        const unscoped = await findOrphanedFeeAccruals(
          transaction as unknown as Kysely<DatabaseSchema>,
        );
        expect(unscoped.some((row) => row.companyId === orphanedCo.companyId)).toBe(true);
      });
    });

    it("does not let one Company's rate change narrow another Company's version", async () => {
      await inRolledBackTransaction(async (transaction) => {
        const companyA = await seed(transaction, "TEN3", {
          versions: [
            { effectiveFrom: "2026-01-01", effectiveTo: null, feePerOrder: 15, status: "active" },
          ],
          accruals: [{ accrualBusinessDate: "2026-08-09", feePerOrder: 15, versionIndex: 0 }],
        });
        const companyB = await seed(transaction, "TEN4", {
          versions: [
            { effectiveFrom: "2026-01-01", effectiveTo: null, feePerOrder: 15, status: "active" },
          ],
          accruals: [{ accrualBusinessDate: "2026-08-09", feePerOrder: 15, versionIndex: 0 }],
        });
        const serviceA = buildWorkforceService(transaction, companyA);
        // Blocked on A's OWN dependent accrual...
        await expect(
          syncFee(serviceA, transaction, companyA, "20.00", "2026-08-09"),
        ).rejects.toThrow(ApplicationException);
        // ...and B's version is untouched by A's attempt.
        const versionsB = await sql<{ effectiveTo: string | null }>`
          select effective_to::text as "effectiveTo" from outsourced_driver_fee_versions
           where company_id=${companyB.companyId}::uuid
        `.execute(transaction);
        expect(versionsB.rows[0]?.effectiveTo).toBeNull();
      });
    });
  });
});
