import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";
const rollbackMarker = Symbol("rollback trader configuration test");

describe.skipIf(!runDatabaseTests)("Trader configuration database protections", () => {
  it("protects generated codes, effective pricing, tenant scope, and immutable history", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    try {
      await expect(
        database.transaction().execute(async (transaction) => {
          let sequence = 0;
          const rejected = async (work: () => Promise<unknown>, code: string) => {
            const savepoint = `trader_configuration_${++sequence}`;
            await sql.raw(`savepoint ${savepoint}`).execute(transaction);
            try {
              await expect(work()).rejects.toMatchObject({ code });
            } finally {
              await sql.raw(`rollback to savepoint ${savepoint}`).execute(transaction);
              await sql.raw(`release savepoint ${savepoint}`).execute(transaction);
            }
          };
          const companyA = randomUUID(),
            companyB = randomUUID(),
            actorA = randomUUID(),
            actorB = randomUUID(),
            traderAccount = randomUUID(),
            traderId = randomUUID(),
            areaId = randomUUID(),
            pricingA = randomUUID(),
            pricingB = randomUUID(),
            bankId = randomUUID();
          await sql`insert into companies(id,code,subdomain,name_en,status,activated_at) values
          (${companyA}::uuid,${`TC-${companyA.slice(0, 8)}`},${`tc-${companyA.slice(0, 8)}`},'Trader Test A','active',now()),
          (${companyB}::uuid,${`TC-${companyB.slice(0, 8)}`},${`tc-${companyB.slice(0, 8)}`},'Trader Test B','active',now())`.execute(
            transaction,
          );
          await sql`insert into accounts(id,company_id,account_kind,username,password_hash) values
          (${actorA}::uuid,${companyA}::uuid,'company_user',${`tc.a.${actorA}`},'test'),
          (${actorB}::uuid,${companyB}::uuid,'company_user',${`tc.b.${actorB}`},'test'),
          (${traderAccount}::uuid,${companyA}::uuid,'trader',${`tc.trader.${traderId}`},'test')`.execute(
            transaction,
          );
          await sql`insert into areas(id,company_id,emirate_id,code,name_en) values(${areaId}::uuid,${companyA}::uuid,(select id from emirates where code='DXB'),'AREA-000001','Dubai')`.execute(
            transaction,
          );
          await sql`insert into traders(id,company_id,account_id,code,name_en,mobile_number,created_by_account_id) values(${traderId}::uuid,${companyA}::uuid,${traderAccount}::uuid,'TRD-000001','متجر Test','971501234567',${actorA}::uuid)`.execute(
            transaction,
          );

          await rejected(
            () =>
              sql`update traders set code='CHANGED' where id=${traderId}::uuid`.execute(
                transaction,
              ),
            "23514",
          );
          await rejected(
            () =>
              sql`update traders set mobile_number='0501234567' where id=${traderId}::uuid`.execute(
                transaction,
              ),
            "23514",
          );

          // Pricing is now a flat Emirate/Area hierarchy (see
          // trader-service-pricing.database.test.ts). Here we only confirm one
          // global price per Trader and that prices cannot be deleted.
          await sql`insert into trader_service_prices(id,company_id,trader_id,emirate_id,area_id,service_fee,created_by_account_id) values(${pricingA}::uuid,${companyA}::uuid,${traderId}::uuid,null,null,10,${actorA}::uuid)`.execute(
            transaction,
          );
          await rejected(
            () =>
              sql`insert into trader_service_prices(id,company_id,trader_id,emirate_id,area_id,service_fee,created_by_account_id) values(${pricingB}::uuid,${companyA}::uuid,${traderId}::uuid,null,null,12,${actorA}::uuid)`.execute(
                transaction,
              ),
            "23505",
          );
          await rejected(
            () =>
              sql`delete from trader_service_prices where id=${pricingA}::uuid`.execute(transaction),
            "23001",
          );

          await sql`insert into trader_bank_accounts(id,company_id,trader_id,bank_name,account_name,account_number,iban,is_default,created_by_account_id) values(${bankId}::uuid,${companyA}::uuid,${traderId}::uuid,'Bank','Store','123','AE070331234567890123456',true,${actorA}::uuid)`.execute(
            transaction,
          );
          await rejected(
            () =>
              sql`update trader_bank_accounts set company_id=${companyB}::uuid where id=${bankId}::uuid`.execute(
                transaction,
              ),
            "23503",
          );
          await rejected(
            () =>
              sql`delete from trader_bank_accounts where id=${bankId}::uuid`.execute(transaction),
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
