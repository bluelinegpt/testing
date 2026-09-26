import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * An optional Customer address, as the database understands it.
 *
 * Customer address is optional on the Order form. Two separate rules had to be
 * reconciled for that to hold, and they pull in OPPOSITE directions -- which is
 * the whole reason this file exists:
 *
 *   - `customer_addresses_address_nonempty` forbade an empty address line, so a
 *     new Customer could not be created without one. Dropped.
 *   - `orders_customer_provenance_check` requires `customer_address_id` on a
 *     'resolved' Order, so the address RECORD must still exist.
 *
 * The first attempt satisfied the first rule by skipping the record entirely and
 * broke the second: Create Order failed with the generic "operation conflicts
 * with current data integrity rules". A DTO test could not have caught that --
 * both rules live in the database, so the guard belongs here.
 */

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

interface Fixture {
  readonly actorId: string;
  readonly areaCode: string;
  readonly areaId: string;
  readonly areaName: string;
  readonly companyId: string;
  readonly customerCode: string;
  readonly customerId: string;
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
  const marker = new Error("rollback customer address optional test");
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

/** One Company, Area, Trader and Customer -- the context an Order needs. */
async function seed(transaction: Transaction<DatabaseSchema>, label: string): Promise<Fixture> {
  const companyId = randomUUID();
  const actorId = randomUUID();
  const areaId = randomUUID();
  const traderId = randomUUID();
  const customerId = randomUUID();
  const short = companyId.slice(0, 8);
  const areaCode = `A-${short}`;
  const areaName = `Area ${short}`;
  const customerCode = `CUS-${short}`;
  const emirate = await sql<{ id: string }>`select id from emirates limit 1`.execute(transaction);

  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${companyId}::uuid,${`${label}-${short}`},${`${label.toLowerCase()}-${short}`},
      'Address Optional Test','active',now())`.execute(transaction);
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${actorId}::uuid,${companyId}::uuid,'company_user',${`ao.${actorId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into areas(id,company_id,code,name_en,name_ar,emirate_id)
    values(${areaId}::uuid,${companyId}::uuid,${areaCode},${areaName},'منطقة',
      ${emirate.rows[0]!.id}::uuid)`.execute(transaction);
  await sql`insert into traders(id,company_id,code,name_en,mobile_number,pickup_area_id,
      created_by_account_id)
    values(${traderId}::uuid,${companyId}::uuid,${`T-${short}`},'Trader','971500000003',
      ${areaId}::uuid,${actorId}::uuid)`.execute(transaction);
  await sql`insert into customers(id,company_id,code,name,mobile_number,created_by_account_id)
    values(${customerId}::uuid,${companyId}::uuid,${customerCode},'Customer','971500000009',
      ${actorId}::uuid)`.execute(transaction);

  return { actorId, areaCode, areaId, areaName, companyId, customerCode, customerId, traderId };
}

/** A saved address for the seeded Customer, with whatever address line is given. */
async function insertAddress(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  addressLine: string,
): Promise<string> {
  const id = randomUUID();
  await sql`insert into customer_addresses(id,company_id,customer_id,area_id,address,is_default,
      created_by_account_id)
    values(${id}::uuid,${fixture.companyId}::uuid,${fixture.customerId}::uuid,
      ${fixture.areaId}::uuid,${addressLine},true,${fixture.actorId}::uuid)`.execute(transaction);
  return id;
}

/** A 'resolved' Order -- one carrying a full Customer snapshot. */
function insertResolvedOrder(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  addressId: string | null,
  orderAddressLine = "",
) {
  return sql`insert into orders(
      id,company_id,order_number,order_date,trader_id,area_id,created_by_account_id,
      customer_name,customer_mobile_number,customer_address,package_count,payment_condition,
      cod_amount,service_fee,final_service_fee_snapshot,configured_service_fee_snapshot,
      customer_provenance_status,pricing_provenance_status,
      customer_id,customer_address_id,customer_code_snapshot,
      customer_area_code_snapshot,customer_area_name_snapshot
    ) values(
      ${randomUUID()}::uuid,${fixture.companyId}::uuid,${`ORD-${randomUUID().slice(0, 8)}`},
      current_date,${fixture.traderId}::uuid,${fixture.areaId}::uuid,${fixture.actorId}::uuid,
      'Customer','971500000009',${orderAddressLine},1,'customer_pays_cod_and_fee',
      0,25,25,25,'resolved','manual',
      ${fixture.customerId}::uuid,${addressId}::uuid,${fixture.customerCode},
      ${fixture.areaCode},${fixture.areaName}
    )`.execute(transaction);
}

describe.skipIf(!runDatabaseTests)("optional customer address", () => {
  it("saves a Customer address with no address line", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "AOA");
      const addressId = await insertAddress(transaction, fixture, "");

      const row = await sql<{ address: string; areaId: string }>`
        select address, area_id as "areaId" from customer_addresses
         where id = ${addressId}::uuid`.execute(transaction);
      // Stored as '', not null and not a placeholder. The Area is still known,
      // which is what keeps the record meaningful.
      expect(row.rows[0]?.address).toBe("");
      expect(row.rows[0]?.areaId).toBe(fixture.areaId);
    });
  });

  it("creates an Order for a Customer whose saved address is blank", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "AOB");
      const addressId = await insertAddress(transaction, fixture, "");

      // The end-to-end shape of the reported failure: this is the insert that
      // returned "operation conflicts with current data integrity rules".
      await expect(insertResolvedOrder(transaction, fixture, addressId)).resolves.toBeDefined();

      const row = await sql<{ addressId: string; provenance: string }>`
        select customer_address_id as "addressId",
               customer_provenance_status as "provenance"
          from orders where company_id = ${fixture.companyId}::uuid`.execute(transaction);
      expect(row.rows[0]).toMatchObject({ addressId, provenance: "resolved" });
    });
  });

  it("still refuses a resolved Order with no address record at all", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "AOC");

      /* This is the rule the first attempt fell foul of, and it is deliberately
         left standing: a 'resolved' Order asserts a complete Customer snapshot,
         and a null address identifier is not one. Pinned so nobody "fixes" a
         blank address by dropping the record again. */
      await expect(insertResolvedOrder(transaction, fixture, null)).rejects.toThrow(
        /orders_customer_provenance_check/,
      );
    });
  });

  it("keeps a real address line untouched", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "AOD");
      const addressId = await insertAddress(transaction, fixture, "Villa 9, Street 4");

      const row = await sql<{ address: string }>`
        select address from customer_addresses where id = ${addressId}::uuid`.execute(transaction);
      // Relaxing the rule permits blank; it does not change anything else.
      expect(row.rows[0]?.address).toBe("Villa 9, Street 4");
    });
  });
});
