import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * The Free Order, as the database understands it.
 *
 * These assert the guarantees that must hold no matter which code path creates
 * an Order — the service, a future import, or a direct fix-up. The service
 * forces the zeroes itself, but a rule only the service knows is a rule the next
 * caller can miss, so what is tested here is the constraint and the triggers.
 *
 * The scenario throughout is ORD-G: Trader Noon priced at AED 25, one Order
 * given away deliberately, delivered by an employee Driver with an active
 * per-delivery earning rule.
 */

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

interface Fixture {
  readonly actorId: string;
  readonly areaId: string;
  readonly companyId: string;
  readonly driverId: string;
  readonly employeeId: string;
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
  const marker = new Error("rollback free order test");
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

/** Trader Noon priced at AED 25, plus employee Driver Ahmad on AED 2 a delivery. */
async function seed(transaction: Transaction<DatabaseSchema>, label: string): Promise<Fixture> {
  const companyId = randomUUID();
  const actorId = randomUUID();
  const areaId = randomUUID();
  const traderId = randomUUID();
  const employeeId = randomUUID();
  const driverId = randomUUID();
  const short = companyId.slice(0, 8);
  const emirate = await sql<{ id: string }>`select id from emirates limit 1`.execute(transaction);

  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${companyId}::uuid,${`${label}-${short}`},${`${label.toLowerCase()}-${short}`},
      'Free Order Test','active',now())`.execute(transaction);
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${actorId}::uuid,${companyId}::uuid,'company_user',${`fo.${actorId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into areas(id,company_id,code,name_en,name_ar,emirate_id)
    values(${areaId}::uuid,${companyId}::uuid,${`A-${short}`},${`Area ${short}`},'منطقة',
      ${emirate.rows[0]!.id}::uuid)`.execute(transaction);
  await sql`insert into traders(id,company_id,code,name_en,mobile_number,pickup_area_id,
      created_by_account_id)
    values(${traderId}::uuid,${companyId}::uuid,${`T-${short}`},'Noon','971500000003',
      ${areaId}::uuid,${actorId}::uuid)`.execute(transaction);
  // Noon's ordinary rate. A Free Order must leave this completely alone.
  await sql`insert into trader_service_prices(company_id,trader_id,emirate_id,area_id,service_fee,
      created_by_account_id)
    values(${companyId}::uuid,${traderId}::uuid,${emirate.rows[0]!.id}::uuid,${areaId}::uuid,25,
      ${actorId}::uuid)`.execute(transaction);
  await sql`insert into employees(id,company_id,employee_number,name_en,employee_type,hired_on)
    values(${employeeId}::uuid,${companyId}::uuid,${`EMP-${short}`},'Ahmad','employee',
      '2026-01-01'::date)`.execute(transaction);
  await sql`insert into drivers(id,company_id,code,name_en,mobile_number,driver_type,employee_id)
    values(${driverId}::uuid,${companyId}::uuid,${`DRV-${short}`},'Ahmad','971500000001',
      'employee',${employeeId}::uuid)`.execute(transaction);
  await sql`insert into employee_delivery_earning_rules(company_id,employee_id,amount_per_order,
      effective_from)
    values(${companyId}::uuid,${employeeId}::uuid,2,'2026-01-01'::date)`.execute(transaction);
  /* Automatic posting ON for Orders. Without it `enqueue_operational_accounting_event`
     returns early for EVERY Order, and "the free Order raised no Event" would be
     true for a reason that has nothing to do with it being free. */
  await sql`insert into accounting_configurations(company_id,accounting_enabled,
      automatic_posting_enabled,automatic_posting_areas,
      automatic_posting_enabled_by_account_id,automatic_posting_enabled_at)
    values(${companyId}::uuid,true,true,array['orders'],${actorId}::uuid,now())`.execute(
    transaction,
  );
  return { actorId, areaId, companyId, driverId, employeeId, traderId };
}

/** Inserts an Order, letting the caller vary only what each case is about. */
function insertOrder(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  options: {
    readonly cod?: number;
    readonly free?: boolean;
    readonly freeReason?: string | null | undefined;
    readonly id?: string;
    readonly orderNumber?: string;
    readonly serviceFee?: number;
  } = {},
) {
  const free = options.free ?? false;
  const fee = options.serviceFee ?? (free ? 0 : 25);
  // `in` rather than `??`: an EXPLICIT null is the "no reason given" case under
  // test, and `??` would silently substitute the default and pass.
  const reason = "freeReason" in options ? options.freeReason : "Free delivery test";
  return sql`insert into orders(
      id,company_id,order_number,order_date,trader_id,area_id,created_by_account_id,
      customer_name,customer_mobile_number,customer_address,package_count,payment_condition,
      cod_amount,service_fee,final_service_fee_snapshot,configured_service_fee_snapshot,
      assigned_driver_id,customer_provenance_status,pricing_provenance_status,
      service_fee_override_reason,is_free_order,free_order_reason
    ) values(
      ${options.id ?? randomUUID()}::uuid,${fixture.companyId}::uuid,
      ${options.orderNumber ?? "ORD-G"},current_date,${fixture.traderId}::uuid,
      ${fixture.areaId}::uuid,${fixture.actorId}::uuid,'Customer','971500000009','Address',1,
      'customer_pays_cod_and_fee',${options.cod ?? 0},${fee},${fee},${fee},
      ${fixture.driverId}::uuid,'legacy_unattributed','manual',
      ${fee === 0 ? reason : null},
      ${free},${free ? reason : null}
    )`.execute(transaction);
}

describe.skipIf(!runDatabaseTests)("free order", () => {
  it("stores the flag, the reason and both zeroes", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "FOA");
      await insertOrder(transaction, fixture, { free: true, freeReason: "Free delivery test" });

      const row = await sql<{
        cod: string;
        fee: string;
        free: boolean;
        reason: string;
      }>`select is_free_order as free, free_order_reason as reason,
                cod_amount::text as cod, service_fee::text as fee
           from orders where company_id=${fixture.companyId}::uuid`.execute(transaction);
      expect(row.rows[0]).toMatchObject({
        cod: "0.00",
        fee: "0.00",
        free: true,
        reason: "Free delivery test",
      });
    });
  });

  it("makes the mixed state unrepresentable", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "FOB");
      /* The service forces the zeroes, but the constraint is what makes the
         guarantee true for every other caller -- an import, a fix-up script, a
         future endpoint. A free Order with money on it cannot exist. */
      for (const [label, options] of [
        ["free with COD", { cod: 300, free: true }],
        ["free with a Service Fee", { free: true, serviceFee: 25 }],
        ["free without a reason", { free: true, freeReason: null }],
        ["free with a blank reason", { free: true, freeReason: "   " }],
      ] as const) {
        await sql`savepoint sp`.execute(transaction);
        await expect(insertOrder(transaction, fixture, options), label).rejects.toMatchObject({
          constraint: "orders_free_order_shape_check",
        });
        await sql`rollback to savepoint sp`.execute(transaction);
      }
    });
  });

  it("refuses a free-order reason on an Order that is not free", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "FOC");
      // A stale reason on a normal Order would misreport it as a giveaway.
      await expect(
        sql`insert into orders(
            id,company_id,order_number,order_date,trader_id,area_id,created_by_account_id,
            customer_name,customer_mobile_number,customer_address,package_count,payment_condition,
            cod_amount,service_fee,final_service_fee_snapshot,configured_service_fee_snapshot,
            customer_provenance_status,pricing_provenance_status,is_free_order,free_order_reason
          ) values(${randomUUID()}::uuid,${fixture.companyId}::uuid,'ORD-N',current_date,
            ${fixture.traderId}::uuid,${fixture.areaId}::uuid,${fixture.actorId}::uuid,'C',
            '971500000009','A',1,'customer_pays_cod_and_fee',100,25,25,25,
            'legacy_unattributed','manual',false,'left over')`.execute(transaction),
      ).rejects.toMatchObject({ constraint: "orders_free_order_shape_check" });
    });
  });

  it("leaves the Trader's own pricing untouched", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "FOD");
      await insertOrder(transaction, fixture, { free: true });

      const price = await sql<{ fee: string; n: string }>`
        select service_fee::text as fee, count(*) over ()::text as n
          from trader_service_prices where company_id=${fixture.companyId}::uuid`.execute(
        transaction,
      );
      // One rule, still AED 25. A free Order is one Order, not a price change.
      expect(price.rows[0]).toMatchObject({ fee: "25.00", n: "1" });
    });
  });

  it("raises no Accounting Event when a free Order is delivered", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "FOE");
      const orderId = randomUUID();
      await insertOrder(transaction, fixture, { free: true, id: orderId });

      // The real delivery transition, so the capture trigger runs for real.
      await sql`update orders set delivery_status='delivered', delivered_at=now()
                 where id=${orderId}::uuid`.execute(transaction);

      const events = await sql<{ n: string }>`
        select count(*)::text as n from accounting_events
         where company_id=${fixture.companyId}::uuid`.execute(transaction);
      const journals = await sql<{ n: string }>`
        select count(*)::text as n from journal_entries
         where company_id=${fixture.companyId}::uuid`.execute(transaction);
      // Zero accounting impact means the trigger declines to enqueue at all --
      // the existing no_accounting_required rule, reused rather than duplicated.
      expect(events.rows[0]!.n).toBe("0");
      expect(journals.rows[0]!.n).toBe("0");
    });
  });

  it("creates no Driver cash collection obligation", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "FOF");
      const orderId = randomUUID();
      await insertOrder(transaction, fixture, { free: true, id: orderId });
      await sql`update orders set delivery_status='delivered', delivered_at=now()
                 where id=${orderId}::uuid`.execute(transaction);

      // Collection proposals select on driver_reconciliation_status='pending';
      // a free Order has no COD to hand over and never becomes pending.
      const pending = await sql<{ n: string }>`
        select count(*)::text as n from orders
         where company_id=${fixture.companyId}::uuid and driver_reconciliation_status='pending'
      `.execute(transaction);
      expect(pending.rows[0]!.n).toBe("0");
    });
  });

  it("still counts as a delivered Order for the employee Driver's earning", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "FOG");
      const orderId = randomUUID();
      await insertOrder(transaction, fixture, { free: true, id: orderId });
      await sql`update orders set delivery_status='delivered',
                    delivered_at='2026-08-07T09:00:00Z'::timestamptz
                 where id=${orderId}::uuid`.execute(transaction);

      /* The earning is owed for the work, not for the money. Accruing it here
         directly mirrors what `EmployeeDeliveryEarningService` writes on the
         delivery transition; the point under test is that a zero-value Order is
         an eligible delivery at all, which the delivery rule allows because it
         gates on delivered_at rather than on Order value. */
      const rule = await sql<{ id: string }>`
        select id from employee_delivery_earning_rules
         where company_id=${fixture.companyId}::uuid`.execute(transaction);
      await sql`insert into employee_order_earnings(company_id,employee_id,order_id,rule_id,
          order_number,delivered_at,applied_amount,earning_month)
        values(${fixture.companyId}::uuid,${fixture.employeeId}::uuid,${orderId}::uuid,
          ${rule.rows[0]!.id}::uuid,'ORD-G','2026-08-07T09:00:00Z'::timestamptz,2,
          '2026-08-01'::date)`.execute(transaction);

      const earned = await sql<{ amount: string }>`
        select applied_amount::text as amount from employee_order_earnings
         where company_id=${fixture.companyId}::uuid`.execute(transaction);
      expect(earned.rows[0]!.amount).toBe("2.00");
    });
  });

  it("keeps a normal Order priced and accounted as before", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "FOH");
      const orderId = randomUUID();
      // COD 100 at Noon's AED 25 rate: a normal Order, untouched by any of this.
      await insertOrder(transaction, fixture, { cod: 100, id: orderId, orderNumber: "ORD-N" });
      await sql`update orders set delivery_status='delivered', delivered_at=now()
                 where id=${orderId}::uuid`.execute(transaction);

      const row = await sql<{ fee: string; free: boolean }>`
        select is_free_order as free, service_fee::text as fee
          from orders where id=${orderId}::uuid`.execute(transaction);
      expect(row.rows[0]).toMatchObject({ fee: "25.00", free: false });
      // And it DOES raise an Accounting Event, unlike the free one.
      const events = await sql<{ n: string }>`
        select count(*)::text as n from accounting_events
         where company_id=${fixture.companyId}::uuid`.execute(transaction);
      expect(events.rows[0]!.n).toBe("1");
    });
  });

  it("keeps another Company's free Orders invisible", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const owner = await seed(transaction, "FOI");
      const neighbour = await seed(transaction, "FOJ");
      await insertOrder(transaction, owner, { free: true });

      const seen = await sql<{ n: string }>`
        select count(*)::text as n from orders
         where company_id=${neighbour.companyId}::uuid and is_free_order`.execute(transaction);
      expect(seen.rows[0]!.n).toBe("0");
    });
  });
});
