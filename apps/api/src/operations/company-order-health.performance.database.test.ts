import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { CompanyOrderHealthService } from "./company-order-health.service.js";

/**
 * Part U -- Company Order Health performance certification at 150,000 Orders.
 *
 * Opt-in and destructive-free: runs only with RUN_ORDER_HEALTH_PERFORMANCE=true
 * against a DISPOSABLE database whose name contains "perf". The fixture (one
 * Company, 150,000 Orders over 400 days) is created once, with triggers
 * bypassed, and reused by later runs. Final states are inserted directly:
 *   - 75,000 Orders owe the AED 18 fee; 74,000 Receivables (1,000 MISSING);
 *   - 20,000 physically collected (200 Collections x 100);
 *   - 20,000 offset-settled (400 Settlements x 50), of which 5,000 are
 *     SET-A -> reversal -> SET-B;
 *   - 500 Receivables reversed with no replacement.
 */

const url = process.env.ORDER_HEALTH_PERF_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const runPerformance =
  process.env.RUN_ORDER_HEALTH_PERFORMANCE === "true" && /\/[^/]*perf[^/]*$/u.test(url);

const COMPANY = "0d0d0d0d-0000-4000-8000-000000150000";
const ACTOR = "0d0d0d0d-0000-4000-8000-0000000000a1";
const AREA = "0d0d0d0d-0000-4000-8000-0000000000a2";
const TRADER = "0d0d0d0d-0000-4000-8000-0000000000a3";

async function seed(db: Kysely<DatabaseSchema>) {
  const exists = await sql<{ n: number }>`select count(*)::int as n from orders
    where company_id = ${COMPANY}::uuid`.execute(db);
  if (exists.rows[0]!.n === 150_000) return;
  await db.transaction().execute(async (tx) => {
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${COMPANY}::uuid,'PERF-150K','perf-150k','Perf 150k','active',now())`.execute(tx);
    await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status)
      values (${ACTOR}::uuid,${COMPANY}::uuid,'company_user','perf.actor','x','disabled')`.execute(tx);
    await sql`insert into areas(id,company_id,code,name_en,name_ar,emirate_id)
      select ${AREA}::uuid,${COMPANY}::uuid,'PERF-A','Area','منطقة',(select id from emirates limit 1)`.execute(tx);
    await sql`insert into traders(id,company_id,code,name_en,mobile_number,pickup_area_id,created_by_account_id)
      values (${TRADER}::uuid,${COMPANY}::uuid,'PERF-T','Trader','971500000003',${AREA}::uuid,${ACTOR}::uuid)`.execute(tx);
  });
  await db.transaction().execute(async (tx) => {
    await sql`set local session_replication_role = replica`.execute(tx);
    await sql`insert into orders(id,company_id,order_number,order_date,trader_id,area_id,created_by_account_id,
        customer_name,customer_mobile_number,customer_address,package_count,payment_condition,cod_amount,
        service_fee,final_service_fee_snapshot,customer_provenance_status,pricing_provenance_status,
        customer_amount_due,trader_gross_payable,trader_paid_service_fee,trader_net_payable,trader_paid_amount,
        delivery_status,driver_reconciliation_status,trader_settlement_status,return_status,delivered_at)
      select gen_random_uuid(), ${COMPANY}::uuid, 'PERF-'||lpad(g::text,7,'0'), current_date - (g % 400),
             ${TRADER}::uuid, ${AREA}::uuid, ${ACTOR}::uuid, 'C','971500000001','A',1,
             case when g % 2 = 0 then 'customer_pays_cod_trader_pays_fee' else 'customer_pays_cod_and_fee' end,
             case when g % 2 = 0 then 0 else 100 end, 18, 18,'legacy_unattributed','legacy_unattributed',
             0,0,18,0,0,'delivered','not_applicable','not_eligible','not_applicable',now()
        from generate_series(1,150000) g`.execute(tx);
    // Receivable k (1..74000) belongs to Order 2k. States are final on insert:
    // 1..20000 collected physically, 20001..40000 offset-settled,
    // 60001..60500 reversed, the rest outstanding.
    await sql`insert into trader_receivables(id,company_id,receivable_number,trader_id,source_type,
        source_reference,original_amount_due,amount_collected,status,reason,created_by_account_id,business_date)
      select ('0d0d0d0d-0000-4000-8003-'||lpad(k::text,12,'0'))::uuid, ${COMPANY}::uuid,
             'RCV-P'||lpad(k::text,7,'0'), ${TRADER}::uuid, 'service_charge',
             'PERF-'||lpad((2*k)::text,7,'0'), 18,
             case when k <= 40000 then 18 else 0 end,
             case when k <= 40000 then 'collected' when k between 60001 and 60500 then 'reversed'
                  else 'outstanding' end,
             'Fee', ${ACTOR}::uuid, current_date
        from generate_series(1,74000) k`.execute(tx);
    await sql`insert into trader_collections(id,company_id,collection_number,trader_id,payment_date,
        payment_method,amount_received,status,received_by_account_id,confirmed_at)
      select ('0d0d0d0d-0000-4000-8001-'||lpad(c::text,12,'0'))::uuid, ${COMPANY}::uuid,'TC-P'||c,
             ${TRADER}::uuid, current_date,'cash',1800,'confirmed',${ACTOR}::uuid,now()
        from generate_series(1,200) c`.execute(tx);
    await sql`insert into trader_collection_allocations(company_id,collection_id,receivable_id,amount_allocated)
      select ${COMPANY}::uuid, ('0d0d0d0d-0000-4000-8001-'||lpad((((k-1)/100)+1)::text,12,'0'))::uuid,
             ('0d0d0d0d-0000-4000-8003-'||lpad(k::text,12,'0'))::uuid, 18
        from generate_series(1,20000) k`.execute(tx);
    await sql`insert into trader_settlements(id,company_id,settlement_number,trader_id,business_date,
        gross_payable,other_deductions,net_payable,status,created_by_account_id,confirmed_by_account_id,confirmed_at)
      select ('0d0d0d0d-0000-4000-8002-'||lpad(s::text,12,'0'))::uuid, ${COMPANY}::uuid,'SET-P'||s,
             ${TRADER}::uuid, current_date,900,900,0,'confirmed',${ACTOR}::uuid,${ACTOR}::uuid,now()
        from generate_series(1,500) s`.execute(tx);
    await sql`insert into trader_settlements(id,company_id,settlement_number,trader_id,business_date,
        gross_payable,net_payable,status,created_by_account_id,confirmed_by_account_id,confirmed_at,reversal_of_id)
      select gen_random_uuid(), ${COMPANY}::uuid,'SET-PR'||s, ${TRADER}::uuid, current_date,0,0,'confirmed',
             ${ACTOR}::uuid,${ACTOR}::uuid,now(),('0d0d0d0d-0000-4000-8002-'||lpad(s::text,12,'0'))::uuid
        from generate_series(1,100) s`.execute(tx);
    await sql`insert into trader_settlement_receivable_offsets(company_id,settlement_id,receivable_id,amount_allocated)
      select ${COMPANY}::uuid, ('0d0d0d0d-0000-4000-8002-'||lpad((((k-20001)/50)+1)::text,12,'0'))::uuid,
             ('0d0d0d0d-0000-4000-8003-'||lpad(k::text,12,'0'))::uuid, 18
        from generate_series(20001,40000) k`.execute(tx);
    // SET-B (settlements 401..500) re-settles the 5,000 Receivables of the reversed SET-A 1..100.
    await sql`insert into trader_settlement_receivable_offsets(company_id,settlement_id,receivable_id,amount_allocated)
      select ${COMPANY}::uuid, ('0d0d0d0d-0000-4000-8002-'||lpad((((k-20001)/50)+401)::text,12,'0'))::uuid,
             ('0d0d0d0d-0000-4000-8003-'||lpad(k::text,12,'0'))::uuid, 18
        from generate_series(20001,25000) k`.execute(tx);
  });
  await sql`analyze`.execute(db);
}

describe.skipIf(!runPerformance)("Company Order Health -- 150,000-order performance (Part U)", () => {
  let pool: Pool;
  let db: Kysely<DatabaseSchema>;
  let statements = 0;
  let service: CompanyOrderHealthService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 });
    db = new Kysely<DatabaseSchema>({
      dialect: new PostgresDialect({ pool }),
      log: (event) => {
        if (event.level === "query") statements += 1;
      },
    });
    await seed(db);
    service = new CompanyOrderHealthService(db);
  }, 1_800_000);

  afterAll(async () => {
    await db?.destroy();
  });

  async function timed<T>(work: () => Promise<T>) {
    await work(); // warm
    statements = 0;
    const started = performance.now();
    const result = await work();
    return { ms: performance.now() - started, result, statements };
  }

  it("evaluates 150,000 Orders with exact counts in a fixed number of statements", async () => {
    const all = await timed(() => service.summary(COMPANY, { scope: "all" }));
    expect(all.statements).toBe(6);
    expect(all.result).toMatchObject({
      healthyOrders: 148_500,
      issueOrders: 1_500,
      reviewOrders: 0,
      totalOrders: 150_000,
    });
    const byReason = Object.fromEntries(all.result.byReason.map((row) => [row.reasonCode, row.orders]));
    expect(byReason).toMatchObject({
      ALREADY_PHYSICALLY_COLLECTED: 20_000,
      MISSING_RECEIVABLE: 1_000,
      OFFSET_SETTLED_WITHOUT_PHYSICAL_COLLECTION: 20_000,
      REVERSED_NEEDS_REPAIR: 500,
    });
    const last30 = await timed(() => service.summary(COMPANY, {}));
    const page = await timed(() => service.list(COMPANY, { scope: "all" }));
    const deep = await timed(() =>
      service.list(COMPANY, { health: "healthy", page: 300, pageSize: 100, scope: "all" }),
    );
    expect(page.result.total).toBe(1_500);
    expect(deep.result.items).toHaveLength(100);
    for (const run of [last30, page, deep]) expect(run.statements).toBe(6);
    // Generous ceilings for a 2-vCPU container; measured ~0.2 s / ~0.8 s / ~1.4 s.
    expect(last30.ms).toBeLessThan(3_000);
    expect(all.ms).toBeLessThan(10_000);
    expect(deep.ms).toBeLessThan(15_000);
    process.stdout.write(
      `${JSON.stringify({
        fixtureOrders: all.result.totalOrders,
        ms: {
          listAttentionAll: Math.round(page.ms),
          listHealthyPage300: Math.round(deep.ms),
          summaryAll: Math.round(all.ms),
          summaryLast30: Math.round(last30.ms),
        },
        statementsPerRequest: all.statements,
      })}\n`,
    );
  }, 600_000);
});
