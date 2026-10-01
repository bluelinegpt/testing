import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";

import { createCaller } from "./concurrency-harness.js";

const run = process.env.RUN_SETTLEMENT_FIXTURE_DATABASE === "true";
const databaseUrl = process.env.DATABASE_URL;
const disposableDatabaseName = process.env.SETTLEMENT_FIXTURE_DB_NAME ?? "blueline_stage1_drafts_schema_20260929";
const disposableDatabasePort = process.env.SETTLEMENT_FIXTURE_DB_PORT ?? "55432";
if (run) {
  if (process.env.BLUELINE_DISABLE_DOTENV !== "1") throw new Error("Fixture test requires BLUELINE_DISABLE_DOTENV=1");
  if (databaseUrl === undefined) throw new Error("Fixture test requires an explicit DATABASE_URL");
  const parsed = new URL(databaseUrl);
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== disposableDatabasePort || parsed.pathname !== `/${disposableDatabaseName}`) {
    throw new Error("Fixture test requires the verified disposable settlement database");
  }
}

export type FixtureIds = {
  accountId: string;
  areaId: string;
  cashAccountId: string;
  chartAccountId: string;
  bankAccountId: string;
  companyId: string;
  draftId: string;
  orderId: string;
  roleId: string;
  permissionCode: string;
  traderAccountId: string;
  traderId: string;
};

const runSql = (client: PoolClient, text: string, values: unknown[] = []) =>
  client.query(text, values);

export async function createCommittedFixture(pool: Pool): Promise<FixtureIds> {
  const client = await pool.connect();
  const ids: FixtureIds = {
    accountId: randomUUID(), areaId: randomUUID(), bankAccountId: randomUUID(), cashAccountId: randomUUID(), chartAccountId: randomUUID(),
    companyId: randomUUID(), draftId: randomUUID(),
    orderId: randomUUID(), roleId: randomUUID(), permissionCode: `fixture.${randomUUID().slice(0, 8)}`, traderAccountId: randomUUID(), traderId: randomUUID(),
  };
  const marker = `STAGE2-FIXTURE-${ids.companyId}`;
  try {
    await client.query("begin");
    await runSql(client, `insert into companies (id,code,subdomain,name_en,status,activated_at) values ($1,$2,$3,$4,'active',now())`, [ids.companyId, `FX-${ids.companyId.slice(0, 8)}`, `fx-${ids.companyId.slice(0, 8)}`, marker]);
    await runSql(client, `insert into accounting_configurations (company_id,accounting_enabled) values ($1,true)`, [ids.companyId]);
    await runSql(client, `insert into accounts (id,company_id,account_kind,username,password_hash) values ($1,$2,'company_user',$3,'fixture'),($4,$2,'trader',$5,'fixture')`, [ids.accountId, ids.companyId, `${marker}.user`, ids.traderAccountId, `${marker}.trader`]);
    await runSql(client, `insert into roles (id,company_id,code,name,is_system) values ($1,$2,$3,$4,false)`, [ids.roleId, ids.companyId, `fixture_admin_${ids.companyId.slice(0, 8)}`, marker]);
    await runSql(client, `insert into permissions (code,description) values ($1,$2)`, [ids.permissionCode, marker]);
    await runSql(client, `insert into role_permissions (role_id,permission_code) values ($1,$2)`, [ids.roleId, ids.permissionCode]);
    await runSql(client, `insert into account_roles (account_id,role_id,company_id) values ($1,$2,$3)`, [ids.accountId, ids.roleId, ids.companyId]);
    await runSql(client, `insert into traders (id,company_id,account_id,code,name_en,mobile_number,created_by_account_id) values ($1,$2,$3,$4,$5,'971509999999',$6)`, [ids.traderId, ids.companyId, ids.traderAccountId, `FX-${ids.companyId.slice(0, 8)}`, marker, ids.accountId]);
    await runSql(client, `insert into company_bank_accounts (id,company_id,bank_account_code,bank_name,account_name,iban) values ($1,$2,$3,$4,$5,$6)`, [ids.bankAccountId, ids.companyId, `FX-${ids.companyId.slice(0, 8)}`, marker, marker, `AE${ids.companyId.replaceAll('-', '').slice(0, 20)}`]);
    await runSql(client, `insert into chart_of_accounts (id,company_id,code,name_en,account_type,account_class,normal_balance,is_posting_account,is_active) values ($1,$2,$3,$4,'asset','cash','debit',true,true)`, [ids.chartAccountId, ids.companyId, `FX-${ids.companyId.slice(0, 8)}`, marker]);
    await runSql(client, `insert into company_cash_accounts (id,company_id,cash_account_code,cash_account_name,cash_account_type,linked_gl_account_id,effective_from,created_by_account_id) values ($1,$2,$3,$4,'main_cash',$5,current_date,$6)`, [ids.cashAccountId, ids.companyId, `FX-${ids.companyId.slice(0, 8)}`, marker, ids.chartAccountId, ids.accountId]);
    await runSql(client, `insert into emirates (code,name_en,name_ar,display_order) values ('DXB','Dubai','دبي',1) on conflict (code) do nothing`);
    await runSql(client, `insert into areas (id,company_id,emirate_id,code,name_en) values ($1,$2,(select id from emirates where code='DXB'),$3,$4)`, [ids.areaId, ids.companyId, `FX-${ids.companyId.slice(0, 8)}`, marker]);
    await runSql(client, `insert into orders (id,company_id,order_number,order_date,trader_id,area_id,created_by_account_id,customer_name,customer_mobile_number,customer_address,package_count,payment_condition,final_service_fee_snapshot,service_fee_override_reason,customer_provenance_status,pricing_provenance_status,trader_gross_payable,trader_paid_service_fee,trader_net_payable,trader_paid_amount,delivery_status,driver_reconciliation_status,trader_settlement_status,return_status,delivered_at) values ($1,$2,$3,current_date,$4,$5,$6,$7,'971509999998',$8,1,'customer_pays_cod_and_fee',0,'Fixture zero service fee','legacy_unattributed','legacy_unattributed',25,0,25,0,'delivered','reconciled','unsettled','not_applicable',now())`, [ids.orderId, ids.companyId, `FX-${ids.companyId.slice(0, 8)}`, ids.traderId, ids.areaId, ids.accountId, marker, marker]);
    await runSql(client, `insert into trader_settlement_drafts (id,company_id,trader_id,payload,created_by_account_id,updated_by_account_id) values ($1,$2,$3,$4::jsonb,$5,$5)`, [ids.draftId, ids.companyId, ids.traderId, JSON.stringify({ traderId: ids.traderId, amount: 25, allocations: [{ orderId: ids.orderId, amount: 25 }], paymentMethod: "cash" }), ids.accountId]);
    await client.query("commit");
    return ids;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function cleanupFixture(pool: Pool, ids: FixtureIds, preservePosted = false): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await runSql(client, "delete from trader_settlement_drafts where id=$1 and company_id=$2", [ids.draftId, ids.companyId]);
    if (!preservePosted) {
      await runSql(client, "delete from trader_settlement_payments where settlement_id in (select settlement_id from trader_settlement_orders where order_id=$1)", [ids.orderId]);
      await runSql(client, "delete from trader_settlement_orders where order_id=$1", [ids.orderId]);
      await runSql(client, "delete from order_events where order_id=$1", [ids.orderId]);
      await runSql(client, "delete from order_status_history where order_id=$1", [ids.orderId]);
      await runSql(client, "delete from orders where id=$1 and company_id=$2", [ids.orderId, ids.companyId]);
      await runSql(client, "delete from areas where id=$1 and company_id=$2", [ids.areaId, ids.companyId]);
    } else {
      console.warn(`Fixture cleanup residue (immutable confirmed posting): company=${ids.companyId} order=${ids.orderId}; retained to respect settlement immutability`);
    }
    if (!preservePosted) {
      await runSql(client, "delete from company_bank_accounts where id=$1 and company_id=$2", [ids.bankAccountId, ids.companyId]);
      await runSql(client, "delete from company_cash_accounts where id=$1 and company_id=$2", [ids.cashAccountId, ids.companyId]);
      await runSql(client, "update chart_of_accounts set is_active=false where id=$1 and company_id=$2", [ids.chartAccountId, ids.companyId]);
      await runSql(client, "delete from accounting_configurations where company_id=$1", [ids.companyId]);
    } else {
      console.warn(`Fixture cleanup residue (financial posting rows): cash=${ids.cashAccountId} bank=${ids.bankAccountId} gl=${ids.chartAccountId}`);
    }
    await runSql(client, "delete from account_roles where account_id=$1 and role_id=$2 and company_id=$3", [ids.accountId, ids.roleId, ids.companyId]);
    await runSql(client, "delete from role_permissions where role_id=$1 and permission_code=$2", [ids.roleId, ids.permissionCode]);
    await runSql(client, "delete from permissions where code=$1", [ids.permissionCode]);
    if (!preservePosted) {
      await runSql(client, "delete from traders where id=$1 and company_id=$2", [ids.traderId, ids.companyId]);
    } else {
      console.warn(`Fixture cleanup residue (posted trader/order ownership): trader=${ids.traderId}`);
    }
    // Administrative accounts, roles, and their owning company are protected by
    // repository triggers. Deactivate the tracked identities and report them as
    // intentional residue instead of bypassing those guards or deleting broadly.
    await runSql(client, "update roles set is_active=false where id=$1 and company_id=$2", [ids.roleId, ids.companyId]);
    await runSql(client, "update accounts set status='disabled' where id in ($1,$2) and company_id=$3", [ids.accountId, ids.traderAccountId, ids.companyId]);
    console.warn(`Fixture cleanup residue (protected administrative rows): company=${ids.companyId} role=${ids.roleId} accounts=${ids.accountId},${ids.traderAccountId}`);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function withCommittedFixture<T>(pool: Pool, work: (ids: FixtureIds) => Promise<T>): Promise<T> {
  const ids = await createCommittedFixture(pool);
  try {
    return await work(ids);
  } finally {
    await cleanupFixture(pool, ids);
  }
}

async function insertInternationalOrder(pool: Pool, ids: FixtureIds, delivered: boolean): Promise<{ orderId: string; countryId: string; carrierId: string }> {
  const orderId = randomUUID(); const countryId = randomUUID(); const carrierId = randomUUID(); const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("insert into destination_countries(id,company_id,name,normalized_name) values($1,$2,'Oman','oman')", [countryId, ids.companyId]);
    await client.query("insert into third_party_delivery_companies(id,company_id,name,is_active) values($1,$2,$3,true)", [carrierId, ids.companyId, `Carrier-${orderId.slice(0, 8)}`]);
    await client.query(`insert into orders
      (id,company_id,order_number,order_date,order_type,trader_id,area_id,created_by_account_id,customer_name,customer_mobile_number,customer_address,package_count,payment_condition,cod_amount,service_fee,final_service_fee_snapshot,configured_service_fee_snapshot,service_fee_override_reason,customer_provenance_status,pricing_provenance_status,destination_country_id,destination_country_name,third_party_delivery_company_id,third_party_delivery_company_name,trader_gross_payable,trader_paid_service_fee,trader_net_payable,trader_paid_amount,delivery_status,driver_reconciliation_status,trader_settlement_status,return_status,delivered_at,international_carrier_status)
      values($1,$2,$3,current_date,'gcc_international',$4,$5,$6,$7,'971509999997',$8,1,'customer_pays_cod_and_fee',0,0,0,0,'Fixture international zero service fee','legacy_unattributed','manual',$9,'Oman',$10,$11,25,0,25,0,$12,'not_applicable','unsettled','not_applicable',$13,$14)`,
      [orderId, ids.companyId, `FX-INT-${orderId.slice(0, 8)}`, ids.traderId, ids.areaId, ids.accountId, `International-${orderId}`, `International-${orderId}`, countryId, carrierId, `Carrier-${orderId.slice(0, 8)}`, delivered ? "delivered" : "new", delivered ? new Date() : null, delivered ? "in_transit" : "in_transit"]);
    await client.query("commit"); return { orderId, countryId, carrierId };
  } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
}

describe.skipIf(!run)("Trader Settlement same-draft service concurrency", () => {
  it("posts one confirmation when two independent services confirm the same committed draft", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const ids = await createCommittedFixture(pool);
    const callerA = createCaller(databaseUrl!, ids.companyId, ids.accountId);
    const callerB = createCaller(databaseUrl!, ids.companyId, ids.accountId);
    try {
      const before = await pool.query<{ table_name: string; count: number }>(`
        select 'settlements' table_name, count(*)::int count from trader_settlements where company_id=$1
        union all select 'accounting_events', count(*)::int from accounting_events where company_id=$1
        union all select 'order_links', count(*)::int from trader_settlement_orders where order_id=$2
        union all select 'offsets', count(*)::int from trader_settlement_receivable_offsets where company_id=$1
        union all select 'cash_movements', count(*)::int from cash_bank_movements where company_id=$1
      `, [ids.companyId, ids.orderId]);
      const orderBefore = await pool.query("select trader_paid_amount, trader_settlement_status from orders where id=$1", [ids.orderId]);
      const results = await Promise.allSettled([
        callerA.traderSettlementService.confirmDraft(ids.draftId, `fixture-race-a-${randomUUID()}`),
        callerB.traderSettlementService.confirmDraft(ids.draftId, `fixture-race-b-${randomUUID()}`),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ errorCode: "trader_settlement_draft_already_confirmed" });
      const after = await pool.query<{ table_name: string; count: number }>(`
        select 'settlements' table_name, count(*)::int count from trader_settlements where company_id=$1
        union all select 'accounting_events', count(*)::int from accounting_events where company_id=$1
        union all select 'order_links', count(*)::int from trader_settlement_orders where order_id=$2
        union all select 'offsets', count(*)::int from trader_settlement_receivable_offsets where company_id=$1
        union all select 'cash_movements', count(*)::int from cash_bank_movements where company_id=$1
      `, [ids.companyId, ids.orderId]);
      const orderAfter = await pool.query("select trader_paid_amount, trader_settlement_status from orders where id=$1", [ids.orderId]);
      expect(Number(after.rows.find((row) => row.table_name === "settlements")?.count) - Number(before.rows.find((row) => row.table_name === "settlements")?.count)).toBe(1);
      expect(Number(after.rows.find((row) => row.table_name === "accounting_events")?.count) - Number(before.rows.find((row) => row.table_name === "accounting_events")?.count)).toBeGreaterThanOrEqual(1);
      expect(Number(after.rows.find((row) => row.table_name === "order_links")?.count) - Number(before.rows.find((row) => row.table_name === "order_links")?.count)).toBe(1);
      expect(Number(after.rows.find((row) => row.table_name === "offsets")?.count)).toBe(0);
      expect(Number(after.rows.find((row) => row.table_name === "cash_movements")?.count) - Number(before.rows.find((row) => row.table_name === "cash_movements")?.count)).toBe(1);
      expect(orderBefore.rows[0]?.trader_paid_amount).toBe("0.00");
      expect(orderAfter.rows[0]?.trader_paid_amount).toBe("25.00");
      expect(orderAfter.rows[0]?.trader_settlement_status).toBe("money_sent_to_trader");
      const posted = fulfilled.length === 1;
      (pool as Pool & { __fixturePosted?: boolean }).__fixturePosted = posted;
    } finally {
      await Promise.all([callerA.destroy(), callerB.destroy()]);
      await cleanupFixture(pool, ids, (pool as Pool & { __fixturePosted?: boolean }).__fixturePosted === true);
      await pool.end();
    }
  }, 120_000);
});

describe.skipIf(!run)("Trader Settlement different-draft balance concurrency", () => {
  it("allows only one of two drafts to consume the same AED 25 order balance", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const ids = await createCommittedFixture(pool);
    const secondDraftId = randomUUID();
    const callerA = createCaller(databaseUrl!, ids.companyId, ids.accountId);
    const callerB = createCaller(databaseUrl!, ids.companyId, ids.accountId);
    try {
      await pool.query(
        `insert into trader_settlement_drafts
          (id,company_id,trader_id,payload,created_by_account_id,updated_by_account_id)
         select $1,$2,trader_id,
                jsonb_build_object('traderId',trader_id,'amount',25,
                  'allocations',jsonb_build_array(jsonb_build_object('orderId',$3::uuid,'amount',25)),
                  'paymentMethod','cash'),
                created_by_account_id,updated_by_account_id
           from trader_settlement_drafts where id=$4`,
        [secondDraftId, ids.companyId, ids.orderId, ids.draftId],
      );
      const before = await pool.query<{ table_name: string; count: number }>(`
        select 'settlements' table_name, count(*)::int count from trader_settlements where company_id=$1
        union all select 'accounting_events', count(*)::int from accounting_events where company_id=$1
        union all select 'order_links', count(*)::int from trader_settlement_orders where order_id=$2
        union all select 'cash_movements', count(*)::int from cash_bank_movements where company_id=$1
        union all select 'collection_records', count(*)::int from order_events where company_id=$1 and event_type='driver_collection_confirmed'
      `, [ids.companyId, ids.orderId]);
      const orderBefore = await pool.query("select trader_paid_amount,trader_settlement_status from orders where id=$1", [ids.orderId]);
      const results = await Promise.allSettled([
        callerA.traderSettlementService.confirmDraft(ids.draftId, `fixture-different-a-${randomUUID()}`),
        callerB.traderSettlementService.confirmDraft(secondDraftId, `fixture-different-b-${randomUUID()}`),
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(["settlement_allocation_exceeds_outstanding", "settlement_order_ineligible"]).toContain(
        (rejected[0] as PromiseRejectedResult).reason?.errorCode,
      );
      const after = await pool.query<{ table_name: string; count: number }>(`
        select 'settlements' table_name, count(*)::int count from trader_settlements where company_id=$1
        union all select 'accounting_events', count(*)::int from accounting_events where company_id=$1
        union all select 'order_links', count(*)::int from trader_settlement_orders where order_id=$2
        union all select 'cash_movements', count(*)::int from cash_bank_movements where company_id=$1
        union all select 'collection_records', count(*)::int from order_events where company_id=$1 and event_type='driver_collection_confirmed'
      `, [ids.companyId, ids.orderId]);
      const orderAfter = await pool.query("select trader_paid_amount,trader_settlement_status from orders where id=$1", [ids.orderId]);
      const drafts = await pool.query("select id,confirmed_settlement_id from trader_settlement_drafts where id in ($1,$2) order by id", [ids.draftId, secondDraftId]);
      const delta = (name: string) => Number(after.rows.find((row) => row.table_name === name)?.count) - Number(before.rows.find((row) => row.table_name === name)?.count);
      expect(delta("settlements")).toBe(1);
      expect(delta("accounting_events")).toBeGreaterThanOrEqual(1);
      expect(delta("order_links")).toBe(1);
      expect(delta("cash_movements")).toBe(1);
      expect(delta("collection_records")).toBe(0);
      expect(orderBefore.rows[0]?.trader_paid_amount).toBe("0.00");
      expect(orderAfter.rows[0]?.trader_paid_amount).toBe("25.00");
      expect(orderAfter.rows[0]?.trader_settlement_status).toBe("money_sent_to_trader");
      expect(drafts.rows.filter((row) => row.confirmed_settlement_id !== null)).toHaveLength(1);
      expect(drafts.rows.filter((row) => row.confirmed_settlement_id === null)).toHaveLength(1);
    } finally {
      await pool.query("delete from trader_settlement_drafts where id=$1", [secondDraftId]);
      await Promise.all([callerA.destroy(), callerB.destroy()]);
      await cleanupFixture(pool, ids, true);
      await pool.end();
      console.warn(`Different-draft race retained immutable financial rows for marker ${ids.companyId}; secondDraft=${secondDraftId}`);
    }
  }, 120_000);
});

describe.skipIf(!run)("Trader Settlement stale saved balance", () => {
  it("rejects a saved second draft after the first draft consumes the order balance", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const ids = await createCommittedFixture(pool);
    const secondDraftId = randomUUID();
    const caller = createCaller(databaseUrl!, ids.companyId, ids.accountId);
    try {
      await pool.query(
        `insert into trader_settlement_drafts
          (id,company_id,trader_id,payload,created_by_account_id,updated_by_account_id)
         select $1,$2,trader_id,
                jsonb_build_object('traderId',trader_id,'amount',25,
                  'allocations',jsonb_build_array(jsonb_build_object('orderId',$3::uuid,'amount',25)),
                  'paymentMethod','cash'),
                created_by_account_id,updated_by_account_id
           from trader_settlement_drafts where id=$4`,
        [secondDraftId, ids.companyId, ids.orderId, ids.draftId],
      );
      await caller.traderSettlementService.confirmDraft(ids.draftId, `fixture-stale-first-${randomUUID()}`);
      const before = await pool.query<{ table_name: string; count: number }>(`
        select 'settlements' table_name, count(*)::int count from trader_settlements where company_id=$1
        union all select 'accounting_events', count(*)::int from accounting_events where company_id=$1
        union all select 'order_links', count(*)::int from trader_settlement_orders where order_id=$2
        union all select 'cash_movements', count(*)::int from cash_bank_movements where company_id=$1
      `, [ids.companyId, ids.orderId]);
      const orderBefore = await pool.query("select trader_paid_amount,trader_settlement_status from orders where id=$1", [ids.orderId]);
      await expect(caller.traderSettlementService.confirmDraft(secondDraftId, `fixture-stale-second-${randomUUID()}`)).rejects.toSatisfy((error: { errorCode?: string }) =>
        ["settlement_allocation_exceeds_outstanding", "settlement_order_ineligible"].includes(error.errorCode ?? ""),
      );
      const after = await pool.query<{ table_name: string; count: number }>(`
        select 'settlements' table_name, count(*)::int count from trader_settlements where company_id=$1
        union all select 'accounting_events', count(*)::int from accounting_events where company_id=$1
        union all select 'order_links', count(*)::int from trader_settlement_orders where order_id=$2
        union all select 'cash_movements', count(*)::int from cash_bank_movements where company_id=$1
      `, [ids.companyId, ids.orderId]);
      const orderAfter = await pool.query("select trader_paid_amount,trader_settlement_status from orders where id=$1", [ids.orderId]);
      const secondDraft = await pool.query("select confirmed_settlement_id from trader_settlement_drafts where id=$1", [secondDraftId]);
      const delta = (name: string) => Number(after.rows.find((row) => row.table_name === name)?.count) - Number(before.rows.find((row) => row.table_name === name)?.count);
      expect(delta("settlements")).toBe(0);
      expect(delta("accounting_events")).toBe(0);
      expect(delta("order_links")).toBe(0);
      expect(delta("cash_movements")).toBe(0);
      expect(orderBefore.rows[0]?.trader_paid_amount).toBe("25.00");
      expect(orderAfter.rows[0]?.trader_paid_amount).toBe("25.00");
      expect(orderAfter.rows[0]?.trader_settlement_status).toBe("money_sent_to_trader");
      expect(secondDraft.rows[0]?.confirmed_settlement_id).toBeNull();
    } finally {
      await pool.query("delete from trader_settlement_drafts where id=$1", [secondDraftId]);
      await caller.destroy();
      await cleanupFixture(pool, ids, true);
      await pool.end();
      console.warn(`Stale-balance test retained immutable financial rows for marker ${ids.companyId}; secondDraft=${secondDraftId}`);
    }
  }, 120_000);
});

describe.skipIf(!run)("Trader Settlement stale receivable offset", () => {
  it("rejects a saved second receivable offset after the first offset is posted", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const ids = await createCommittedFixture(pool);
    const receivableId = randomUUID();
    const secondDraftId = randomUUID();
    const caller = createCaller(databaseUrl!, ids.companyId, ids.accountId);
    try {
      await pool.query(
        `insert into trader_receivables
          (id,company_id,receivable_number,trader_id,source_type,source_reference,business_date,
           original_amount_due,amount_collected,status,reason,created_by_account_id)
         values ($1,$2,$3,$4,'service_charge',$5,current_date,25,0,'outstanding',$6,$7)`,
        [receivableId, ids.companyId, `RCV-FIX-${ids.companyId.slice(0, 8)}`, ids.traderId, `fixture-${ids.companyId}`, "Stage 2 offset fixture", ids.accountId],
      );
      const offsetPayload = JSON.stringify({
        traderId: ids.traderId,
        amount: 0.01,
        allocations: [{ orderId: ids.orderId, amount: 25 }],
        receivableOffsets: [{ receivableId, amount: 24.99 }],
        paymentMethod: "cash",
      });
      await pool.query("update trader_settlement_drafts set payload=$1::jsonb where id=$2", [offsetPayload, ids.draftId]);
      await pool.query(
        `insert into trader_settlement_drafts
          (id,company_id,trader_id,payload,created_by_account_id,updated_by_account_id)
         values ($1,$2,$3,$4::jsonb,$5,$5)`,
        [secondDraftId, ids.companyId, ids.traderId, offsetPayload, ids.accountId],
      );
      const before = await pool.query<{ table_name: string; count: number; amount?: string }>(`
        select 'settlements' table_name, count(*)::int count, null::text amount from trader_settlements where company_id=$1
        union all select 'offsets', count(*)::int, coalesce(sum(amount_allocated),0)::text from trader_settlement_receivable_offsets where receivable_id=$2
        union all select 'accounting_events', count(*)::int, null::text from accounting_events where company_id=$1
        union all select 'cash_movements', count(*)::int, null::text from cash_bank_movements where company_id=$1
        union all select 'physical_collections', count(*)::int, coalesce(sum(amount_received),0)::text from trader_collections where company_id=$1
      `, [ids.companyId, receivableId]);
      const receivableBefore = await pool.query("select amount_collected,status from trader_receivables where id=$1", [receivableId]);
      await caller.traderSettlementService.confirmDraft(ids.draftId, `fixture-receivable-first-${randomUUID()}`);
      const afterFirst = await pool.query("select amount_collected,status from trader_receivables where id=$1", [receivableId]);
      expect(afterFirst.rows[0]?.amount_collected).toBe("24.99");
      expect(afterFirst.rows[0]?.status).toBe("partially_collected");
      const firstOffset = await pool.query("select count(*)::int count, coalesce(sum(amount_allocated),0)::text amount from trader_settlement_receivable_offsets where receivable_id=$1", [receivableId]);
      expect(firstOffset.rows[0]?.count).toBe(1);
      expect(firstOffset.rows[0]?.amount).toBe("24.99");
      await expect(caller.traderSettlementService.confirmDraft(secondDraftId, `fixture-receivable-second-${randomUUID()}`)).rejects.toSatisfy((error: { errorCode?: string }) => error.errorCode === "settlement_offset_receivable_ineligible");
      const after = await pool.query<{ table_name: string; count: number; amount?: string }>(`
        select 'settlements' table_name, count(*)::int count, null::text amount from trader_settlements where company_id=$1
        union all select 'offsets', count(*)::int, coalesce(sum(amount_allocated),0)::text from trader_settlement_receivable_offsets where receivable_id=$2
        union all select 'accounting_events', count(*)::int, null::text from accounting_events where company_id=$1
        union all select 'cash_movements', count(*)::int, null::text from cash_bank_movements where company_id=$1
        union all select 'physical_collections', count(*)::int, coalesce(sum(amount_received),0)::text from trader_collections where company_id=$1
      `, [ids.companyId, receivableId]);
      const secondDraft = await pool.query("select confirmed_settlement_id from trader_settlement_drafts where id=$1", [secondDraftId]);
      const row = (name: string) => after.rows.find((item) => item.table_name === name)!;
      expect(Number(row("settlements").count) - Number(before.rows.find((item) => item.table_name === "settlements")?.count)).toBe(1);
      expect(Number(row("offsets").count)).toBe(1);
      expect(row("offsets").amount).toBe("24.99");
      expect(Number(row("accounting_events").count) - Number(before.rows.find((item) => item.table_name === "accounting_events")?.count)).toBeGreaterThanOrEqual(1);
      expect(Number(row("cash_movements").count) - Number(before.rows.find((item) => item.table_name === "cash_movements")?.count)).toBe(1);
      expect(Number(row("physical_collections").count) - Number(before.rows.find((item) => item.table_name === "physical_collections")?.count)).toBe(0);
      expect(row("physical_collections").amount).toBe(before.rows.find((item) => item.table_name === "physical_collections")?.amount ?? "0.00");
      expect(receivableBefore.rows[0]?.amount_collected).toBe("0.00");
      expect(secondDraft.rows[0]?.confirmed_settlement_id).toBeNull();
    } finally {
      await pool.query("delete from trader_settlement_drafts where id=$1", [secondDraftId]);
      await caller.destroy();
      await cleanupFixture(pool, ids, true);
      await pool.end();
      console.warn(`Receivable-offset test retained immutable financial rows for marker ${ids.companyId}; receivable=${receivableId}`);
    }
  }, 120_000);
});

describe.skipIf(!run)("Trader Settlement atomic rollback", () => {
  it("rolls back every posting effect after a deterministic late payment-write failure", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const ids = await createCommittedFixture(pool);
    const caller = createCaller(databaseUrl!, ids.companyId, ids.accountId);
    const functionName = `fixture_fail_after_payment_${ids.companyId.replaceAll("-", "")}`;
    const triggerName = `${functionName}_trigger`;
    try {
      await pool.query(`create function ${functionName}() returns trigger language plpgsql as $$ begin raise exception using message = 'fixture_late_posting_failure'; end; $$`);
      await pool.query(`create trigger ${triggerName} after insert on trader_settlement_payments for each row execute function ${functionName}()`);
      const before = await pool.query<{ table_name: string; count: number }>(`
        select 'settlements' table_name, count(*)::int count from trader_settlements where company_id=$1
        union all select 'accounting_events', count(*)::int from accounting_events where company_id=$1
        union all select 'order_links', count(*)::int from trader_settlement_orders where order_id=$2
        union all select 'offsets', count(*)::int from trader_settlement_receivable_offsets where company_id=$1
        union all select 'cash_movements', count(*)::int from cash_bank_movements where company_id=$1
        union all select 'collections', count(*)::int from trader_collections where company_id=$1
      `, [ids.companyId, ids.orderId]);
      const orderBefore = await pool.query("select trader_paid_amount,trader_settlement_status from orders where id=$1", [ids.orderId]);
      const draftBefore = await pool.query("select status,confirmed_settlement_id from trader_settlement_drafts where id=$1", [ids.draftId]);
      await expect(caller.traderSettlementService.confirmDraft(ids.draftId, `fixture-rollback-${randomUUID()}`)).rejects.toThrow("fixture_late_posting_failure");
      const after = await pool.query<{ table_name: string; count: number }>(`
        select 'settlements' table_name, count(*)::int count from trader_settlements where company_id=$1
        union all select 'accounting_events', count(*)::int from accounting_events where company_id=$1
        union all select 'order_links', count(*)::int from trader_settlement_orders where order_id=$2
        union all select 'offsets', count(*)::int from trader_settlement_receivable_offsets where company_id=$1
        union all select 'cash_movements', count(*)::int from cash_bank_movements where company_id=$1
        union all select 'collections', count(*)::int from trader_collections where company_id=$1
      `, [ids.companyId, ids.orderId]);
      const orderAfter = await pool.query("select trader_paid_amount,trader_settlement_status from orders where id=$1", [ids.orderId]);
      const draftAfter = await pool.query("select status,confirmed_settlement_id from trader_settlement_drafts where id=$1", [ids.draftId]);
      expect(after.rows).toEqual(before.rows);
      expect(orderAfter.rows).toEqual(orderBefore.rows);
      expect(draftAfter.rows).toEqual(draftBefore.rows);
    } finally {
      await pool.query(`drop trigger if exists ${triggerName} on trader_settlement_payments`);
      await pool.query(`drop function if exists ${functionName}()`);
      await caller.destroy();
      await cleanupFixture(pool, ids);
      await pool.end();
    }
  }, 120_000);
});

describe.skipIf(!run)("Trader Settlement committed fixture lifecycle", () => {
  it("commits a uniquely owned draft visible to two connections and cleans it after success and failure", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    try {
      const successIds = await withCommittedFixture(pool, async (ids) => {
        const [left, right] = await Promise.all([pool.connect(), pool.connect()]);
        try {
          const [draft, order] = await Promise.all([
            runSql(left, "select id,payload from trader_settlement_drafts where id=$1 and company_id=$2", [ids.draftId, ids.companyId]),
            runSql(right, "select id,trader_paid_amount,trader_settlement_status from orders where id=$1 and company_id=$2", [ids.orderId, ids.companyId]),
          ]);
          expect(draft.rowCount).toBe(1);
          expect(order.rowCount).toBe(1);
          expect((draft.rows[0] as { payload: { allocations: Array<{ orderId: string }> } }).payload.allocations[0]!.orderId).toBe(ids.orderId);
          expect((order.rows[0] as { trader_paid_amount: string }).trader_paid_amount).toBe("0.00");
        } finally { left.release(); right.release(); }
        return ids;
      });
      await expect(pool.query("select 1 from trader_settlement_drafts where id=$1", [successIds.draftId])).resolves.toMatchObject({ rows: [] });
      await expect(pool.query("select 1 from orders where id=$1", [successIds.orderId])).resolves.toMatchObject({ rows: [] });
      let failedIds: FixtureIds | undefined;
      await expect(withCommittedFixture(pool, async (ids) => {
        failedIds = ids;
        throw new Error("intentional fixture callback failure");
      })).rejects.toThrow("intentional fixture callback failure");
      expect(failedIds).toBeDefined();
      await expect(pool.query("select 1 from trader_settlement_drafts where id=$1", [failedIds!.draftId])).resolves.toMatchObject({ rows: [] });
      await expect(pool.query("select 1 from orders where id=$1", [failedIds!.orderId])).resolves.toMatchObject({ rows: [] });
    } finally {
      await pool.end();
    }
  });
});

describe.skipIf(!run)("Trader Settlement production funding enforcement", () => {
  it("rejects a cash confirmation that exceeds the real available balance without posting", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const ids = await createCommittedFixture(pool);
    const caller = createCaller(databaseUrl!, ids.companyId, ids.accountId, { useProductionBalanceEnforcement: true });
    try {
      await pool.query(`insert into company_balance_policies
        (id,company_id,cash_policy,bank_policy,bank_overdraft_limit,effective_from,change_reason,created_by_account_id)
        values($1,$2,'block','allow_within_overdraft',0,'-infinity'::date,'Stage 2 insufficient-funds fixture',$3)`, [randomUUID(), ids.companyId, ids.accountId]);
      const before = await pool.query<{ settlements: number; payments: number; events: number; movements: number; links: number }>(`
        select
          (select count(*)::int from trader_settlements where company_id=$1) settlements,
          (select count(*)::int from trader_settlement_payments where company_id=$1) payments,
          (select count(*)::int from accounting_events where company_id=$1) events,
          (select count(*)::int from cash_bank_movements where company_id=$1) movements,
          (select count(*)::int from trader_settlement_orders where order_id=$2) links`, [ids.companyId, ids.orderId]);
      const balance = await pool.query<{ balance: string }>(`select coalesce(sum(jl.debit-jl.credit),0)::text balance
        from journal_lines jl join chart_of_accounts coa on coa.id=jl.account_id
        where coa.id=$1`, [ids.chartAccountId]);
      expect(balance.rows[0]?.balance).toBe("0");
      await expect(caller.traderSettlementService.confirmDraft(ids.draftId, `fixture-insufficient-${randomUUID()}`)).rejects.toMatchObject({ errorCode: "balance_would_go_negative" });
      const after = await pool.query<{ settlements: number; payments: number; events: number; movements: number; links: number }>(`
        select
          (select count(*)::int from trader_settlements where company_id=$1) settlements,
          (select count(*)::int from trader_settlement_payments where company_id=$1) payments,
          (select count(*)::int from accounting_events where company_id=$1) events,
          (select count(*)::int from cash_bank_movements where company_id=$1) movements,
          (select count(*)::int from trader_settlement_orders where order_id=$2) links`, [ids.companyId, ids.orderId]);
      expect(after.rows[0]).toEqual(before.rows[0]);
      await expect(pool.query("select status,confirmed_settlement_id from trader_settlement_drafts where id=$1", [ids.draftId])).resolves.toMatchObject({ rows: [{ status: "draft", confirmed_settlement_id: null }] });
      await expect(pool.query("select trader_paid_amount,trader_settlement_status from orders where id=$1", [ids.orderId])).resolves.toMatchObject({ rows: [{ trader_paid_amount: "0.00", trader_settlement_status: "unsettled" }] });
    } finally {
      await caller.destroy(); await cleanupFixture(pool, ids); await pool.end();
    }
  }, 120_000);
});

describe.skipIf(!run)("Trader Settlement order-type eligibility", () => {
  it("confirms an eligible Domestic order and posts exactly one settlement", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const ids = await createCommittedFixture(pool);
    const caller = createCaller(databaseUrl!, ids.companyId, ids.accountId);
    try {
      const before = await pool.query<{ table_name: string; count: number }>(`
        select 'settlements' table_name, count(*)::int count from trader_settlements where company_id=$1
        union all select 'accounting_events', count(*)::int from accounting_events where company_id=$1
        union all select 'order_links', count(*)::int from trader_settlement_orders where order_id=$2
        union all select 'cash_movements', count(*)::int from cash_bank_movements where company_id=$1`, [ids.companyId, ids.orderId]);
      const result = await caller.traderSettlementService.confirmDraft(ids.draftId, `fixture-domestic-${randomUUID()}`);
      const after = await pool.query<{ table_name: string; count: number }>(`
        select 'settlements' table_name, count(*)::int count from trader_settlements where company_id=$1
        union all select 'accounting_events', count(*)::int from accounting_events where company_id=$1
        union all select 'order_links', count(*)::int from trader_settlement_orders where order_id=$2
        union all select 'cash_movements', count(*)::int from cash_bank_movements where company_id=$1`, [ids.companyId, ids.orderId]);
      expect(result.settlementId).toBeTruthy();
      const delta = (name: string) => Number(after.rows.find((row) => row.table_name === name)?.count) - Number(before.rows.find((row) => row.table_name === name)?.count);
      expect(delta("settlements")).toBe(1); expect(delta("accounting_events")).toBeGreaterThanOrEqual(1);
      expect(delta("order_links")).toBe(1); expect(delta("cash_movements")).toBe(1);
      await expect(pool.query("select trader_paid_amount,trader_settlement_status from orders where id=$1", [ids.orderId])).resolves.toMatchObject({ rows: [{ trader_paid_amount: "25.00", trader_settlement_status: "money_sent_to_trader" }] });
    } finally {
      await caller.destroy(); await cleanupFixture(pool, ids, true); await pool.end();
    }
  }, 120_000);

  it("confirms an eligible delivered International order without Driver Collection activity", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 }); const ids = await createCommittedFixture(pool); const intl = await insertInternationalOrder(pool, ids, true); const draftId = randomUUID(); const caller = createCaller(databaseUrl!, ids.companyId, ids.accountId);
    try {
      await pool.query("insert into trader_settlement_drafts (id,company_id,trader_id,payload,created_by_account_id,updated_by_account_id) values($1,$2,$3,$4::jsonb,$5,$5)", [draftId, ids.companyId, ids.traderId, JSON.stringify({ traderId: ids.traderId, amount: 25, allocations: [{ orderId: intl.orderId, amount: 25 }], paymentMethod: "cash" }), ids.accountId]);
      const before = await pool.query("select count(*)::int as settlements from trader_settlements where company_id=$1", [ids.companyId]); const beforeEvents = await pool.query("select count(*)::int as n from order_events where order_id=$1 and event_type='driver_collection_confirmed'", [intl.orderId]);
      const result = await caller.traderSettlementService.confirmDraft(draftId, `fixture-international-${randomUUID()}`); expect(result.settlementId).toBeTruthy();
      const after = await pool.query("select count(*)::int as settlements from trader_settlements where company_id=$1", [ids.companyId]); const afterEvents = await pool.query("select count(*)::int as n from order_events where order_id=$1 and event_type='driver_collection_confirmed'", [intl.orderId]);
      expect(after.rows[0].settlements - before.rows[0].settlements).toBe(1); expect(afterEvents.rows[0].n).toBe(beforeEvents.rows[0].n);
      await expect(pool.query("select assigned_driver_id,trader_paid_amount,trader_settlement_status from orders where id=$1", [intl.orderId])).resolves.toMatchObject({ rows: [{ assigned_driver_id: null, trader_paid_amount: "25.00", trader_settlement_status: "money_sent_to_trader" }] });
    } finally { await pool.query("delete from trader_settlement_drafts where id=$1", [draftId]); await caller.destroy(); console.warn(`International immutable fixture retained: company=${ids.companyId} order=${intl.orderId}`); await cleanupFixture(pool, ids, true); await pool.end(); }
  }, 120_000);

  it("rejects an International order before carrier-confirmed delivery without financial effects", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 4 }); const ids = await createCommittedFixture(pool); const intl = await insertInternationalOrder(pool, ids, false); const draftId = randomUUID(); const caller = createCaller(databaseUrl!, ids.companyId, ids.accountId);
    try {
      await pool.query("insert into trader_settlement_drafts (id,company_id,trader_id,payload,created_by_account_id,updated_by_account_id) values($1,$2,$3,$4::jsonb,$5,$5)", [draftId, ids.companyId, ids.traderId, JSON.stringify({ traderId: ids.traderId, amount: 25, allocations: [{ orderId: intl.orderId, amount: 25 }], paymentMethod: "cash" }), ids.accountId]);
      const before = await pool.query("select count(*)::int as settlements from trader_settlements where company_id=$1", [ids.companyId]);
      await expect(caller.traderSettlementService.confirmDraft(draftId, `fixture-international-ineligible-${randomUUID()}`)).rejects.toSatisfy((error: { errorCode?: string }) => ["settlement_order_ineligible", "settlement_allocation_empty"].includes(error.errorCode ?? ""));
      const after = await pool.query("select count(*)::int as settlements from trader_settlements where company_id=$1", [ids.companyId]); expect(after.rows[0].settlements).toBe(before.rows[0].settlements);
      await expect(pool.query("select status,confirmed_settlement_id from trader_settlement_drafts where id=$1", [draftId])).resolves.toMatchObject({ rows: [{ status: "draft", confirmed_settlement_id: null }] });
    } finally { await pool.query("delete from trader_settlement_drafts where id=$1", [draftId]); await caller.destroy(); await pool.query("delete from orders where id=$1", [intl.orderId]); await pool.query("delete from destination_countries where id=$1", [intl.countryId]); await pool.query("delete from third_party_delivery_companies where id=$1", [intl.carrierId]); await cleanupFixture(pool, ids); await pool.end(); }
  }, 120_000);

});
