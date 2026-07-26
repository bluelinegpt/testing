import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Pool, type PoolClient } from "pg";

const runDatabaseTests = process.env.RUN_DATABASE_INTEGRATION === "true";

describe.skipIf(!runDatabaseTests)("User and Role administration database protections", () => {
  it("preserves identity, tenant scope, active access, and Company-level serialization", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
    const client = await pool.connect();
    const companyId = randomUUID(),
      otherCompanyId = randomUUID(),
      roleId = randomUUID(),
      accountId = randomUUID(),
      companyUserId = randomUUID();
    try {
      await client.query("begin");
      await client.query(
        "insert into companies(id,code,subdomain,name_en,status) values($1,$2,$3,'Admin Test','active'),($4,$5,$6,'Other Test','active')",
        [
          companyId,
          `ADM-${companyId.slice(0, 8)}`,
          `adm-${companyId.slice(0, 8)}`,
          otherCompanyId,
          `OTH-${otherCompanyId.slice(0, 8)}`,
          `oth-${otherCompanyId.slice(0, 8)}`,
        ],
      );
      await client.query(
        "insert into roles(id,company_id,code,name,is_active) values($1,$2,'administrator','Administrator',true)",
        [roleId, companyId],
      );
      await client.query(
        "insert into role_permissions(role_id,permission_code) values($1,'users_roles.manage')",
        [roleId],
      );
      await client.query(
        "insert into accounts(id,company_id,account_kind,username,email,mobile_number,password_hash,status) values($1,$2,'company_user','Admin.Test','admin@example.test','971501234567','test-hash','active')",
        [accountId, companyId],
      );
      await client.query(
        "insert into company_users(id,company_id,account_id,name_en,display_name,email,mobile_number,is_active) values($1,$2,$3,'Admin Test','Admin Test','admin@example.test','971501234567',true)",
        [companyUserId, companyId, accountId],
      );
      await client.query(
        "insert into account_roles(account_id,role_id,company_id) values($1,$2,$3)",
        [accountId, roleId, companyId],
      );
      await client.query("set constraints all immediate");
      await rejects(client, "username immutable", () =>
        client.query("update accounts set username='renamed.user' where id=$1", [accountId]),
      );
      await rejects(client, "role code immutable", () =>
        client.query("update roles set code='renamed' where id=$1", [roleId]),
      );
      await rejects(client, "User deletion", () =>
        client.query("delete from accounts where id=$1", [accountId]),
      );
      await rejects(client, "Role deletion", () =>
        client.query("delete from roles where id=$1", [roleId]),
      );
      await rejects(client, "duplicate email", async () => {
        const duplicateAccount = randomUUID();
        await client.query(
          "insert into accounts(id,company_id,account_kind,username,email,password_hash,status) values($1,$2,'company_user','second.user','ADMIN@example.test','test-hash','disabled')",
          [duplicateAccount, companyId],
        );
      });
      await rejects(client, "duplicate mobile", () =>
        client.query(
          "insert into accounts(company_id,account_kind,username,mobile_number,password_hash,status) values($1,'company_user','mobile.user','971501234567','test-hash','disabled')",
          [companyId],
        ),
      );
      await rejects(client, "invalid mobile", () =>
        client.query("update company_users set mobile_number='+971501234567' where id=$1", [
          companyUserId,
        ]),
      );
      await rejects(client, "active User without Role", async () => {
        await client.query("delete from account_roles where account_id=$1", [accountId]);
        await client.query("set constraints all immediate");
      });
      await rejects(client, "active Role without Permission", async () => {
        await client.query("delete from role_permissions where role_id=$1", [roleId]);
        await client.query("set constraints all immediate");
      });
      const otherAccount = randomUUID();
      await client.query(
        "insert into accounts(id,company_id,account_kind,username,email,mobile_number,password_hash,status) values($1,$2,'company_user','other.user','admin@example.test','971501234567','test-hash','disabled')",
        [otherAccount, otherCompanyId],
      );
      await client.query(
        "insert into company_users(company_id,account_id,name_en,display_name,email,is_active) values($1,$2,'Other','Other','admin@example.test',false)",
        [otherCompanyId, otherAccount],
      );
      const employeeOne = randomUUID(),
        employeeTwo = randomUUID();
      await client.query(
        "insert into employees(id,company_id,name_en,is_active) values($1,$3,'One',true),($2,$3,'Two',true)",
        [employeeOne, employeeTwo, companyId],
      );
      await client.query("update employees set company_user_id=$1 where id=$2", [
        companyUserId,
        employeeOne,
      ]);
      await rejects(client, "one Employee per User", () =>
        client.query("update employees set company_user_id=$1 where id=$2", [
          companyUserId,
          employeeTwo,
        ]),
      );
      const contender = await pool.connect();
      try {
        await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [companyId]);
        await contender.query("begin");
        const result = await contender.query<{ acquired: boolean }>(
          "select pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired",
          [companyId],
        );
        expect(result.rows[0]?.acquired).toBe(false);
        await contender.query("rollback");
      } finally {
        contender.release();
      }
      await client.query("rollback");
    } finally {
      client.release();
      await pool.end();
    }
  });
});

async function rejects(client: PoolClient, label: string, operation: () => Promise<unknown>) {
  const savepoint = `test_${label.replaceAll(/[^a-z0-9]/gi, "_")}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    await operation();
    throw new Error(`${label} unexpectedly succeeded`);
  } catch (error) {
    await client.query(`rollback to savepoint ${savepoint}`);
    if (error instanceof Error && error.message.endsWith("unexpectedly succeeded")) throw error;
  } finally {
    await client.query(`release savepoint ${savepoint}`);
  }
}
