import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import { TemporaryPasswordService } from "../authentication/temporary-password.service.js";
import { DriverRoleProvisioningService } from "./driver-role-provisioning.service.js";
import { UserBusinessAccessService } from "./user-business-access.service.js";

/**
 * Automatic Driver role provisioning — a Driver-backed Employee's User must
 * never need an administrator to discover and hand-assign the office
 * `Orders` role (the D123 root cause this whole feature exists to close).
 *
 * ADDITIVE and IDEMPOTENT throughout: granting the role never touches any
 * other Role the account holds, re-running is always a safe no-op, and a
 * Company boundary is never crossed.
 */

const runDatabaseTests = process.env.RUN_DAILY_OPS_SUMMARY_DATABASE === "true";

interface Fixture {
  readonly actorId: string;
  readonly areaId: string;
  readonly companyId: string;
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
  const marker = new Error("rollback driver role provisioning test");
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
  const areaId = randomUUID();
  const traderId = randomUUID();
  const short = companyId.slice(0, 8);
  const emirate = await sql<{ id: string }>`select id from emirates limit 1`.execute(transaction);

  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${companyId}::uuid,${`${label}-${short}`},${`${label.toLowerCase()}-${short}`},
      'Driver Role Provisioning Test','active',now())`.execute(transaction);
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${actorId}::uuid,${companyId}::uuid,'company_user',${`drp.actor.${actorId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into areas(id,company_id,code,name_en,name_ar,emirate_id)
    values(${areaId}::uuid,${companyId}::uuid,${`A-${short}`},${`Area ${short}`},'منطقة',
      ${emirate.rows[0]!.id}::uuid)`.execute(transaction);
  const traderAccountId = randomUUID();
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${traderAccountId}::uuid,${companyId}::uuid,'trader',${`drp.trader.${traderAccountId}`},
      'x')`.execute(transaction);
  await sql`insert into traders(id,company_id,account_id,code,name_en,mobile_number)
    values(${traderId}::uuid,${companyId}::uuid,${traderAccountId}::uuid,${`T-${short}`},'Trader',
      '971500000003')`.execute(transaction);

  return { actorId, areaId, companyId, traderId };
}

/** An Employee with no `company_users` row yet -- ready to be linked. If
 *  `driverBacked`, a real `drivers.employee_id` record backs it first. */
async function seedEmployee(
  transaction: Transaction<DatabaseSchema>,
  fixture: Fixture,
  driverBacked: boolean,
): Promise<string> {
  const employeeId = randomUUID();
  const short = employeeId.slice(0, 8);
  await sql`insert into employees(id,company_id,name_en,mobile_number)
    values(${employeeId}::uuid,${fixture.companyId}::uuid,${`Employee ${short}`},'971509999999')`.execute(
    transaction,
  );
  if (driverBacked) {
    await sql`insert into drivers(id,company_id,employee_id,code,name_en,mobile_number,driver_type)
      values(${randomUUID()}::uuid,${fixture.companyId}::uuid,${employeeId}::uuid,${`DRV-${short}`},
        ${`Employee ${short}`},'971509999999','employee')`.execute(transaction);
  }
  return employeeId;
}

function buildServices(transaction: Transaction<DatabaseSchema>, companyId: string, actorId: string) {
  const database = transaction as unknown as Kysely<DatabaseSchema>;
  const transactions = { execute: (work: (tx: unknown) => unknown) => work(transaction) } as never;
  const tenants = { current: () => ({ companyId }) } as never;
  const identities = {
    current: () => ({ identityId: actorId, permissions: new Set(["users_roles.manage"]) }),
  } as never;
  const driverRoles = new DriverRoleProvisioningService(database);
  const userBusinessAccess = new UserBusinessAccessService(
    transactions,
    tenants,
    identities,
    new PasswordHasher(),
    new TemporaryPasswordService(),
    driverRoles,
  );
  return { driverRoles, userBusinessAccess };
}

async function accountRoles(
  transaction: Transaction<DatabaseSchema>,
  accountId: string,
): Promise<readonly string[]> {
  const rows = await sql<{ code: string }>`
    select r.code from account_roles ar join roles r on r.id = ar.role_id
     where ar.account_id = ${accountId}::uuid order by r.code
  `.execute(transaction);
  return rows.rows.map((row) => row.code);
}

describe.skipIf(!runDatabaseTests)("Driver role auto-provisioning", () => {
  it("a new Driver Employee + new linked User automatically receives the Driver role, with no roleIds required", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DRA");
      const { userBusinessAccess } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const employeeId = await seedEmployee(transaction, fixture, true);

      const result = await userBusinessAccess.createAndLink(
        "employee",
        employeeId,
        {
          displayName: "New Driver",
          preferredLanguage: "en",
          username: `driver.${employeeId.slice(0, 8)}`,
        },
        `idem-${randomUUID()}`,
        randomUUID(),
      );

      const roles = await accountRoles(transaction, String(result.accountId));
      expect(roles).toEqual(["driver_operations"]);
    });
  });

  it("a normal (non-Driver) Employee + User does NOT receive the Driver role, and still requires an explicit Role", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DRB");
      const { userBusinessAccess } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const employeeId = await seedEmployee(transaction, fixture, false);

      await expect(
        userBusinessAccess.createAndLink(
          "employee",
          employeeId,
          {
            displayName: "Office Employee",
            preferredLanguage: "en",
            username: `office.${employeeId.slice(0, 8)}`,
          },
          `idem-${randomUUID()}`,
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "employee_user_role_required" });
    });
  });

  it("granting the Driver role on link() revokes the account's existing sessions, so a fresh login is required", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DRC");
      const { userBusinessAccess } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const employeeId = await seedEmployee(transaction, fixture, true);

      const accountId = randomUUID();
      await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
        values(${accountId}::uuid,${fixture.companyId}::uuid,'company_user',
          ${`drp.existing.${accountId}`},'x')`.execute(transaction);
      const sessionId = randomUUID();
      await sql`insert into account_sessions(id,account_id,company_id,token_hash,expires_at)
        values(${sessionId}::uuid,${accountId}::uuid,${fixture.companyId}::uuid,${'a'.repeat(64)},now()+interval '1 day')`.execute(
        transaction,
      );

      await userBusinessAccess.link("employee", employeeId, accountId, randomUUID(), `idem-${randomUUID()}`);

      const roles = await accountRoles(transaction, accountId);
      expect(roles).toEqual(["driver_operations"]);
      const session = await sql<{ revokedAt: string | null }>`
        select revoked_at as "revokedAt" from account_sessions where id = ${sessionId}::uuid
      `.execute(transaction);
      expect(session.rows[0]?.revokedAt).not.toBeNull();
    });
  });

  it("repeated link()/provisioning does not duplicate the role assignment", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DRD");
      const { userBusinessAccess, driverRoles } = buildServices(
        transaction,
        fixture.companyId,
        fixture.actorId,
      );
      const employeeId = await seedEmployee(transaction, fixture, true);
      const accountId = randomUUID();
      await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
        values(${accountId}::uuid,${fixture.companyId}::uuid,'company_user',
          ${`drp.repeat.${accountId}`},'x')`.execute(transaction);

      await userBusinessAccess.link("employee", employeeId, accountId, randomUUID(), `idem-${randomUUID()}`);
      // A second, independent provisioning call for the same account -- the
      // real call site a re-link or a later backfill sweep would make.
      const grantedAgain = await driverRoles.provisionForEmployeeLink(
        transaction,
        fixture.companyId,
        employeeId,
        accountId,
      );
      expect(grantedAgain).toBe(false); // already granted -- no-op, not a duplicate

      const roleRows = await sql<{ count: number }>`
        select count(*)::int as count from account_roles ar
          join roles r on r.id = ar.role_id and r.code = 'driver_operations'
         where ar.account_id = ${accountId}::uuid
      `.execute(transaction);
      expect(roleRows.rows[0]?.count).toBe(1);
    });
  });

  it("cannot provision the Driver role across a Company boundary", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixtureA = await seed(transaction, "DRE");
      const fixtureB = await seed(transaction, "DRF");
      const { driverRoles } = buildServices(transaction, fixtureA.companyId, fixtureA.actorId);
      // A Driver-backed Employee that genuinely exists, but in Company B.
      const employeeId = await seedEmployee(transaction, fixtureB, true);
      const accountId = randomUUID();
      await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
        values(${accountId}::uuid,${fixtureA.companyId}::uuid,'company_user',
          ${`drp.cross.${accountId}`},'x')`.execute(transaction);

      // Asked to provision under Company A's id for an Employee that only
      // exists under Company B -- `isDriverBackedEmployee` is company-scoped
      // and must find nothing.
      const granted = await driverRoles.provisionForEmployeeLink(
        transaction,
        fixtureA.companyId,
        employeeId,
        accountId,
      );
      expect(granted).toBe(false);
      const roles = await accountRoles(transaction, accountId);
      expect(roles).toEqual([]);

      // The Company A Driver role, if any Company A account already
      // provisioned one, must never appear on this Company B Employee's own
      // records either -- roles stay strictly within their own Company.
      const crossRole = await sql<{ id: string }>`
        select id from roles where company_id = ${fixtureA.companyId}::uuid and code = 'driver_operations'
      `.execute(transaction);
      expect(crossRole.rows).toHaveLength(0);
    });
  });

  it("revoking the Driver role removes exactly that role and forces a fresh login, leaving any other Role untouched", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DRG");
      const { userBusinessAccess, driverRoles } = buildServices(
        transaction,
        fixture.companyId,
        fixture.actorId,
      );
      const employeeId = await seedEmployee(transaction, fixture, true);
      const accountId = randomUUID();
      await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
        values(${accountId}::uuid,${fixture.companyId}::uuid,'company_user',
          ${`drp.revoke.${accountId}`},'x')`.execute(transaction);
      // A separate, legitimate office Role this same account also holds --
      // must survive the Driver role's revocation untouched.
      const otherRoleId = randomUUID();
      await sql`insert into roles(id,company_id,code,name,is_active)
        values(${otherRoleId}::uuid,${fixture.companyId}::uuid,'reports_viewer','Reports Viewer',true)`.execute(
        transaction,
      );
      await sql`insert into account_roles(account_id,role_id,company_id)
        values(${accountId}::uuid,${otherRoleId}::uuid,${fixture.companyId}::uuid)`.execute(transaction);

      await userBusinessAccess.link("employee", employeeId, accountId, randomUUID(), `idem-${randomUUID()}`);
      expect(await accountRoles(transaction, accountId)).toEqual(
        expect.arrayContaining(["driver_operations", "reports_viewer"]),
      );

      const sessionId = randomUUID();
      await sql`insert into account_sessions(id,account_id,company_id,token_hash,expires_at)
        values(${sessionId}::uuid,${accountId}::uuid,${fixture.companyId}::uuid,${'a'.repeat(64)},now()+interval '1 day')`.execute(
        transaction,
      );

      const revoked = await driverRoles.revoke(transaction, fixture.companyId, accountId);
      expect(revoked).toBe(true);
      const rolesAfter = await accountRoles(transaction, accountId);
      expect(rolesAfter).toEqual(["reports_viewer"]);
      const session = await sql<{ revokedAt: string | null }>`
        select revoked_at as "revokedAt" from account_sessions where id = ${sessionId}::uuid
      `.execute(transaction);
      expect(session.rows[0]?.revokedAt).not.toBeNull();
    });
  });

  it("the auto-provisioned Driver role grants exactly one permission and none of the office/financial permissions", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "DRH");
      const { driverRoles } = buildServices(transaction, fixture.companyId, fixture.actorId);
      const employeeId = await seedEmployee(transaction, fixture, true);
      const accountId = randomUUID();
      await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
        values(${accountId}::uuid,${fixture.companyId}::uuid,'company_user',
          ${`drp.perms.${accountId}`},'x')`.execute(transaction);

      await driverRoles.provisionForEmployeeLink(transaction, fixture.companyId, employeeId, accountId);

      const permissions = await sql<{ code: string }>`
        select rp.permission_code as code
          from account_roles ar
          join role_permissions rp on rp.role_id = ar.role_id
         where ar.account_id = ${accountId}::uuid
      `.execute(transaction);
      expect(permissions.rows.map((row) => row.code)).toEqual(["orders.driver_self_service"]);
      const forbidden = [
        "orders.assign_driver",
        "orders.create",
        "orders.edit_before_processing",
        "orders.update_delivery_status",
        "financial_transactions.reverse",
        "journals.create_manual",
        "reconciliations.create",
        "settlements.create",
        "users_roles.manage",
      ];
      for (const code of forbidden) {
        expect(permissions.rows.map((row) => row.code)).not.toContain(code);
      }
    });
  });
});
