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
import {
  KyselyTransactionManager,
  type TransactionWork,
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
  // An active User must hold an active Role (a deferred constraint, checked
  // at COMMIT -- only the committed rollback fixture reaches it).
  const roleId = randomUUID();
  await sql`insert into roles(id,company_id,code,name,is_system)
    values(${roleId}::uuid,${companyId}::uuid,${`rcvrev_${tag}`},'Receivable reversal test',false)`.execute(
    transaction,
  );
  await sql`insert into permissions(code,description)
    values('trader_receivables.reverse','Reverse a confirmed Trader collection')
    on conflict (code) do nothing`.execute(transaction);
  await sql`insert into role_permissions(role_id,permission_code)
    values(${roleId}::uuid,'trader_receivables.reverse')`.execute(transaction);
  await sql`insert into account_roles(account_id,role_id,company_id)
    values(${actorId}::uuid,${roleId}::uuid,${companyId}::uuid)`.execute(transaction);
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

  it("certifies the PROCESSED Delete / Reset through OrderMaintenanceService: financial reset, never a delete", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await postPending(transaction, fixture.companyId);

      // ---- BEFORE ---------------------------------------------------------
      const before = await untouchable(transaction, fixture);
      const recognitionBefore = await recognitionJournal(transaction, fixture);
      expect(recognitionBefore.journal).not.toBeNull();
      const countsBefore = await counts(transaction, fixture);
      expect(countsBefore).toMatchObject({
        collections: 0,
        credits: 0,
        creditEvents: 0,
        receivableReversedEvents: 0,
      });
      const balancesBefore = await balances(transaction, fixture);
      const orderBefore = await orderState(transaction, fixture.feeOrderId);
      expect(orderBefore).toMatchObject({
        deliveryStatus: "delivered",
        traderSettlementStatus: "not_eligible",
      });

      const maintenance = buildMaintenanceService(transaction, fixture);
      const preview = await maintenance.receivableResetPreview(fixture.feeOrderId);
      expect(preview).toMatchObject({
        action: "financial_reset",
        offsetCount: 1,
        physicalDeletePossible: false,
        receivableId: fixture.reversedReceivableId,
        requiredPermission: "trader_receivables.reverse",
      });

      // ---- EXECUTE through the production maintenance path ---------------
      const result = await maintenance.resetTraderReceivable(
        fixture.feeOrderId,
        "Fee taken before delivery",
        "corr-reset-1",
      );
      expect(result).toMatchObject({
        action: "financial_reset",
        physicalDeletePossible: false,
        receivableId: fixture.reversedReceivableId,
        receivableStatus: "reversed",
        traderCreditCount: 1,
      });
      await postPending(transaction, fixture.companyId);

      // ---- TARGET RECEIVABLE: reset, NOT deleted, history kept ----------
      const receivable = await sql<{
        status: string;
        amountCollected: string;
        outstanding: string;
      }>`
        select status, amount_collected::text as "amountCollected", outstanding_amount::text as outstanding
          from trader_receivables where id=${fixture.reversedReceivableId}::uuid
      `.execute(transaction);
      expect(receivable.rows).toEqual([
        { amountCollected: "18.00", outstanding: "0.00", status: "reversed" },
      ]);
      const audit = await sql<{ count: number }>`
        select count(*)::int as count from audit_events
         where company_id=${fixture.companyId}::uuid and action='trader_receivable.reverse_offset'
           and subject_id::text=${fixture.reversedReceivableId}
      `.execute(transaction);
      expect(audit.rows[0]!.count).toBe(1);
      const deletes = await sql<{ count: number }>`
        select count(*)::int as count from audit_events
         where company_id=${fixture.companyId}::uuid and action='trader_receivable.physical_delete'
      `.execute(transaction);
      expect(deletes.rows[0]!.count).toBe(0);

      // ---- SETTLEMENT / OFFSETS / ORDERS / settlement journal: unchanged --
      expect(await untouchable(transaction, fixture)).toEqual(before);
      const reversalSettlements = await sql<{ count: number }>`
        select count(*)::int as count from trader_settlements
         where company_id=${fixture.companyId}::uuid and reversal_of_id is not null
      `.execute(transaction);
      expect(reversalSettlements.rows[0]!.count).toBe(0);

      // ---- ORDER ---------------------------------------------------------
      expect(await orderState(transaction, fixture.feeOrderId)).toEqual(orderBefore);

      // ---- ACCOUNTING ----------------------------------------------------
      // Original recognition journal preserved: same journal, same lines; it is
      // only MARKED reversed by its own reversal journal.
      const recognitionAfter = await recognitionJournal(transaction, fixture);
      expect(recognitionAfter.journal!.journalNumber).toBe(
        recognitionBefore.journal!.journalNumber,
      );
      expect(recognitionAfter.lines).toEqual(recognitionBefore.lines);
      expect(recognitionAfter.journal!.status).toBe("reversed");

      const countsAfter = await counts(transaction, fixture);
      expect(countsAfter).toMatchObject({
        collections: 0,
        creditEvents: 1,
        credits: 1,
        receivableReversedEvents: 1,
      });
      expect(countsAfter.journals).toBe(countsBefore.journals + 2);

      // trader_receivable_reversed: Posted, linked to the original, balanced.
      const reversalJournal = await eventJournal(
        transaction,
        fixture,
        "trader_receivable_reversed",
      );
      expect(reversalJournal.status).toBe("posted");
      // Exact mirror of the recognition (DR AR 18 / CR fee revenue 18).
      expect(reversalJournal.lines).toEqual([
        { account: "1200", credit: "18.00", debit: "0.00", traderId: fixture.traderId },
        { account: "4020", credit: "0.00", debit: "18.00", traderId: fixture.traderId },
      ]);

      // Trader Credit: exactly one, AED 18.
      const credits = await sql<{ amount: string; status: string; sourceType: string }>`
        select amount::text, status, source_type as "sourceType" from trader_credits
         where company_id=${fixture.companyId}::uuid and source_receivable_id=${fixture.reversedReceivableId}::uuid
      `.execute(transaction);
      expect(credits.rows).toEqual([
        { amount: "18.00", sourceType: "receivable_offset_reversal", status: "open" },
      ]);

      // trader_credit_issued: Posted, DR order_cod_receivable 18 / CR trader_payable 18,
      // trader_id on both lines (required on the trader_payable control line).
      const creditJournal = await eventJournal(transaction, fixture, "trader_credit_issued");
      expect(creditJournal.status).toBe("posted");
      expect(creditJournal.lines).toEqual([
        { account: "1200", credit: "0.00", debit: "18.00", traderId: fixture.traderId },
        { account: "2010", credit: "18.00", debit: "0.00", traderId: fixture.traderId },
      ]);
      expect(creditJournal.mappingKeys).toEqual(["order_cod_receivable", "trader_payable"]);

      // GL chain: balanced overall, AR back to zero, payable +18, no cash.
      const balancesAfter = await balances(transaction, fixture);
      expect(balancesAfter.debit).toBe(balancesAfter.credit);
      expect(balancesAfter.ar).toBe("0.00");
      expect(balancesAfter.cash).toBe(balancesBefore.cash);
      expect((Number(balancesAfter.payable) - Number(balancesBefore.payable)).toFixed(2)).toBe(
        "18.00",
      );

      // ---- SECOND Delete / Reset: idempotent ------------------------------
      const second = await maintenance.resetTraderReceivable(
        fixture.feeOrderId,
        "second attempt",
        "corr-reset-2",
      );
      expect(second).toMatchObject({
        action: "financial_reset",
        receivableId: fixture.reversedReceivableId,
        receivableStatus: "reversed",
        traderCreditCount: 1,
      });
      expect(await postPending(transaction, fixture.companyId)).toEqual([]);
      expect(await counts(transaction, fixture)).toEqual(countsAfter);
      expect(await untouchable(transaction, fixture)).toEqual(before);
      expect(await orderState(transaction, fixture.feeOrderId)).toEqual(orderBefore);
      expect(await balances(transaction, fixture)).toEqual(balancesAfter);
    });
  });

  it("refuses a processed reset to users_roles.manage alone and writes nothing", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await postPending(transaction, fixture.companyId);
      const before = await untouchable(transaction, fixture);
      const countsBefore = await counts(transaction, fixture);
      const manageOnly = buildMaintenanceService(transaction, fixture, ["users_roles.manage"]);
      expect((await manageOnly.receivableResetPreview(fixture.feeOrderId)).requiredPermission).toBe(
        "trader_receivables.reverse",
      );
      await expect(
        manageOnly.resetTraderReceivable(fixture.feeOrderId, "manage only", "c-manage"),
      ).rejects.toMatchObject({ errorCode: "permission_denied" });
      // The reversal service itself does not accept manage-only either.
      await expect(
        buildService(transaction, fixture, ["users_roles.manage"]).execute(
          fixture.reversedReceivableId,
          "manage only",
          "c-manage-2",
        ),
      ).rejects.toMatchObject({ errorCode: "permission_denied" });
      // Reverse-only is sufficient for the processed path.
      const reverseOnly = buildMaintenanceService(transaction, fixture, [
        "trader_receivables.reverse",
      ]);
      await expect(
        reverseOnly.resetTraderReceivable(fixture.feeOrderId, "reverse only", "c-reverse"),
      ).resolves.toMatchObject({ action: "financial_reset", receivableStatus: "reversed" });
      // ...and the manage-only refusal above wrote nothing.
      expect(countsBefore.credits).toBe(0);
      expect(await untouchable(transaction, fixture)).toEqual(before);
    });
  });

  it("refuses to physically delete a processed receivable whose only dependency is an Accounting Event", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      // An outstanding Receivable in an Accounting-enabled Company: its insert
      // captured a recognition Event, so it is NOT unused.
      const orderId = randomUUID();
      const receivableId = randomUUID();
      await insertOrder(transaction, {
        actorId: fixture.actorId,
        areaId: await areaOf(transaction, fixture.companyId),
        companyId: fixture.companyId,
        id: orderId,
        orderNumber: `ORD-${orderId.slice(0, 8)}-EVT`,
        paymentCondition: "customer_pays_cod_trader_pays_fee",
        cod: "0.00",
        serviceFee: "18.00",
        traderGross: "0.00",
        traderNet: "0.00",
        settlementStatus: "not_eligible",
        traderId: fixture.traderId,
      });
      await insertReceivable(
        transaction,
        fixture.companyId,
        fixture.traderId,
        fixture.actorId,
        receivableId,
        `ORD-${orderId.slice(0, 8)}-EVT`,
      );
      const maintenance = buildMaintenanceService(transaction, fixture);
      const preview = await maintenance.receivableResetPreview(orderId);
      expect(preview).toMatchObject({
        accountingEventCount: 1,
        action: "financial_reset",
        physicalDeletePossible: false,
      });
      await expect(
        maintenance.resetTraderReceivable(orderId, "try delete", "c-evt"),
      ).rejects.toMatchObject({
        errorCode: "trader_receivable_reset_unsupported",
      });
      expect(await receivableExists(transaction, receivableId)).toBe(true);
    });
  });
});

describe.skipIf(!runDatabaseTests)("Delete / Reset: UNUSED receivable", () => {
  it("physically deletes a receivable with ZERO financial dependencies, with users_roles.manage", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const unused = await seedUnused(transaction);
      const maintenance = buildMaintenanceService(transaction, unused.fixture, [
        "users_roles.manage",
      ]);
      const preview = await maintenance.receivableResetPreview(unused.orderId);
      expect(preview).toMatchObject({
        accountingEventCount: 0,
        action: "physical_delete",
        amountCollected: "0.00",
        collectionCount: 0,
        journalCount: 0,
        offsetCount: 0,
        physicalDeletePossible: true,
        requiredPermission: "users_roles.manage",
        traderCreditCount: 0,
      });
      // The financial permission does not authorize a destructive delete.
      await expect(
        buildMaintenanceService(transaction, unused.fixture, [
          "trader_receivables.reverse",
        ]).resetTraderReceivable(unused.orderId, "reverse only", "c-u0"),
      ).rejects.toMatchObject({ errorCode: "permission_denied" });
      expect(await receivableExists(transaction, unused.receivableId)).toBe(true);

      await maintenance.resetTraderReceivable(unused.orderId, "Created in error", "c-u1");
      expect(await receivableExists(transaction, unused.receivableId)).toBe(false);
      const audit = await sql<{ count: number }>`
        select count(*)::int as count from audit_events
         where company_id=${unused.fixture.companyId}::uuid and action='trader_receivable.physical_delete'
           and subject_id::text=${unused.receivableId}
      `.execute(transaction);
      expect(audit.rows[0]!.count).toBe(1);
      const credits = await sql<{ count: number }>`
        select count(*)::int as count from trader_credits where company_id=${unused.fixture.companyId}::uuid
      `.execute(transaction);
      expect(credits.rows[0]!.count).toBe(0);
    });
  });

  it("zero-dependency guard: a single Trader Credit naming the receivable blocks the delete", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const unused = await seedUnused(transaction);
      await sql`
        insert into trader_credits(company_id,credit_number,trader_id,business_date,amount,reason,
          source_type,source_receivable_id,created_by_account_id)
        values(${unused.fixture.companyId}::uuid,'TCR-GUARD',${unused.fixture.traderId}::uuid,current_date,
          5,'guard','manual_adjustment',${unused.receivableId}::uuid,${unused.fixture.actorId}::uuid)
      `.execute(transaction);
      const maintenance = buildMaintenanceService(transaction, unused.fixture);
      const preview = await maintenance.receivableResetPreview(unused.orderId);
      expect(preview).toMatchObject({
        action: "financial_reset",
        physicalDeletePossible: false,
        traderCreditCount: 1,
      });
      await expect(
        maintenance.resetTraderReceivable(unused.orderId, "try delete", "c-g1"),
      ).rejects.toMatchObject({
        errorCode: "trader_receivable_reset_unsupported",
      });
      expect(await receivableExists(transaction, unused.receivableId)).toBe(true);
    });
  });

  it("zero-dependency guard: money applied to the receivable blocks the delete", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const unused = await seedUnused(transaction);
      await sql`update trader_receivables set amount_collected=5, status='partially_collected'
                 where id=${unused.receivableId}::uuid`.execute(transaction);
      const maintenance = buildMaintenanceService(transaction, unused.fixture);
      expect(await maintenance.receivableResetPreview(unused.orderId)).toMatchObject({
        action: "financial_reset",
        amountCollected: "5.00",
      });
      await expect(
        maintenance.resetTraderReceivable(unused.orderId, "try delete", "c-g2"),
      ).rejects.toMatchObject({
        errorCode: "trader_receivable_reset_unsupported",
      });
      expect(await receivableExists(transaction, unused.receivableId)).toBe(true);
    });
  });
});

describe.skipIf(!runDatabaseTests)("Delete / Reset: forced failure before commit", () => {
  /**
   * Runs on COMMITTED fixture data with the REAL KyselyTransactionManager, so
   * the boundary under test is the production one (`database.transaction()`),
   * not a test savepoint. The failure is injected at the last step inside the
   * reversal transaction -- the audit write, after the Receivable update, the
   * Credit insert, the Credit number reservation and the Event enqueue have
   * all executed -- and is observed from INSIDE that transaction first, so the
   * test proves work had started and was then rolled back. The fixture
   * Company is left in the disposable database (it is uniquely named and its
   * financial rows are immutable by design).
   */
  it("leaves no partial Receivable, Credit, Event, Journal, Settlement, offset or Order change", async () => {
    const database = openDatabase();
    try {
      const fixture = await database.transaction().execute((t) => seed(t));
      await database.transaction().execute((t) => postPending(t, fixture.companyId));
      const snapshot = (t: Transaction<DatabaseSchema>) =>
        Promise.all([
          untouchable(t, fixture),
          counts(t, fixture),
          orderState(t, fixture.feeOrderId),
          sql<
            Record<string, unknown>
          >`select to_jsonb(r) as row from trader_receivables r where r.id=${fixture.reversedReceivableId}::uuid`
            .execute(t)
            .then((r) => r.rows),
          sql<
            Record<string, unknown>
          >`select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) as rows from company_reference_counters c where c.company_id=${fixture.companyId}::uuid`
            .execute(t)
            .then((r) => r.rows),
        ]);
      const before = await database.transaction().execute(snapshot);

      const observed: { receivableStatus?: string; credits?: number; creditEvents?: number } = {};
      class FailingAuditWriter extends OperationsHistoryWriter {
        public override async audit(
          db: Kysely<DatabaseSchema>,
          input: Parameters<OperationsHistoryWriter["audit"]>[1],
        ): Promise<void> {
          if (input.action === "trader_receivable.reverse_offset") {
            const inside = await sql<{ status: string; credits: number; events: number }>`
              select r.status,
                (select count(*)::int from trader_credits c where c.source_receivable_id=r.id) as credits,
                (select count(*)::int from accounting_events e where e.company_id=r.company_id
                   and e.event_type='trader_credit_issued') as events
                from trader_receivables r where r.id=${fixture.reversedReceivableId}::uuid
            `.execute(db);
            observed.receivableStatus = inside.rows[0]!.status;
            observed.credits = inside.rows[0]!.credits;
            observed.creditEvents = inside.rows[0]!.events;
            throw new Error("forced failure before commit");
          }
          return super.audit(db, input);
        }
      }
      const identity = new FixedIdentity(
        fixture.companyId,
        fixture.actorId,
        new Set(["users_roles.manage", "trader_receivables.reverse"]),
      );
      const tenants = {
        current: () => ({ companyId: fixture.companyId, identityId: fixture.actorId }),
      } as unknown as TenantContextAccessor;
      const manager = new KyselyTransactionManager(database);
      const maintenance = new OrderMaintenanceService(
        database,
        tenants,
        identity as unknown as IdentityContextAccessor,
        manager,
        new OperationsHistoryWriter(),
        new ReceivableOffsetReversalService(
          database,
          manager,
          tenants,
          identity as unknown as IdentityContextAccessor,
          new FailingAuditWriter(),
        ),
      );
      await expect(
        maintenance.resetTraderReceivable(fixture.feeOrderId, "forced failure", "corr-rollback"),
      ).rejects.toThrow("forced failure before commit");

      // The work HAD started inside the transaction...
      expect(observed).toEqual({ creditEvents: 1, credits: 1, receivableStatus: "reversed" });
      // ...and none of it survived.
      expect(await database.transaction().execute(snapshot)).toEqual(before);
    } finally {
      await database.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers for the maintenance certification
// ---------------------------------------------------------------------------

function openDatabase(): Kysely<DatabaseSchema> {
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
  return new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl, max: 2 }) }),
  });
}

async function counts(transaction: Transaction<DatabaseSchema>, fixture: Fixture) {
  const rows = await sql<{
    collections: number;
    credits: number;
    creditEvents: number;
    receivableReversedEvents: number;
    journals: number;
    events: number;
  }>`
    select
      (select count(*)::int from trader_collections where company_id=${fixture.companyId}::uuid) as collections,
      (select count(*)::int from trader_credits where company_id=${fixture.companyId}::uuid) as credits,
      (select count(*)::int from accounting_events where company_id=${fixture.companyId}::uuid
         and event_type='trader_credit_issued') as "creditEvents",
      (select count(*)::int from accounting_events where company_id=${fixture.companyId}::uuid
         and event_type='trader_receivable_reversed') as "receivableReversedEvents",
      (select count(*)::int from journal_entries where company_id=${fixture.companyId}::uuid) as journals,
      (select count(*)::int from accounting_events where company_id=${fixture.companyId}::uuid) as events
  `.execute(transaction);
  return rows.rows[0]!;
}

async function orderState(transaction: Transaction<DatabaseSchema>, orderId: string) {
  const rows = await sql<{
    deliveryStatus: string;
    deliveredAt: string;
    traderSettlementStatus: string;
    row: unknown;
  }>`
    select delivery_status as "deliveryStatus", delivered_at::text as "deliveredAt",
           trader_settlement_status as "traderSettlementStatus", to_jsonb(o) as row
      from orders o where o.id=${orderId}::uuid
  `.execute(transaction);
  return rows.rows[0]!;
}

async function recognitionJournal(transaction: Transaction<DatabaseSchema>, fixture: Fixture) {
  const journal = await sql<{ id: string; journalNumber: string; status: string }>`
    select j.id, j.journal_number as "journalNumber", j.status
      from accounting_events e
      join journal_entries j on j.id=e.journal_id and j.company_id=e.company_id
     where e.company_id=${fixture.companyId}::uuid and e.event_type='trader_receivable_recognized'
       and e.source_entity_id=${fixture.reversedReceivableId}::uuid
  `.execute(transaction);
  const row = journal.rows[0] ?? null;
  const lines =
    row === null
      ? []
      : (
          await sql<Record<string, unknown>>`
            select line_number, account_id, debit::text, credit::text, trader_id, subledger_id
              from journal_lines where journal_entry_id=${row.id}::uuid order by line_number
          `.execute(transaction)
        ).rows;
  return { journal: row, lines };
}

async function eventJournal(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  eventType: "trader_credit_issued" | "trader_receivable_reversed",
) {
  const events = await sql<{ journalId: string; processingStatus: string }>`
    select journal_id as "journalId", processing_status as "processingStatus"
      from accounting_events
     where company_id=${fixture.companyId}::uuid and event_type=${eventType}
  `.execute(transaction);
  expect(events.rows).toHaveLength(1);
  expect(events.rows[0]!.processingStatus).toBe("posted");
  const journalId = events.rows[0]!.journalId;
  const journal = await sql<{ status: string }>`
    select status from journal_entries where id=${journalId}::uuid
  `.execute(transaction);
  const lines = await sql<{
    account: string;
    debit: string;
    credit: string;
    traderId: string | null;
  }>`
    select a.code as account, jl.debit::text, jl.credit::text, jl.trader_id as "traderId"
      from journal_lines jl join chart_of_accounts a on a.id=jl.account_id and a.company_id=jl.company_id
     where jl.journal_entry_id=${journalId}::uuid order by jl.line_number
  `.execute(transaction);
  const components = await sql<{ mappingKey: string }>`
    select c.mapping_key as "mappingKey" from accounting_event_components c
      join accounting_events e on e.id=c.accounting_event_id and e.company_id=c.company_id
     where e.company_id=${fixture.companyId}::uuid and e.event_type=${eventType}
     order by c.component_number
  `.execute(transaction);
  return {
    lines: lines.rows,
    mappingKeys: components.rows.map((row) => row.mappingKey),
    status: journal.rows[0]!.status,
  };
}

async function areaOf(
  transaction: Transaction<DatabaseSchema>,
  companyId: string,
): Promise<string> {
  const rows = await sql<{ id: string }>`
    select id from areas where company_id=${companyId}::uuid limit 1
  `.execute(transaction);
  return rows.rows[0]!.id;
}

async function insertReceivable(
  transaction: Transaction<DatabaseSchema>,
  companyId: string,
  traderId: string,
  actorId: string,
  id: string,
  orderNumber: string,
): Promise<void> {
  await sql`insert into trader_receivables(
      id,company_id,receivable_number,trader_id,source_type,source_reference,business_date,
      original_amount_due,amount_collected,status,reason,created_by_account_id
    ) values(${id}::uuid,${companyId}::uuid,${`RCV-${id.slice(0, 8)}`},${traderId}::uuid,'service_charge',
      ${orderNumber},'2026-10-01'::date,18,0,'outstanding','Trader-paid delivery fee',${actorId}::uuid)`.execute(
    transaction,
  );
}

async function receivableExists(
  transaction: Transaction<DatabaseSchema>,
  id: string,
): Promise<boolean> {
  const rows = await sql<{ found: boolean }>`
    select exists(select 1 from trader_receivables where id=${id}::uuid) as found
  `.execute(transaction);
  return rows.rows[0]!.found;
}

/**
 * A genuinely unused Receivable: its Company has NOT activated Accounting, so
 * no recognition Event is captured, and nothing has been collected, offset,
 * credited or journalled against it.
 */
async function seedUnused(transaction: Transaction<DatabaseSchema>) {
  const companyId = randomUUID();
  const actorId = randomUUID();
  const traderId = randomUUID();
  const areaId = randomUUID();
  const orderId = randomUUID();
  const receivableId = randomUUID();
  const tag = companyId.slice(0, 8);
  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${companyId}::uuid,${`RCVDEL-${tag}`},${`rcvdel-${tag}`},'Unused receivable test','active',now())`.execute(
    transaction,
  );
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${actorId}::uuid,${companyId}::uuid,'company_user',${`rcvdel.${actorId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into emirates (code,name_en,name_ar,display_order)
    values ('DXB','Dubai','دبي',1) on conflict (code) do nothing`.execute(transaction);
  await sql`insert into traders(id,company_id,code,name_en,mobile_number)
    values(${traderId}::uuid,${companyId}::uuid,${`T-${tag}`},'Unused Trader','971500000030')`.execute(
    transaction,
  );
  await sql`insert into areas(id,company_id,emirate_id,code,name_en)
    values(${areaId}::uuid,${companyId}::uuid,(select id from emirates where code='DXB'),${`A-${tag}`},'Area')`.execute(
    transaction,
  );
  const orderNumber = `ORD-${tag}-UNUSED`;
  await insertOrder(transaction, {
    actorId,
    areaId,
    companyId,
    id: orderId,
    orderNumber,
    paymentCondition: "customer_pays_cod_trader_pays_fee",
    cod: "0.00",
    serviceFee: "18.00",
    traderGross: "0.00",
    traderNet: "0.00",
    settlementStatus: "not_eligible",
    traderId,
  });
  await insertReceivable(transaction, companyId, traderId, actorId, receivableId, orderNumber);
  const events = await sql<{ count: number }>`
    select count(*)::int as count from accounting_events where company_id=${companyId}::uuid
  `.execute(transaction);
  expect(events.rows[0]!.count).toBe(0);
  return {
    fixture: { actorId, companyId, traderId } as unknown as Fixture,
    orderId,
    receivableId,
  };
}
