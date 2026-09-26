import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * An Outsourced Driver earning from a closed Collect Order -- the missing
 * counterpart to `capture_employee_collect_order_earning`, which already
 * pays an Employee Driver on the identical transition. Reuses
 * `outsourced_driver_collection_earning_rules` for the rate, the same
 * design choice the Employee side already makes (one "collection earning"
 * rate covers both a confirmed cash reconciliation and a closed Collect
 * Order).
 *
 * Every case runs inside one transaction that is rolled back.
 */

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

interface Fixture {
  readonly actorId: string;
  readonly areaId: string;
  readonly companyId: string;
  readonly outsourcedDriverId: string;
  readonly traderId: string;
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
  const marker = new Error("rollback outsourced collect order earning test");
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

async function seed(transaction: Transaction<DatabaseSchema>, label: string): Promise<Fixture> {
  const companyId = randomUUID();
  const actorId = randomUUID();
  const outsourcedDriverId = randomUUID();
  const short = companyId.slice(0, 8);
  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${companyId}::uuid,${`${label}-${short}`},${`${label.toLowerCase()}-${short}`},
      'Outsourced Collect Order Test','active',now())`.execute(transaction);
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${actorId}::uuid,${companyId}::uuid,'company_user',${`ocoe.${actorId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into drivers(id,company_id,code,name_en,mobile_number,driver_type,outsourced_fee_per_delivered_order)
    values(${outsourcedDriverId}::uuid,${companyId}::uuid,${`OUT-${short}`},'Contractor',
      '971500000002','outsourced',5)`.execute(transaction);
  const emirate = await sql<{ id: string }>`select id from emirates limit 1`.execute(transaction);
  const areaId = randomUUID();
  await sql`insert into areas(id,company_id,code,name_en,name_ar,emirate_id)
    values(${areaId}::uuid,${companyId}::uuid,${`A-${short}`},'Area','منطقة',
      ${emirate.rows[0]!.id}::uuid)`.execute(transaction);
  const traderId = randomUUID();
  await sql`insert into traders(id,company_id,code,name_en,mobile_number,pickup_area_id,
      created_by_account_id)
    values(${traderId}::uuid,${companyId}::uuid,${`TRD-${short}`},'Trader','971500000003',
      ${areaId}::uuid,${actorId}::uuid)`.execute(transaction);
  await sql`insert into company_settings(company_id,timezone)
    values(${companyId}::uuid,'Asia/Dubai')`.execute(transaction);
  return { actorId, areaId, companyId, outsourcedDriverId, traderId };
}

async function createCollectOrder(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  orderNumber: string,
  driverId: string,
): Promise<string> {
  const id = randomUUID();
  await sql`insert into orders(id,company_id,order_number,order_date,trader_id,area_id,
    created_by_account_id,customer_name,customer_mobile_number,customer_address,package_count,
    payment_condition,final_service_fee_snapshot,assigned_driver_id,customer_provenance_status,
    pricing_provenance_status,service_fee_override_reason,order_type,delivery_status,
    driver_reconciliation_status,trader_settlement_status)
    values(${id}::uuid,${fixture.companyId}::uuid,${orderNumber},'2026-08-10',${fixture.traderId}::uuid,
    ${fixture.areaId}::uuid,${fixture.actorId}::uuid,'Pickup Customer','971500000009','Pickup',1,
    'customer_pays_cod_and_fee',0,${driverId}::uuid,'legacy_unattributed','legacy_unattributed','Collect Order',
    'collect_order','collect_order','not_applicable','not_eligible')`.execute(transaction);
  return id;
}

const addRule = (
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  driverId: string,
  type: string,
  amount: number,
  from: string,
) =>
  sql`insert into outsourced_driver_collection_earning_rules(
    company_id,driver_id,collection_payment_type,amount,effective_from,created_by_account_id
  ) values(${fixture.companyId}::uuid,${driverId}::uuid,${type},${amount},${from}::date,
    ${fixture.actorId}::uuid)`.execute(transaction);

describe.skipIf(!runDatabaseTests)("outsourced driver collect order earnings", () => {
  it("accrues a fee when an Outsourced Driver's Collect Order closes, given an active rule", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "OCOA");
      await addRule(transaction, fixture, fixture.outsourcedDriverId, "per_collected_order", 15, "2026-08-01");
      const orderId = await createCollectOrder(transaction, fixture, "COLLECT-1", fixture.outsourcedDriverId);

      await sql`update orders set delivery_status='closed',closed_at='2026-08-10T09:00:00+04:00'
        where id=${orderId}::uuid`.execute(transaction);

      const accrual = await sql<{
        accrualSource: string;
        earnedAmount: string;
        earningType: string;
        feeRateSnapshot: string;
        status: string;
        unitCount: number;
      }>`select accrual_source as "accrualSource", earned_amount::text as "earnedAmount",
          earning_type as "earningType", fee_rate_snapshot::text as "feeRateSnapshot",
          status, unit_count as "unitCount"
        from outsourced_driver_fee_accruals
        where company_id=${fixture.companyId}::uuid and order_id=${orderId}::uuid`.execute(transaction);

      expect(accrual.rows).toEqual([
        {
          accrualSource: "collect_order",
          earnedAmount: "15.00",
          earningType: "collect_order",
          feeRateSnapshot: "15.00",
          status: "accrued",
          unitCount: 1,
        },
      ]);
    });
  });

  it("accrues nothing when no active collection rule is configured for the Driver", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "OCOB");
      const orderId = await createCollectOrder(transaction, fixture, "COLLECT-2", fixture.outsourcedDriverId);

      await sql`update orders set delivery_status='closed',closed_at='2026-08-10T09:00:00+04:00'
        where id=${orderId}::uuid`.execute(transaction);

      const accrual = await sql<{ n: string }>`select count(*)::text as n from outsourced_driver_fee_accruals
        where company_id=${fixture.companyId}::uuid and order_id=${orderId}::uuid`.execute(transaction);
      expect(accrual.rows[0]!.n).toBe("0");
    });
  });

  it("accrues nothing for an Employee Driver's Collect Order (that path already exists separately)", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "OCOC");
      const employeeId = randomUUID();
      const employeeDriverId = randomUUID();
      await sql`insert into employees(id,company_id,name_en) values(${employeeId}::uuid,${fixture.companyId}::uuid,'Ahmad')`.execute(
        transaction,
      );
      await sql`insert into drivers(id,company_id,code,name_en,mobile_number,driver_type,employee_id)
        values(${employeeDriverId}::uuid,${fixture.companyId}::uuid,'DRV-E','Ahmad','971500000001',
          'employee',${employeeId}::uuid)`.execute(transaction);
      const orderId = await createCollectOrder(transaction, fixture, "COLLECT-3", employeeDriverId);

      await sql`update orders set delivery_status='closed',closed_at='2026-08-10T09:00:00+04:00'
        where id=${orderId}::uuid`.execute(transaction);

      const accrual = await sql<{ n: string }>`select count(*)::text as n from outsourced_driver_fee_accruals
        where company_id=${fixture.companyId}::uuid and order_id=${orderId}::uuid`.execute(transaction);
      expect(accrual.rows[0]!.n).toBe("0");
    });
  });

  it("never double-accrues the same Collect Order (idempotent on conflict)", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "OCOD");
      await addRule(transaction, fixture, fixture.outsourcedDriverId, "per_collected_order", 15, "2026-08-01");
      const orderId = await createCollectOrder(transaction, fixture, "COLLECT-4", fixture.outsourcedDriverId);

      await sql`update orders set delivery_status='closed',closed_at='2026-08-10T09:00:00+04:00'
        where id=${orderId}::uuid`.execute(transaction);
      // A benign re-fire of the same transition (e.g. an unrelated column
      // touched by the same UPDATE OF delivery_status trigger) must not
      // create a second accrual for the same Order.
      await sql`update orders set delivery_status='closed',updated_at=now()
        where id=${orderId}::uuid`.execute(transaction);

      const accrual = await sql<{ n: string }>`select count(*)::text as n from outsourced_driver_fee_accruals
        where company_id=${fixture.companyId}::uuid and order_id=${orderId}::uuid`.execute(transaction);
      expect(accrual.rows[0]!.n).toBe("1");
    });
  });
});
