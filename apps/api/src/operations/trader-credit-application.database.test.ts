import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { ConfigService } from "@nestjs/config";
import { config as loadEnvironment } from "dotenv";
import { Decimal } from "decimal.js";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { AccountMappingResolver } from "../accounting/account-mapping.resolver.js";
import { OperationalJournalPostingService } from "../accounting/operational-journal-posting.service.js";
import {
  type OperationalAccountingEventRecord,
  OperationalSourceLoader,
} from "../accounting/operational-source.loader.js";
import type { PaymentFundingAccountService } from "../accounting/payment-funding-account.service.js";
import { CompanyProfileService } from "../company-profile/company-profile.service.js";
import { type AppConfiguration, configuration } from "../configuration/environment.js";
import type { FileStoragePort } from "../files/file-storage.port.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type {
  KyselyTransactionManager,
  TransactionWork,
} from "../infrastructure/database/transaction-manager.js";
import type { IdentityContext, IdentityContextAccessor } from "../security/identity-context.js";
import type { TenantContext, TenantContextAccessor } from "../tenancy/tenant-context.js";
import { permissiveBalanceEnforcement } from "../test/balance-enforcement-stub.js";
import {
  createBusinessDayServiceStub,
  createCalendarDateReportModeServiceStub,
} from "../test/business-day-stubs.js";
import type { DriverCollectionPdfService } from "./driver-collection-pdf.service.js";
import { OperationsHistoryWriter } from "./operations-history.writer.js";
import { OperationsService } from "./operations.service.js";
import { TraderSettlementService } from "./trader-settlement.service.js";

/**
 * Trader Credits paid back in Trader Settlements, and no re-charge of a fee
 * that was reversed and credited (AL Fahd, 1-2 Oct 2026: TCR-000001..007,
 * AED 133 owed; project note
 * `claude/trader-double-fee-after-offset-reversal-2026-10-08.md`).
 *
 * Everything runs in ONE transaction that is rolled back.
 */

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `credit_app_${++this.sequence}`;
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
  readonly accountId: string;
  readonly cashGl: string;
  readonly companyId: string;
  readonly otherTraderId: string;
  readonly payableGl: string;
  readonly receivableGl: string;
  readonly traderId: string;
}

async function seed(transaction: Transaction<DatabaseSchema>): Promise<Fixture> {
  const companyId = randomUUID();
  const accountId = randomUUID();
  const roleId = randomUUID();
  const traderId = randomUUID();
  const otherTraderId = randomUUID();
  const cashGl = randomUUID();
  const receivableGl = randomUUID();
  const payableGl = randomUUID();
  const revenueGl = randomUUID();
  const fiscalYearId = randomUUID();
  const tag = companyId.slice(0, 8);
  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${companyId}::uuid,${`TCRAPP-${tag}`},${`tcrapp-${tag}`},'Credit application test','active',now())`.execute(
    transaction,
  );
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${accountId}::uuid,${companyId}::uuid,'company_user',${`tcrapp.${accountId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into permissions(code,description)
    values('users_roles.manage','Test permission') on conflict (code) do nothing`.execute(transaction);
  await sql`insert into roles(id,company_id,code,name,is_system)
    values(${roleId}::uuid,${companyId}::uuid,'company_admin','Company Administrator',true)`.execute(
    transaction,
  );
  await sql`insert into role_permissions(role_id,permission_code)
    values(${roleId}::uuid,'users_roles.manage')`.execute(transaction);
  await sql`insert into account_roles(account_id,role_id,company_id)
    values(${accountId}::uuid,${roleId}::uuid,${companyId}::uuid)`.execute(transaction);
  await sql`insert into accounting_configurations(
      company_id, accounting_enabled, automatic_posting_enabled, automatic_posting_areas,
      automatic_posting_enabled_by_account_id, automatic_posting_enabled_at
    ) values(${companyId}::uuid, true, true,
      array['orders','trader_receivables','trader_settlements'], ${accountId}::uuid, now())
    on conflict (company_id) do update set accounting_enabled=true`.execute(transaction);
  await sql`insert into chart_of_accounts(
      id,company_id,code,name_en,account_type,account_class,normal_balance,
      is_posting_account,is_active,is_control_account,control_account_type
    ) values
      (${cashGl}::uuid,${companyId}::uuid,'1010','Cash on hand','asset','cash','debit',true,true,false,null),
      (${receivableGl}::uuid,${companyId}::uuid,'1200','Accounts receivable','asset','accounts_receivable','debit',true,true,true,'accounts_receivable'),
      (${payableGl}::uuid,${companyId}::uuid,'2010','Trader payable','liability','trader_payable','credit',true,true,true,'trader_payable'),
      (${revenueGl}::uuid,${companyId}::uuid,'4020','Fee revenue','revenue','delivery_revenue','credit',true,true,false,null)`.execute(
    transaction,
  );
  await sql`insert into company_cash_accounts(
      id,company_id,cash_account_code,cash_account_name,cash_account_type,
      linked_gl_account_id,effective_from,created_by_account_id
    ) values(${randomUUID()}::uuid,${companyId}::uuid,'MAIN-CASH','Main cash',
      'main_cash',${cashGl}::uuid,'2020-01-01'::date,${accountId}::uuid)`.execute(transaction);
  for (const [key, account] of [
    ["order_cod_receivable", receivableGl],
    ["trader_payable", payableGl],
    ["additional_fee_revenue", revenueGl],
    ["trader_settlement_cash", cashGl],
  ] as const) {
    await sql`insert into account_mappings(
        company_id, mapping_key, debit_account_id, credit_account_id, effective_from, is_active
      ) values(${companyId}::uuid, ${key}, ${account}::uuid, ${account}::uuid,
        '2020-01-01'::date, true)`.execute(transaction);
  }
  await sql`insert into fiscal_years(
      id,company_id,fiscal_year_code,name,start_date,end_date,status,created_by_account_id
    ) values(${fiscalYearId}::uuid,${companyId}::uuid,'FY-2026','FY 2026',
      '2026-01-01'::date,'2026-12-31'::date,'open',${accountId}::uuid)`.execute(transaction);
  for (let month = 1; month <= 12; month += 1) {
    const start = `2026-${String(month).padStart(2, "0")}-01`;
    await sql`insert into accounting_periods(
        id,company_id,fiscal_year_id,period_code,name,period_number,period_start,period_end,status
      ) values(${randomUUID()}::uuid,${companyId}::uuid,${fiscalYearId}::uuid,
        ${`P${String(month).padStart(2, "0")}`},${`Period ${month}`},${month},
        ${start}::date,(${start}::date + interval '1 month' - interval '1 day')::date,'open')`.execute(
      transaction,
    );
  }
  await sql`insert into traders(id,company_id,code,name_en,mobile_number) values
    (${traderId}::uuid,${companyId}::uuid,${`T-${tag}`},'Credit Trader','971500000031'),
    (${otherTraderId}::uuid,${companyId}::uuid,${`T2-${tag}`},'Other Trader','971500000032')`.execute(
    transaction,
  );
  await sql`insert into emirates (code,name_en,name_ar,display_order)
    values ('DXB','Dubai','دبي',1) on conflict (code) do nothing`.execute(transaction);
  return { accountId, cashGl, companyId, otherTraderId, payableGl, receivableGl, traderId };
}

let orderSequence = 0;
async function createPayableOrder(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  net: number,
): Promise<{ id: string; orderNumber: string }> {
  const id = randomUUID();
  const areaId = randomUUID();
  orderSequence += 1;
  const orderNumber = `ORD-${fixture.companyId.slice(0, 6)}-${orderSequence}`;
  await sql`insert into areas(id,company_id,emirate_id,code,name_en)
    values(${areaId}::uuid,${fixture.companyId}::uuid,(select id from emirates where code='DXB'),
           ${`A${orderSequence}`},${`Area ${orderSequence}`})`.execute(transaction);
  await sql`
    insert into orders (
      service_fee_override_reason, id, company_id, order_number, order_date, trader_id, area_id,
      created_by_account_id, customer_name, customer_mobile_number, customer_address,
      package_count, payment_condition, final_service_fee_snapshot,
      customer_provenance_status, pricing_provenance_status,
      trader_gross_payable, trader_paid_service_fee, trader_net_payable, trader_paid_amount,
      delivery_status, driver_reconciliation_status, trader_settlement_status, return_status,
      delivered_at
    ) values (
      'Zero configured Service Fee (fixture)', ${id}::uuid, ${fixture.companyId}::uuid, ${orderNumber},
      current_date, ${fixture.traderId}::uuid, ${areaId}::uuid, ${fixture.accountId}::uuid,
      'Credit Customer', '971509999998', 'Credit address', 1,
      'customer_pays_cod_and_fee', 0, 'legacy_unattributed', 'legacy_unattributed',
      ${net}, 0, ${net}, 0, 'delivered', 'reconciled', 'unsettled', 'not_applicable', now()
    )`.execute(transaction);
  return { id, orderNumber };
}

/**
 * The AL Fahd shape, written directly: a service-charge Receivable, REVERSED,
 * compensated by an open Trader Credit (what ReceivableOffsetReversalService
 * leaves behind).
 */
async function reversedFeeWithCredit(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  orderNumber: string,
  amount: string,
  traderId = fixture.traderId,
): Promise<{ creditId: string; creditNumber: string; receivableId: string }> {
  const receivableId = randomUUID();
  const creditId = randomUUID();
  const settlementId = randomUUID();
  const suffix = receivableId.slice(0, 6);
  await sql`insert into trader_receivables(
      id,company_id,receivable_number,trader_id,source_type,source_reference,business_date,
      original_amount_due,amount_collected,status,reason,created_by_account_id
    ) values(${receivableId}::uuid,${fixture.companyId}::uuid,${`RCV-${suffix}`},${traderId}::uuid,
      'service_charge',${orderNumber},current_date,${amount},0,'outstanding','Order service fee owed by Trader',
      ${fixture.accountId}::uuid)`.execute(transaction);
  // Recognised first, as in production, then reversed.
  await postPending(transaction, fixture.companyId);
  await sql`update trader_receivables set status='reversed', updated_at=now()
     where id=${receivableId}::uuid`.execute(transaction);
  // A Credit from an offset reversal names the Settlement it came from.
  await sql`insert into trader_settlements(
      id,company_id,settlement_number,trader_id,business_date,gross_payable,service_fee_deductions,
      other_deductions,charges,adjustments,net_payable,status,created_by_account_id
    ) values(${settlementId}::uuid,${fixture.companyId}::uuid,${`SET-SRC-${suffix}`},${traderId}::uuid,
      current_date,0,0,0,0,0,0,'draft',${fixture.accountId}::uuid)`.execute(transaction);
  const order = (
    await sql<{ id: string }>`select id from orders where company_id=${fixture.companyId}::uuid
      and order_number=${orderNumber}`.execute(transaction)
  ).rows[0]!;
  const creditNumber = `TCR-${suffix}`;
  await sql`insert into trader_credits(
      id,company_id,credit_number,trader_id,business_date,amount,status,reason,source_type,
      source_receivable_id,source_order_id,source_settlement_id,created_by_account_id
    ) values(${creditId}::uuid,${fixture.companyId}::uuid,${creditNumber},${traderId}::uuid,current_date,
      ${amount},'open','Fee offset reversed','receivable_offset_reversal',${receivableId}::uuid,
      ${order.id}::uuid,${settlementId}::uuid,${fixture.accountId}::uuid)`.execute(transaction);
  return { creditId, creditNumber, receivableId };
}

function settlementService(transaction: Transaction<DatabaseSchema>, fixture: Fixture) {
  const tenants: TenantContext = { companyId: fixture.companyId, identityId: fixture.accountId };
  const identity: IdentityContext = {
    companyId: fixture.companyId,
    forcePasswordChange: false,
    identityId: fixture.accountId,
    kind: "company_user",
    permissions: new Set(["settlements.create", "settlements.reverse"]),
    sessionId: randomUUID(),
  };
  const tenantAccessor = { current: () => tenants } as unknown as TenantContextAccessor;
  const identityAccessor = { current: () => identity } as unknown as IdentityContextAccessor;
  const manager = new SavepointTransactionManager(transaction);
  const companyProfile = new CompanyProfileService(
    transaction as unknown as Kysely<DatabaseSchema>,
    manager as unknown as KyselyTransactionManager,
    tenantAccessor,
    identityAccessor,
    {} as unknown as FileStoragePort,
    { get: () => "local" } as unknown as ConfigService<AppConfiguration, true>,
  );
  return new TraderSettlementService(
    transaction as unknown as Kysely<DatabaseSchema>,
    manager as unknown as KyselyTransactionManager,
    tenantAccessor,
    {
      resolve: async (accountId: string) => ({ accountId, kind: "cash", name: "Main cash" }),
    } as unknown as PaymentFundingAccountService,
    createCalendarDateReportModeServiceStub(),
    createBusinessDayServiceStub(),
    identityAccessor,
    new OperationsHistoryWriter(),
    companyProfile,
    {} as unknown as DriverCollectionPdfService,
    permissiveBalanceEnforcement(),
  );
}

const posting = new OperationalJournalPostingService(
  new AccountMappingResolver(),
  new OperationalSourceLoader(),
  new OperationsHistoryWriter(),
);

async function postPending(transaction: Transaction<DatabaseSchema>, companyId: string) {
  const pending = await sql<OperationalAccountingEventRecord>`
    select e.id,e.company_id as "companyId",e.event_type as "eventType",
           e.event_version as "eventVersion",e.source_entity_type as "sourceEntityType",
           e.source_entity_id as "sourceEntityId",e.source_reference as "sourceReference",
           e.effective_accounting_date::text as "effectiveAccountingDate",
           e.correlation_id as "correlationId",e.event_hash as "eventHash",
           e.actor_id as "actorId",e.operational_area as "operationalArea",
           e.reversal_of_event_id as "reversalOfEventId"
      from accounting_events e
     where e.company_id=${companyId}::uuid and e.processing_status='received'
     order by e.created_at,e.id
  `.execute(transaction);
  for (const event of pending.rows) {
    await posting.process(transaction as unknown as Kysely<DatabaseSchema>, event);
  }
  return pending.rows.map((event) => event.eventType);
}

async function settlementJournal(transaction: Transaction<DatabaseSchema>, fixture: Fixture, settlementId: string) {
  return (
    await sql<{ account: string; credit: string; debit: string }>`
      select jl.account_id as account, jl.debit::text as debit, jl.credit::text as credit
        from journal_lines jl
        join journal_entries j on j.id=jl.journal_entry_id and j.company_id=jl.company_id
       where j.company_id=${fixture.companyId}::uuid and j.source_entity_type='trader_settlement'
         and j.source_entity_id=${settlementId}::uuid
    `.execute(transaction)
  ).rows;
}

async function creditState(transaction: Transaction<DatabaseSchema>, creditId: string) {
  return (
    await sql<{ amountApplied: string; remaining: string; status: string }>`
      select amount_applied::text as "amountApplied", remaining_amount::text as remaining, status
        from trader_credits where id=${creditId}::uuid`.execute(transaction)
  ).rows[0]!;
}

async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
): Promise<void> {
  const databaseUrl =
    process.env.BLUELINE_DISABLE_DOTENV === "1"
      ? process.env.DATABASE_URL
      : (loadEnvironment({ path: resolve(process.cwd(), "../../.env") }),
        configuration().database.url);
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  if (!["127.0.0.1", "localhost", "::1"].includes(new URL(databaseUrl).hostname)) {
    throw new Error("Credit application database tests must target a local database");
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const marker = new Error("rollback credit application test");
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

describe.skipIf(!runDatabaseTests)("Trader Credits paid back in Trader Settlements", () => {
  it("pays an open Credit with the next Settlement, balanced in accounting, and restores it on reversal", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const feeOrder = await createPayableOrder(transaction, fixture, 0);
      const credit = await reversedFeeWithCredit(transaction, fixture, feeOrder.orderNumber, "18.00");
      const payable = await createPayableOrder(transaction, fixture, 100);
      const service = settlementService(transaction, fixture);
      await postPending(transaction, fixture.companyId);

      const open = await service.openCredits(fixture.traderId);
      expect(open).toEqual([
        expect.objectContaining({
          creditId: credit.creditId,
          remainingAmount: "18.00",
          sourceOrderNumber: feeOrder.orderNumber,
        }),
      ]);
      expect(await service.openCredits(fixture.otherTraderId)).toEqual([]);

      const result = await service.createPayment(
        {
          allocations: [{ amount: 100, orderId: payable.id }],
          amount: 118,
          creditApplications: [{ amount: 18, creditId: credit.creditId }],
          paymentMethod: "cash",
          traderId: fixture.traderId,
        },
        randomUUID(),
        `key-credit-${randomUUID()}`,
      );
      expect(result).toMatchObject({
        amount: "118.00",
        creditAppliedAmount: "18.00",
        creditAppliedCount: 1,
        grossAmount: "100.00",
      });
      const header = (
        await sql<{ adjustments: string; net: string; paid: string }>`
          select s.adjustments::text as adjustments, s.net_payable::text as net,
                 (select sum(amount)::text from trader_settlement_payments p
                   where p.settlement_id=s.id) as paid
            from trader_settlements s where s.id=${result.settlementId}::uuid`.execute(transaction)
      ).rows[0]!;
      expect(header).toEqual({ adjustments: "18.00", net: "118.00", paid: "118.00" });
      expect(await creditState(transaction, credit.creditId)).toEqual({
        amountApplied: "18.00",
        remaining: "0.00",
        status: "applied",
      });
      expect(await service.openCredits(fixture.traderId)).toEqual([]);

      const detail = await service.detail(result.settlementId);
      expect(detail.creditApplications).toEqual([
        expect.objectContaining({ amountApplied: "18.00", creditNumber: credit.creditNumber }),
      ]);
      expect(detail.summary).toMatchObject({ netPayment: "118.00", traderCreditsApplied: "18.00" });

      // Accounting: Dr Trader Payable 100 (Order) + 18 (Credit) / Cr Cash 118.
      expect(await postPending(transaction, fixture.companyId)).toContain(
        "trader_settlement_confirmed",
      );
      const lines = await settlementJournal(transaction, fixture, result.settlementId);
      const sum = (account: string, side: "credit" | "debit") =>
        lines
          .filter((line) => line.account === account)
          .reduce((total, line) => total.plus(line[side]), new Decimal(0))
          .toFixed(2);
      expect(sum(fixture.payableGl, "debit")).toBe("118.00");
      expect(sum(fixture.cashGl, "credit")).toBe("118.00");
      const debit = lines.reduce((total, line) => total.plus(line.debit), new Decimal(0));
      const creditTotal = lines.reduce((total, line) => total.plus(line.credit), new Decimal(0));
      expect(debit.toFixed(2)).toBe(creditTotal.toFixed(2));

      // Reversal: the Credit is owed again, and accounting mirrors the Journal.
      await service.reverse(result.settlementId, "Wrong payment", randomUUID());
      expect(await creditState(transaction, credit.creditId)).toEqual({
        amountApplied: "0.00",
        remaining: "18.00",
        status: "open",
      });
      expect(await postPending(transaction, fixture.companyId)).toContain(
        "trader_settlement_reversed",
      );
      const payableNet = (
        await sql<{ net: string }>`
          select coalesce(sum(jl.credit - jl.debit),0)::text as net
            from journal_lines jl
            join journal_entries j on j.id=jl.journal_entry_id and j.company_id=jl.company_id
           where j.company_id=${fixture.companyId}::uuid and j.source_entity_type='trader_settlement'
             and jl.account_id=${fixture.payableGl}::uuid and j.status in ('posted','reversed')`.execute(
          transaction,
        )
      ).rows[0]!;
      expect(payableNet.net).toBe("0.00");

      // And it can be paid again in a later Settlement, partially.
      const again = await service.createPayment(
        {
          allocations: [{ amount: 100, orderId: payable.id }],
          amount: 110,
          creditApplications: [{ amount: 10, creditId: credit.creditId }],
          paymentMethod: "cash",
          traderId: fixture.traderId,
        },
        randomUUID(),
        `key-credit-again-${randomUUID()}`,
      );
      expect(again.creditAppliedAmount).toBe("10.00");
      expect(await creditState(transaction, credit.creditId)).toEqual({
        amountApplied: "10.00",
        remaining: "8.00",
        status: "partially_applied",
      });
    });
  });

  it("refuses another Trader's Credit, more than the Credit holds, a duplicate, and a wrong total", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const feeOrder = await createPayableOrder(transaction, fixture, 0);
      const credit = await reversedFeeWithCredit(transaction, fixture, feeOrder.orderNumber, "18.00");
      const otherFee = await createPayableOrder(transaction, fixture, 0);
      const otherCredit = await reversedFeeWithCredit(
        transaction,
        fixture,
        otherFee.orderNumber,
        "25.00",
        fixture.otherTraderId,
      );
      const payable = await createPayableOrder(transaction, fixture, 100);
      const service = settlementService(transaction, fixture);
      const attempt = (creditApplications: { amount: number; creditId: string }[], amount: number) =>
        service.createPayment(
          {
            allocations: [{ amount: 100, orderId: payable.id }],
            amount,
            creditApplications,
            paymentMethod: "cash",
            traderId: fixture.traderId,
          },
          randomUUID(),
          `key-${randomUUID()}`,
        );
      await expect(attempt([{ amount: 25, creditId: otherCredit.creditId }], 125)).rejects.toMatchObject({
        errorCode: "settlement_credit_ineligible",
      });
      await expect(attempt([{ amount: 19, creditId: credit.creditId }], 119)).rejects.toMatchObject({
        errorCode: "settlement_credit_ineligible",
      });
      await expect(
        attempt(
          [
            { amount: 9, creditId: credit.creditId },
            { amount: 9, creditId: credit.creditId },
          ],
          118,
        ),
      ).rejects.toMatchObject({ errorCode: "settlement_credit_duplicate" });
      await expect(attempt([{ amount: 18, creditId: credit.creditId }], 100)).rejects.toMatchObject({
        errorCode: "settlement_allocation_mismatch",
      });
      // Nothing was applied by any refused attempt.
      expect(await creditState(transaction, credit.creditId)).toMatchObject({ status: "open" });
      // A Settlement without Credits is unchanged.
      const plain = await attempt([], 100);
      expect(plain).toMatchObject({ amount: "100.00", creditAppliedAmount: "0.00" });
    });
  });

  it("does not charge a reversed-and-credited fee again", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const feeOrder = await createPayableOrder(transaction, fixture, 0);
      await sql`update orders set payment_condition='customer_pays_cod_trader_pays_fee', service_fee=18
         where id=${feeOrder.id}::uuid`.execute(transaction);
      const credit = await reversedFeeWithCredit(transaction, fixture, feeOrder.orderNumber, "18.00");
      // The two private steps of OperationsService under test, without its
      // full dependency graph: both only read `this` for their own helpers.
      const operations = Object.create(OperationsService.prototype) as {
        createOrderTraderReceivableIfNeeded: (database: unknown, input: unknown) => Promise<void>;
        money: (value: Decimal) => Decimal;
      };
      await operations.createOrderTraderReceivableIfNeeded(transaction, {
        actorAccountId: fixture.accountId,
        amountDue: new Decimal(18),
        companyId: fixture.companyId,
        correlationId: randomUUID(),
        orderId: feeOrder.id,
        orderNumber: feeOrder.orderNumber,
        traderId: fixture.traderId,
      });
      const active = await sql<{ count: string }>`
        select count(*)::text as count from trader_receivables
         where company_id=${fixture.companyId}::uuid and source_reference=${feeOrder.orderNumber}
           and status not in ('reversed','cancelled')`.execute(transaction);
      expect(active.rows[0]!.count).toBe("0");
      const skipped = await sql<{ value: { creditNumber: string } }>`
        select new_value as value from order_events
         where order_id=${feeOrder.id}::uuid
           and event_type='trader_receivable.not_recharged_credit_open'`.execute(transaction);
      expect(skipped.rows[0]?.value.creditNumber).toBe(credit.creditNumber);

      // Once the Credit is cancelled, the fee can be charged again.
      await sql`update trader_credits set status='cancelled', cancelled_at=now(),
           cancelled_by_account_id=${fixture.accountId}::uuid, cancelled_reason='Fee is owed'
         where id=${credit.creditId}::uuid`.execute(transaction);
      await operations.createOrderTraderReceivableIfNeeded(transaction, {
        actorAccountId: fixture.accountId,
        amountDue: new Decimal(18),
        companyId: fixture.companyId,
        correlationId: randomUUID(),
        orderId: feeOrder.id,
        orderNumber: feeOrder.orderNumber,
        traderId: fixture.traderId,
      });
      const after = await sql<{ count: string }>`
        select count(*)::text as count from trader_receivables
         where company_id=${fixture.companyId}::uuid and source_reference=${feeOrder.orderNumber}
           and status='outstanding'`.execute(transaction);
      expect(after.rows[0]!.count).toBe("1");
    });
  });
});
