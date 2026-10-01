import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { AccountMappingResolver } from "../accounting/account-mapping.resolver.js";
import { OperationalJournalPostingService } from "../accounting/operational-journal-posting.service.js";
import {
  type OperationalAccountingEventRecord,
  OperationalSourceLoader,
} from "../accounting/operational-source.loader.js";
import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type {
  KyselyTransactionManager,
  TransactionWork,
} from "../infrastructure/database/transaction-manager.js";
import type { IdentityContextAccessor } from "../security/identity-context.js";
import type { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { OperationsHistoryWriter } from "./operations-history.writer.js";
import { OrderMaintenanceService } from "./order-maintenance.service.js";
import { ReceivableOffsetReversalService } from "./receivable-offset-reversal.service.js";

/**
 * End-to-end certification of the receivable-scoped offset reversal against a
 * real schema, modelled on the production case:
 *
 *   ORD-000108 (Trader pays fee, COD 0.00, delivered, `not_eligible`)
 *     -> RCV-000047 AED 18, cleared by an offset inside SET-000007
 *   SET-000007 carries MORE THAN ONE offset and a real cash payment.
 *
 * Reversing RCV-000047 must:
 *   - leave the Settlement header, its payment, its order lines and EVERY
 *     offset row byte-for-byte unchanged, including the offset being reversed;
 *   - leave the Settlement's posted Journal untouched;
 *   - leave the Order untouched (`delivered`, `not_eligible`);
 *   - create no physical Trader Collection and move no cash;
 *   - issue exactly one Trader Credit for AED 18, idempotently;
 *   - post `trader_credit_issued` as a balanced Journal on existing mappings;
 *   - leave the Trader's net position unchanged and AR for the Trader at zero.
 *
 * Everything runs inside ONE transaction that is rolled back, so nothing
 * outlives the test. Gated on RUN_INTEGRITY_DATABASE and, with dotenv
 * disabled, on the verified disposable database.
 */

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `rcv_rev_${++this.sequence}`;
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
  readonly actorId: string;
  readonly companyId: string;
  readonly receivableGl: string;
  readonly payableGl: string;
  readonly cashGl: string;
  readonly feeOrderId: string;
  readonly unusedOrderId: string;
  readonly unusedReceivableId: string;
  readonly payableOrderId: string;
  readonly reversedReceivableId: string;
  readonly otherReceivableId: string;
  readonly settlementId: string;
  readonly traderId: string;
}

async function seed(transaction: Transaction<DatabaseSchema>): Promise<Fixture> {
  const companyId = randomUUID();
  const actorId = randomUUID();
  const cashGl = randomUUID();
  const cashAccountId = randomUUID();
  const receivableGl = randomUUID();
  const payableGl = randomUUID();
  const revenueGl = randomUUID();
  const fiscalYearId = randomUUID();
  const traderId = randomUUID();
  const areaId = randomUUID();
  const feeOrderId = randomUUID();
  const unusedOrderId = randomUUID();
  const unusedReceivableId = randomUUID();
  const payableOrderId = randomUUID();
  const reversedReceivableId = randomUUID();
  const otherReceivableId = randomUUID();
  const settlementId = randomUUID();
  const tag = companyId.slice(0, 8);

  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${companyId}::uuid,${`RCVREV-${tag}`},${`rcvrev-${tag}`},'Receivable reversal test','active',now())`.execute(
    transaction,
  );
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${actorId}::uuid,${companyId}::uuid,'company_user',${`rcvrev.${actorId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into accounting_configurations(
      company_id, accounting_enabled, automatic_posting_enabled, automatic_posting_areas,
      automatic_posting_enabled_by_account_id, automatic_posting_enabled_at
    ) values(${companyId}::uuid, true, true,
      array['orders','trader_receivables','trader_settlements'], ${actorId}::uuid, now())
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
    ) values(${cashAccountId}::uuid,${companyId}::uuid,'MAIN-CASH','Main cash',
      'main_cash',${cashGl}::uuid,'2020-01-01'::date,${actorId}::uuid)`.execute(transaction);
  // ONLY the mapping keys the four Journals in play resolve. Deliberately no
  // `cod_receivable` mapping key: if anything asks for one, the test fails
  // with accounting_event_mapping_missing, exactly as production would.
  for (const [key, debit, credit] of [
    ["order_cod_receivable", receivableGl, receivableGl],
    ["trader_payable", payableGl, payableGl],
    ["additional_fee_revenue", revenueGl, revenueGl],
    ["trader_settlement_cash", cashGl, cashGl],
  ] as const) {
    await sql`insert into account_mappings(
        company_id, mapping_key, debit_account_id, credit_account_id,
        effective_from, is_active
      ) values(${companyId}::uuid, ${key}, ${debit}::uuid, ${credit}::uuid,
        '2020-01-01'::date, true)`.execute(transaction);
  }
  await sql`insert into fiscal_years(
      id,company_id,fiscal_year_code,name,start_date,end_date,status,created_by_account_id
    ) values(${fiscalYearId}::uuid,${companyId}::uuid,'FY-2026','FY 2026',
      '2026-01-01'::date,'2026-12-31'::date,'open',${actorId}::uuid)`.execute(transaction);
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
  await sql`insert into traders(id,company_id,code,name_en,mobile_number)
    values(${traderId}::uuid,${companyId}::uuid,${`T-${tag}`},'Reversal Trader','971500000020')`.execute(
    transaction,
  );
  await sql`insert into emirates (code,name_en,name_ar,display_order)
    values ('DXB','Dubai','دبي',1) on conflict (code) do nothing`.execute(transaction);
  await sql`insert into areas(id,company_id,emirate_id,code,name_en)
    values(${areaId}::uuid,${companyId}::uuid,(select id from emirates where code='DXB'),
           ${`A-${tag}`},'Reversal Area')`.execute(transaction);

  // ORD-000108's shape: Trader pays the fee, COD 0.00, delivered, and
  // `not_eligible` because the Company owes the Trader nothing on it.
  await insertOrder(transaction, {
    actorId,
    areaId,
    companyId,
    id: feeOrderId,
    orderNumber: `ORD-${tag}-FEE`,
    paymentCondition: "customer_pays_cod_trader_pays_fee",
    cod: "0.00",
    serviceFee: "18.00",
    traderGross: "0.00",
    traderNet: "0.00",
    settlementStatus: "not_eligible",
    traderId,
  });
  // A clean, outstanding receivable with no financial dependencies. The
  // maintenance path may physically delete this class only.
  await insertOrder(transaction, {
    actorId,
    areaId,
    companyId,
    id: unusedOrderId,
    orderNumber: `ORD-${tag}-UNUSED`,
    paymentCondition: "customer_pays_cod_trader_pays_fee",
    cod: "0.00",
    serviceFee: "18.00",
    traderGross: "0.00",
    traderNet: "0.00",
    settlementStatus: "not_eligible",
    traderId,
  });
  await sql`insert into trader_receivables(
      id,company_id,receivable_number,trader_id,source_type,source_reference,business_date,
      original_amount_due,amount_collected,status,reason,created_by_account_id
    ) values(${unusedReceivableId}::uuid,${companyId}::uuid,${`RCV-${tag}-UNUSED`},${traderId}::uuid,
      'service_charge',${`ORD-${tag}-UNUSED`},'2026-10-01'::date,18,0,'outstanding',
      'Unused test receivable',${actorId}::uuid)`.execute(transaction);
  // The normal insert trigger captures recognition. Remove that synthetic
  // event so this fixture represents the explicitly allowed zero-dependency
  // branch of the maintenance operation.
  await sql`delete from accounting_events
    where company_id=${companyId}::uuid and source_entity_type='trader_receivable'
      and source_entity_id=${unusedReceivableId}::uuid`.execute(transaction);
  // The Order the Settlement actually pays out on.
  await insertOrder(transaction, {
    actorId,
    areaId,
    companyId,
    id: payableOrderId,
    orderNumber: `ORD-${tag}-PAY`,
    paymentCondition: "customer_pays_cod_and_fee",
    cod: "100.00",
    serviceFee: "10.00",
    traderGross: "100.00",
    traderNet: "100.00",
    settlementStatus: "unsettled",
    traderId,
  });

  // Two service-charge Receivables, both fully cleared by offsets in ONE
  // Settlement -- the "settlement holding more than one offset" case.
  for (const [id, number, amount, reference] of [
    [reversedReceivableId, `RCV-${tag}-A`, "18.00", `ORD-${tag}-FEE`],
    [otherReceivableId, `RCV-${tag}-B`, "10.00", `ORD-${tag}-OTHER`],
  ] as const) {
    await sql`insert into trader_receivables(
        id,company_id,receivable_number,trader_id,source_type,source_reference,business_date,
        original_amount_due,amount_collected,status,reason,created_by_account_id
      ) values(${id}::uuid,${companyId}::uuid,${number},${traderId}::uuid,'service_charge',
        ${reference},'2026-10-01'::date,${amount}::numeric,${amount}::numeric,'collected',
        'Trader-paid delivery fee',${actorId}::uuid)`.execute(transaction);
  }

  // SET-000007's shape: gross 100, offsets 18 + 10, cash payment 72.
  await sql`insert into trader_settlements(
      id,company_id,settlement_number,trader_id,business_date,gross_payable,
      other_deductions,net_payable,status,created_by_account_id
    ) values(${settlementId}::uuid,${companyId}::uuid,${`SET-${tag}`},${traderId}::uuid,
      '2026-10-01'::date,100,28,72,'draft',${actorId}::uuid)`.execute(transaction);
  await sql`insert into trader_settlement_orders(
      company_id,settlement_id,order_id,gross_payable,net_payable,allocated_amount
    ) values(${companyId}::uuid,${settlementId}::uuid,${payableOrderId}::uuid,100,100,100)`.execute(
    transaction,
  );
  await sql`insert into trader_settlement_receivable_offsets(
      company_id,settlement_id,receivable_id,amount_allocated
    ) values (${companyId}::uuid,${settlementId}::uuid,${reversedReceivableId}::uuid,18),
             (${companyId}::uuid,${settlementId}::uuid,${otherReceivableId}::uuid,10)`.execute(
    transaction,
  );
  await sql`insert into trader_settlement_payments(
      company_id,settlement_id,payment_method,amount,created_by_account_id,payment_at,
      company_cash_account_id
    ) values(${companyId}::uuid,${settlementId}::uuid,'cash',72,${actorId}::uuid,now(),
      ${cashAccountId}::uuid)`.execute(transaction);
  await sql`update trader_settlements
       set status='confirmed',confirmed_by_account_id=${actorId}::uuid,confirmed_at=now()
     where id=${settlementId}::uuid and company_id=${companyId}::uuid`.execute(transaction);

  return {
    actorId,
    cashGl,
    companyId,
    feeOrderId,
    unusedOrderId,
    unusedReceivableId,
    otherReceivableId,
    payableGl,
    payableOrderId,
    receivableGl,
    reversedReceivableId,
    settlementId,
    traderId,
  };
}

async function insertOrder(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly actorId: string;
    readonly areaId: string;
    readonly cod: string;
    readonly companyId: string;
    readonly id: string;
    readonly orderNumber: string;
    readonly paymentCondition: string;
    readonly serviceFee: string;
    readonly settlementStatus: string;
    readonly traderGross: string;
    readonly traderId: string;
    readonly traderNet: string;
  },
): Promise<void> {
  await sql`
    insert into orders (
      id, company_id, order_number, order_date, trader_id, area_id, created_by_account_id,
      customer_name, customer_mobile_number, customer_address, package_count, payment_condition,
      cod_amount, service_fee, customer_amount_due, amount_collected,
      trader_gross_payable, trader_net_payable, company_revenue,
      delivery_status, driver_reconciliation_status, trader_settlement_status,
      delivered_at, pricing_provenance_status, final_service_fee_snapshot,
      customer_provenance_status
    ) values (
      ${input.id}::uuid, ${input.companyId}::uuid, ${input.orderNumber}, '2026-10-01'::date,
      ${input.traderId}::uuid, ${input.areaId}::uuid, ${input.actorId}::uuid,
      'Customer', '971500000001', 'Address', 1, ${input.paymentCondition},
      ${input.cod}::numeric, ${input.serviceFee}::numeric, ${input.cod}::numeric,
      ${input.cod}::numeric, ${input.traderGross}::numeric, ${input.traderNet}::numeric,
      ${input.serviceFee}::numeric,
      'delivered', 'not_applicable', ${input.settlementStatus},
      '2026-10-01T09:00:00Z'::timestamptz, 'legacy_unattributed', ${input.serviceFee}::numeric,
      'legacy_unattributed'
    )
  `.execute(transaction);
}

class FixedIdentity {
  public constructor(
    private readonly companyId: string,
    private readonly actorId: string,
    public permissions: Set<string>,
  ) {}
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

function buildService(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  permissions: readonly string[] = ["trader_receivables.reverse"],
) {
  const identity = new FixedIdentity(fixture.companyId, fixture.actorId, new Set(permissions));
  const tenants = {
    current: () => ({ companyId: fixture.companyId, identityId: fixture.actorId }),
  } as unknown as TenantContextAccessor;
  return new ReceivableOffsetReversalService(
    transaction as unknown as Kysely<DatabaseSchema>,
    new SavepointTransactionManager(transaction) as unknown as KyselyTransactionManager,
    tenants,
    identity as unknown as IdentityContextAccessor,
    new OperationsHistoryWriter(),
  );
}

function buildMaintenanceService(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  permissions: readonly string[] = ["users_roles.manage", "trader_receivables.reverse"],
) {
  const identity = new FixedIdentity(fixture.companyId, fixture.actorId, new Set(permissions));
  const tenants = {
    current: () => ({ companyId: fixture.companyId, identityId: fixture.actorId }),
  } as unknown as TenantContextAccessor;
  return new OrderMaintenanceService(
    transaction as unknown as Kysely<DatabaseSchema>,
    tenants,
    identity as unknown as IdentityContextAccessor,
    new SavepointTransactionManager(transaction) as unknown as KyselyTransactionManager,
    new OperationsHistoryWriter(),
    buildService(transaction, fixture, permissions),
  );
}

const posting = new OperationalJournalPostingService(
  new AccountMappingResolver(),
  new OperationalSourceLoader(),
  new OperationsHistoryWriter(),
);

/** Posts every still-`received` Event for the Company, oldest first. */
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

/** A stable, comparable snapshot of every row the reversal must not touch. */
async function untouchable(transaction: Transaction<DatabaseSchema>, fixture: Fixture) {
  const rows = await sql<{ snapshot: unknown }>`
    select jsonb_build_object(
      'settlement', (select to_jsonb(s) from trader_settlements s where s.id=${fixture.settlementId}::uuid),
      'settlementOrders', (select jsonb_agg(to_jsonb(l) order by l.id) from trader_settlement_orders l where l.settlement_id=${fixture.settlementId}::uuid),
      'payments', (select jsonb_agg(to_jsonb(p) order by p.id) from trader_settlement_payments p where p.settlement_id=${fixture.settlementId}::uuid),
      'offsets', (select jsonb_agg(to_jsonb(x) order by x.id) from trader_settlement_receivable_offsets x where x.settlement_id=${fixture.settlementId}::uuid),
      'feeOrder', (select to_jsonb(o) from orders o where o.id=${fixture.feeOrderId}::uuid),
      'payableOrder', (select to_jsonb(o) from orders o where o.id=${fixture.payableOrderId}::uuid),
      'otherReceivable', (select to_jsonb(r) from trader_receivables r where r.id=${fixture.otherReceivableId}::uuid),
      'settlementJournal', (select jsonb_agg(jsonb_build_object('journal', to_jsonb(j), 'lines',
          (select jsonb_agg(to_jsonb(jl) order by jl.line_number) from journal_lines jl where jl.journal_entry_id=j.id)))
          from journal_entries j where j.company_id=${fixture.companyId}::uuid
           and j.source_entity_type='trader_settlement' and j.source_entity_id=${fixture.settlementId}::uuid)
    ) as snapshot
  `.execute(transaction);
  return rows.rows[0]!.snapshot;
}

async function balances(transaction: Transaction<DatabaseSchema>, fixture: Fixture) {
  const rows = await sql<{
    ar: string;
    payable: string;
    cash: string;
    debit: string;
    credit: string;
  }>`
    select
      coalesce(sum(case when jl.account_id=${fixture.receivableGl}::uuid then jl.debit-jl.credit end),0)::text as ar,
      coalesce(sum(case when jl.account_id=${fixture.payableGl}::uuid then jl.credit-jl.debit end),0)::text as payable,
      coalesce(sum(case when jl.account_id=${fixture.cashGl}::uuid then jl.debit-jl.credit end),0)::text as cash,
      coalesce(sum(jl.debit),0)::text as debit,
      coalesce(sum(jl.credit),0)::text as credit
      from journal_lines jl
      join journal_entries j on j.id=jl.journal_entry_id and j.company_id=jl.company_id
     -- The ledger the reports read: a reversed original stays in it, offset by
     -- its own reversal Journal.
     where jl.company_id=${fixture.companyId}::uuid and j.status in ('posted','reversed')
  `.execute(transaction);
  return rows.rows[0]!;
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
  const parsedUrl = new URL(databaseUrl);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname)) {
    throw new Error("Receivable reversal database tests must target a local database");
  }
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const marker = new Error("rollback receivable reversal test");
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

describe.skipIf(!runDatabaseTests)("Receivable-scoped settlement-offset reversal", () => {
  it("previews ONE receivable without writing anything", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      expect(await postPending(transaction, fixture.companyId)).toEqual(
        expect.arrayContaining(["trader_receivable_recognized", "trader_settlement_confirmed"]),
      );
      const before = await untouchable(transaction, fixture);
      const preview = await buildService(transaction, fixture).preview(
        fixture.reversedReceivableId,
      );
      expect(preview).toMatchObject({
        amount: "18.00",
        blockedReason: null,
        executionAvailable: true,
        offsetAmount: "18.00",
        orderId: fixture.feeOrderId,
        orderSettlementStatus: "not_eligible",
        orderStatus: "delivered",
        physicalCashMovement: "0.00",
        physicalCollectionCount: 0,
        settlementId: fixture.settlementId,
        settlementOffsetCount: 2,
        settlementStatus: "confirmed",
        settlementWillRemainConfirmed: true,
        traderCompensation: "18.00",
        traderNetPositionChange: "0.00",
        untouchedOffsetCount: 1,
      });
      const unusedMaintenance = buildMaintenanceService(transaction, fixture);
      const unusedPreview = await unusedMaintenance.receivableResetPreview(fixture.unusedOrderId);
      expect(unusedPreview.action).toBe("physical_delete");
      await unusedMaintenance.resetTraderReceivable(
        fixture.unusedOrderId,
        "Remove unused test receivable",
        "corr-unused-delete",
      );
      const unusedAfter = await sql<{ count: number }>`
        select count(*)::int as count from trader_receivables
         where company_id=${fixture.companyId}::uuid and id=${fixture.unusedReceivableId}::uuid
      `.execute(transaction);
      expect(unusedAfter.rows[0]!.count).toBe(0);
      expect(await untouchable(transaction, fixture)).toEqual(before);
    });
  });

  it("refuses while the clearing Settlement's Accounting Event has not posted", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const preview = await buildService(transaction, fixture).preview(
        fixture.reversedReceivableId,
      );
      expect(preview.executionAvailable).toBe(false);
      expect(preview.blockedReasonCode).toBe("trader_settlement_accounting_not_posted");
      await expect(
        buildService(transaction, fixture).execute(fixture.reversedReceivableId, "reason", "c-1"),
      ).rejects.toMatchObject({ errorCode: "trader_settlement_accounting_not_posted" });
    });
  });

  it("requires the reverse permission and a reason", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await postPending(transaction, fixture.companyId);
      await expect(
        buildService(transaction, fixture, ["trader_receivables.create"]).preview(
          fixture.reversedReceivableId,
        ),
      ).rejects.toMatchObject({ errorCode: "permission_denied" });
      await expect(
        buildService(transaction, fixture).execute(fixture.reversedReceivableId, "   ", "c-2"),
      ).rejects.toMatchObject({ errorCode: "trader_receivable_reversal_reason_required" });
      await expect(
        buildMaintenanceService(transaction, fixture, ["users_roles.manage"]).resetTraderReceivable(
          fixture.feeOrderId,
          "manage-only must not reverse processed receivables",
          "c-3",
        ),
      ).rejects.toMatchObject({ errorCode: "permission_denied" });
    });
  });

  it("reverses ONE receivable, credits the Trader, posts balanced, and touches nothing else", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await postPending(transaction, fixture.companyId);
      const before = await untouchable(transaction, fixture);
      const balancesBefore = await balances(transaction, fixture);
      const collectionsBefore = await sql<{ count: number }>`
        select count(*)::int as count from trader_collections where company_id=${fixture.companyId}::uuid
      `.execute(transaction);

      const maintenance = buildMaintenanceService(transaction, fixture);
      const previewBefore = await maintenance.receivableResetPreview(fixture.feeOrderId);
      expect(previewBefore.action).toBe("financial_reset");
      const result = await maintenance.resetTraderReceivable(
        fixture.feeOrderId,
        "Fee taken before delivery",
        "corr-reverse-1",
      );
      expect(result).toMatchObject({
        receivableId: fixture.reversedReceivableId,
        action: "financial_reset",
        physicalDeletePossible: false,
      });

      // Idempotent: a retry returns the same Credit and writes nothing new.
      const retry = await maintenance.resetTraderReceivable(
        fixture.feeOrderId,
        "retry",
        "corr-reverse-2",
      );
      expect(retry.action).toBe("financial_reset");

      const credits = await sql<{
        amount: string;
        status: string;
        sourceType: string;
        count: number;
      }>`
        select amount::text, status, source_type as "sourceType", count(*) over ()::int as count
          from trader_credits
         where company_id=${fixture.companyId}::uuid and source_receivable_id=${fixture.reversedReceivableId}::uuid
      `.execute(transaction);
      expect(credits.rows).toHaveLength(1);
      expect(credits.rows[0]).toMatchObject({
        amount: "18.00",
        sourceType: "receivable_offset_reversal",
        status: "open",
      });

      const receivable = await sql<{
        status: string;
        amountCollected: string;
        outstanding: string;
      }>`
        select status, amount_collected::text as "amountCollected", outstanding_amount::text as outstanding
          from trader_receivables where id=${fixture.reversedReceivableId}::uuid
      `.execute(transaction);
      expect(receivable.rows[0]).toEqual({
        amountCollected: "18.00",
        outstanding: "0.00",
        status: "reversed",
      });

      // Exactly one Credit Event and one recognition reversal, both in the
      // trader_receivables area; nothing settlement-scoped was enqueued.
      const events = await sql<{ eventType: string; area: string; count: number }>`
        select event_type as "eventType", operational_area as area, count(*)::int as count
          from accounting_events
         where company_id=${fixture.companyId}::uuid and processing_status='received'
         group by event_type, operational_area order by event_type
      `.execute(transaction);
      expect(events.rows).toEqual([
        { area: "trader_receivables", count: 1, eventType: "trader_credit_issued" },
        { area: "trader_receivables", count: 1, eventType: "trader_receivable_reversed" },
      ]);

      expect(await postPending(transaction, fixture.companyId)).toEqual(
        expect.arrayContaining(["trader_credit_issued", "trader_receivable_reversed"]),
      );

      // The Credit's own Journal: DR AR 18 / CR Trader payable 18, with the
      // Trader on both lines, balanced, and nothing on cash.
      const creditJournal = await sql<{
        account: string;
        debit: string;
        credit: string;
        traderId: string | null;
      }>`
        select a.code as account, jl.debit::text, jl.credit::text, jl.trader_id as "traderId"
          from accounting_events e
          join journal_entries j on j.id=e.journal_id and j.company_id=e.company_id
          join journal_lines jl on jl.journal_entry_id=j.id and jl.company_id=j.company_id
          join chart_of_accounts a on a.id=jl.account_id and a.company_id=jl.company_id
         where e.company_id=${fixture.companyId}::uuid and e.event_type='trader_credit_issued'
           and e.processing_status='posted' and j.status='posted'
         order by jl.line_number
      `.execute(transaction);
      expect(creditJournal.rows).toEqual([
        { account: "1200", credit: "0.00", debit: "18.00", traderId: fixture.traderId },
        { account: "2010", credit: "18.00", debit: "0.00", traderId: fixture.traderId },
      ]);

      const balancesAfter = await balances(transaction, fixture);
      expect(balancesAfter.debit).toBe(balancesAfter.credit);
      // No cash moved.
      expect(balancesAfter.cash).toBe(balancesBefore.cash);
      // AR: recognition +18 +10, offsets -18 -10, recognition reversal -18,
      // Credit +18 => 0. Without the Credit it would be -18; without the
      // offsets having posted it would be +18.
      expect(balancesAfter.ar).toBe("0.00");
      // The Company now owes the Trader exactly the 18 it short-paid.
      expect((Number(balancesAfter.payable) - Number(balancesBefore.payable)).toFixed(2)).toBe(
        "18.00",
      );

      // Nothing else moved: Settlement header, payment, order lines, BOTH
      // offset rows, both Orders, the other Receivable, and the Settlement's
      // posted Journal are byte-for-byte what they were.
      expect(await untouchable(transaction, fixture)).toEqual(before);
      const collectionsAfter = await sql<{ count: number }>`
        select count(*)::int as count from trader_collections where company_id=${fixture.companyId}::uuid
      `.execute(transaction);
      expect(collectionsAfter.rows[0]!.count).toBe(collectionsBefore.rows[0]!.count);
      const reversalSettlements = await sql<{ count: number }>`
        select count(*)::int as count from trader_settlements
         where company_id=${fixture.companyId}::uuid and reversal_of_id is not null
      `.execute(transaction);
      expect(reversalSettlements.rows[0]!.count).toBe(0);
    });
  });
});
