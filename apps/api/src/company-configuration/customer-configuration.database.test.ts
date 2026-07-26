import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";
const rollbackMarker = Symbol("rollback customer configuration test");

describe.skipIf(!runDatabaseTests)("Customer configuration database protections", () => {
  it("protects generated identity, mobile format, tenant scope, defaults, and history", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    try {
      await expect(
        database.transaction().execute(async (transaction) => {
          let sequence = 0;
          const rejected = async (work: () => Promise<unknown>, code: string) => {
            const savepoint = `customer_configuration_${++sequence}`;
            await sql.raw(`savepoint ${savepoint}`).execute(transaction);
            try {
              await expect(work()).rejects.toMatchObject({ code });
            } finally {
              await sql.raw(`rollback to savepoint ${savepoint}`).execute(transaction);
              await sql.raw(`release savepoint ${savepoint}`).execute(transaction);
            }
          };
          const companyA = randomUUID();
          const companyB = randomUUID();
          const actorA = randomUUID();
          const actorB = randomUUID();
          const areaA = randomUUID();
          const areaB = randomUUID();
          const customerId = randomUUID();
          const addressId = randomUUID();
          await sql`insert into companies(id,code,subdomain,name_en,status,activated_at) values
            (${companyA}::uuid,${`CC-${companyA.slice(0, 8)}`},${`cc-${companyA.slice(0, 8)}`},'Customer Test A','active',now()),
            (${companyB}::uuid,${`CC-${companyB.slice(0, 8)}`},${`cc-${companyB.slice(0, 8)}`},'Customer Test B','active',now())`.execute(
            transaction,
          );
          await sql`insert into accounts(id,company_id,account_kind,username,password_hash) values
            (${actorA}::uuid,${companyA}::uuid,'company_user',${`cc.a.${actorA}`},'test'),
            (${actorB}::uuid,${companyB}::uuid,'company_user',${`cc.b.${actorB}`},'test')`.execute(
            transaction,
          );
          await sql`insert into areas(id,company_id,emirate_id,code,name_en) values
            (${areaA}::uuid,${companyA}::uuid,(select id from emirates where code='DXB'),'AREA-000001','Dubai'),
            (${areaB}::uuid,${companyB}::uuid,(select id from emirates where code='DXB'),'AREA-000001','Sharjah')`.execute(transaction);
          await sql`insert into customers(id,company_id,code,name,mobile_number,created_by_account_id)
            values(${customerId}::uuid,${companyA}::uuid,'CUS-000001','Customer Test','971501234567',${actorA}::uuid)`.execute(
            transaction,
          );
          await sql`insert into customer_addresses(id,company_id,customer_id,area_id,address,is_default,created_by_account_id)
            values(${addressId}::uuid,${companyA}::uuid,${customerId}::uuid,${areaA}::uuid,'Dubai',true,${actorA}::uuid)`.execute(
            transaction,
          );

          await rejected(
            () =>
              sql`update customers set code='CHANGED' where id=${customerId}::uuid`.execute(
                transaction,
              ),
            "23514",
          );
          await rejected(
            () =>
              sql`update customers set mobile_number='0501234567' where id=${customerId}::uuid`.execute(
                transaction,
              ),
            "23514",
          );
          await rejected(
            () =>
              sql`insert into customer_addresses(company_id,customer_id,area_id,address,created_by_account_id)
              values(${companyA}::uuid,${customerId}::uuid,${areaB}::uuid,'Wrong Company',${actorA}::uuid)`.execute(
                transaction,
              ),
            "23503",
          );
          await rejected(
            () =>
              sql`insert into customer_addresses(company_id,customer_id,area_id,address,is_default,created_by_account_id)
              values(${companyA}::uuid,${customerId}::uuid,${areaA}::uuid,'Second Default',true,${actorA}::uuid)`.execute(
                transaction,
              ),
            "23505",
          );
          await rejected(async () => {
            await sql`update customer_addresses set is_default=false where id=${addressId}::uuid`.execute(
              transaction,
            );
            await sql`set constraints customer_addresses_default_guard immediate`.execute(
              transaction,
            );
          }, "23514");
          await rejected(
            () =>
              sql`delete from customer_addresses where id=${addressId}::uuid`.execute(transaction),
            "23514",
          );
          await rejected(
            () => sql`delete from customers where id=${customerId}::uuid`.execute(transaction),
            "23514",
          );
          throw rollbackMarker;
        }),
      ).rejects.toBe(rollbackMarker);
    } finally {
      await database.destroy();
    }
  }, 30000);
});
