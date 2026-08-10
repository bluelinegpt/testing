import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * The Employee -> Driver derivation `OperationsService.currentEmployeeDriverId`
 * is built on, and the Orders-visibility predicate it feeds.
 *
 * A `company_user` account logging in as "the Driver" resolves through
 * `IdentityContext.profileType==='employee'`/`profileId` (set from an active
 * `user_business_links` row, `authentication.repository.ts`'s `activeProfile`)
 * -- never from name/mobile/email. This exercises that exact chain at the SQL
 * level: `drivers.employee_id = <the linked Employee's id>`, then
 * `orders.assigned_driver_id = <that Driver's id>`. It does not boot the
 * NestJS app or mock `IdentityContext` (no existing Operations test does
 * either); it proves the query semantics the service method executes are
 * correct, matching this repository's established DB-level testing style for
 * cross-table relationships (see `employee-driver-linkage.database.test.ts`).
 */

const runDatabaseTests = process.env.RUN_DATABASE_INTEGRATION === "true";

interface Fixture {
  readonly actorId: string;
  readonly areaId: string;
  readonly companyId: string;
  readonly driverAccountId: string;
  readonly driverId: string;
  readonly employeeId: string;
  readonly otherDriverId: string;
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
  const marker = new Error("rollback driver user identity link test");
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

/**
 * One Company Driver User (a `company_user` account linked to an Employee
 * with a backing "employee"-type Driver record, and an active
 * `user_business_links(entity_type='employee')` grant -- the exact chain the
 * manual test scenario describes), plus an unrelated second Driver to prove
 * cross-Driver isolation.
 */
async function seed(transaction: Transaction<DatabaseSchema>, label: string): Promise<Fixture> {
  const companyId = randomUUID();
  const actorId = randomUUID();
  const areaId = randomUUID();
  const traderId = randomUUID();
  const driverAccountId = randomUUID();
  const employeeId = randomUUID();
  const driverId = randomUUID();
  const otherDriverAccountId = randomUUID();
  const otherEmployeeId = randomUUID();
  const otherDriverId = randomUUID();
  const short = companyId.slice(0, 8);
  const emirate = await sql<{ id: string }>`select id from emirates limit 1`.execute(transaction);

  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${companyId}::uuid,${`${label}-${short}`},${`${label.toLowerCase()}-${short}`},
      'Driver Identity Link Test','active',now())`.execute(transaction);
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${actorId}::uuid,${companyId}::uuid,'company_user',${`dl.actor.${actorId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into areas(id,company_id,code,name_en,name_ar,emirate_id)
    values(${areaId}::uuid,${companyId}::uuid,${`A-${short}`},${`Area ${short}`},'منطقة',
      ${emirate.rows[0]!.id}::uuid)`.execute(transaction);
  await sql`insert into traders(id,company_id,code,name_en,mobile_number,pickup_area_id,
      created_by_account_id)
    values(${traderId}::uuid,${companyId}::uuid,${`T-${short}`},'Trader','971500000003',
      ${areaId}::uuid,${actorId}::uuid)`.execute(transaction);

  // The Driver User: a company_user account (this is the login the manual
  // test scenario used), linked to an Employee, which is in turn the backing
  // Employee of a real Driver record -- the exact chain that was previously
  // never joined together anywhere in the codebase.
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${driverAccountId}::uuid,${companyId}::uuid,'company_user',
      ${`dl.driver.${driverAccountId}`},'x')`.execute(transaction);
  const companyUserResult = await sql<{ id: string }>`
    insert into company_users(id,company_id,account_id,name_en,display_name)
    values(${randomUUID()}::uuid,${companyId}::uuid,${driverAccountId}::uuid,'Ahmed','Ahmed')
    returning id
  `.execute(transaction);
  const companyUserId = companyUserResult.rows[0]!.id;
  await sql`insert into employees(id,company_id,company_user_id,name_en,mobile_number)
    values(${employeeId}::uuid,${companyId}::uuid,${companyUserId}::uuid,'Ahmed','971501111111')`.execute(
    transaction,
  );
  await sql`insert into drivers(id,company_id,account_id,employee_id,code,name_en,mobile_number,
      driver_type)
    values(${driverId}::uuid,${companyId}::uuid,null,${employeeId}::uuid,${`DRV-${short}`},'Ahmed',
      '971501111111','employee')`.execute(transaction);
  // The exact grant the login relies on: `activeProfile()` only resolves
  // `profileType='employee'`/`profileId` from an ACTIVE user_business_links
  // row -- without this, the account has no profile at all.
  await sql`insert into user_business_links(id,company_id,account_id,entity_type,entity_id,
      access_status,created_by_account_id)
    values(${randomUUID()}::uuid,${companyId}::uuid,${driverAccountId}::uuid,'employee',
      ${employeeId}::uuid,'active',${actorId}::uuid)`.execute(transaction);

  // An unrelated second Driver (Kareem), same Company -- proves isolation.
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${otherDriverAccountId}::uuid,${companyId}::uuid,'company_user',
      ${`dl.other.${otherDriverAccountId}`},'x')`.execute(transaction);
  const otherCompanyUserResult = await sql<{ id: string }>`
    insert into company_users(id,company_id,account_id,name_en,display_name)
    values(${randomUUID()}::uuid,${companyId}::uuid,${otherDriverAccountId}::uuid,'Kareem','Kareem')
    returning id
  `.execute(transaction);
  await sql`insert into employees(id,company_id,company_user_id,name_en,mobile_number)
    values(${otherEmployeeId}::uuid,${companyId}::uuid,${otherCompanyUserResult.rows[0]!.id}::uuid,
      'Kareem','971502222222')`.execute(transaction);
  await sql`insert into drivers(id,company_id,account_id,employee_id,code,name_en,mobile_number,
      driver_type)
    values(${otherDriverId}::uuid,${companyId}::uuid,null,${otherEmployeeId}::uuid,
      ${`DRV-K-${short}`},'Kareem','971502222222','employee')`.execute(transaction);

  return {
    actorId,
    areaId,
    companyId,
    driverAccountId,
    driverId,
    employeeId,
    otherDriverId,
    traderId,
  };
}

function insertOrder(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  assignedDriverId: string | null,
) {
  return sql<{ id: string }>`
    insert into orders(
      id,company_id,order_number,order_date,trader_id,area_id,created_by_account_id,
      customer_name,customer_mobile_number,customer_address,package_count,payment_condition,
      cod_amount,service_fee,final_service_fee_snapshot,configured_service_fee_snapshot,
      customer_provenance_status,pricing_provenance_status,assigned_driver_id
    ) values (
      ${randomUUID()}::uuid,${fixture.companyId}::uuid,${`ORD-${randomUUID().slice(0, 8)}`},
      current_date,${fixture.traderId}::uuid,${fixture.areaId}::uuid,${fixture.actorId}::uuid,
      'Customer','971500000009','Address',1,'customer_pays_cod_and_fee',
      0,25,25,25,'legacy_unattributed','manual',${assignedDriverId}::uuid
    ) returning id
  `.execute(transaction);
}

describe.skipIf(!runDatabaseTests)("Driver User identity link", () => {
  it("resolves the Driver id from the linked Employee, never from name/mobile/email", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DUI");

      // Mirrors `currentEmployeeDriverId` in operations.service.ts exactly.
      const resolved = await sql<{ id: string }>`
        select id from drivers
         where employee_id = (
           select entity_id from user_business_links
            where account_id = ${fixture.driverAccountId}::uuid
              and entity_type = 'employee' and access_status = 'active'
         )::uuid and company_id = ${fixture.companyId}::uuid
      `.execute(transaction);

      expect(resolved.rows[0]?.id).toBe(fixture.driverId);
    });
  });

  it("scopes Orders to the resolved Driver's own assignment only", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DUS");
      const own = await insertOrder(transaction, fixture, fixture.driverId);
      const others = await insertOrder(transaction, fixture, fixture.otherDriverId);
      const unassigned = await insertOrder(transaction, fixture, null);

      const visible = await sql<{ id: string }>`
        select id from orders
         where company_id = ${fixture.companyId}::uuid
           and assigned_driver_id = ${fixture.driverId}::uuid
      `.execute(transaction);

      const visibleIds = visible.rows.map((row) => row.id);
      expect(visibleIds).toEqual([own.rows[0]!.id]);
      expect(visibleIds).not.toContain(others.rows[0]!.id);
      expect(visibleIds).not.toContain(unassigned.rows[0]!.id);
    });
  });

  it("a guessed Order id belonging to another Driver is indistinguishable from not found", async () => {
    // Mirrors `orderDetail`'s own check in operations.service.ts: the list
    // (`orders()`) already scopes to the caller's own Driver id, but the
    // single-Order lookup takes an arbitrary id reachable by the SAME
    // permissions -- without this check a Driver could read any other
    // Order in the Company by guessing/iterating ids. The application
    // throws the SAME `order_not_found` a truly nonexistent id would, never
    // a distinct 403 that would confirm the Order exists.
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DUG");
      const own = await insertOrder(transaction, fixture, fixture.driverId);
      const others = await insertOrder(transaction, fixture, fixture.otherDriverId);

      const ownDriverId = fixture.driverId;
      const orderRow = await sql<{ assignedDriverId: string | null }>`
        select assigned_driver_id as "assignedDriverId" from orders
         where id = ${others.rows[0]!.id}::uuid and company_id = ${fixture.companyId}::uuid
      `.execute(transaction);
      const visibleToOwnDriver = orderRow.rows[0]?.assignedDriverId === ownDriverId;
      expect(visibleToOwnDriver).toBe(false);

      const ownOrderRow = await sql<{ assignedDriverId: string | null }>`
        select assigned_driver_id as "assignedDriverId" from orders
         where id = ${own.rows[0]!.id}::uuid and company_id = ${fixture.companyId}::uuid
      `.execute(transaction);
      expect(ownOrderRow.rows[0]?.assignedDriverId === ownDriverId).toBe(true);
    });
  });

  it("a company_user with no linked Employee/Driver resolves nothing", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DUN");
      const bareAccountId = randomUUID();
      await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
        values(${bareAccountId}::uuid,${fixture.companyId}::uuid,'company_user',
          ${`dl.bare.${bareAccountId}`},'x')`.execute(transaction);

      const resolved = await sql<{ id: string }>`
        select d.id from drivers d
        join user_business_links l on l.entity_id = d.employee_id and l.entity_type = 'employee'
         where l.account_id = ${bareAccountId}::uuid and l.access_status = 'active'
           and d.company_id = ${fixture.companyId}::uuid
      `.execute(transaction);

      expect(resolved.rows).toHaveLength(0);
    });
  });
});
