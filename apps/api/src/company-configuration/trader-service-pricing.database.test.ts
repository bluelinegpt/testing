import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";
const rollbackMarker = Symbol("rollback trader service pricing test");

describe.skipIf(!runDatabaseTests)("Trader service pricing hierarchy", () => {
  it("resolves most-specific first and protects the pricing rules", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    try {
      await expect(
        database.transaction().execute(async (transaction) => {
          let sequence = 0;
          const rejected = async (work: () => Promise<unknown>, code: string) => {
            const savepoint = `pricing_${++sequence}`;
            await sql.raw(`savepoint ${savepoint}`).execute(transaction);
            try {
              await expect(work()).rejects.toMatchObject({ code });
            } finally {
              await sql.raw(`rollback to savepoint ${savepoint}`).execute(transaction);
              await sql.raw(`release savepoint ${savepoint}`).execute(transaction);
            }
          };

          const company = randomUUID();
          const actor = randomUUID();
          const trader = randomUUID();
          const traderAccount = randomUUID();
          await sql`insert into companies(id,code,subdomain,name_en,status,activated_at) values
            (${company}::uuid,${`TP-${company.slice(0, 8)}`},${`tp-${company.slice(0, 8)}`},'Pricing Test','active',now())`.execute(
            transaction,
          );
          await sql`insert into accounts(id,company_id,account_kind,username,password_hash) values
            (${actor}::uuid,${company}::uuid,'company_user',${`tp.a.${actor}`},'x'),
            (${traderAccount}::uuid,${company}::uuid,'trader',${`tp.t.${trader}`},'x')`.execute(
            transaction,
          );
          await sql`insert into traders(id,company_id,account_id,code,name_en,mobile_number,created_by_account_id)
            values(${trader}::uuid,${company}::uuid,${traderAccount}::uuid,'TRD-000001','Pricing Trader','971501234567',${actor}::uuid)`.execute(
            transaction,
          );

          const dubai = (
            await sql<{ id: string }>`select id from emirates where code='DXB'`.execute(transaction)
          ).rows[0]!.id;
          const abuDhabi = (
            await sql<{ id: string }>`select id from emirates where code='AUH'`.execute(transaction)
          ).rows[0]!.id;
          const jumeirah = randomUUID();
          const deira = randomUUID();
          const auhArea = randomUUID();
          await sql`insert into areas(id,company_id,emirate_id,code,name_en) values
            (${jumeirah}::uuid,${company}::uuid,${dubai}::uuid,'AREA-000001','Jumeirah'),
            (${deira}::uuid,${company}::uuid,${dubai}::uuid,'AREA-000002','Deira'),
            (${auhArea}::uuid,${company}::uuid,${abuDhabi}::uuid,'AREA-000003','Mussafah')`.execute(
            transaction,
          );

          const price = (emirate: string | null, area: string | null, fee: number) =>
            sql`insert into trader_service_prices
              (company_id,trader_id,emirate_id,area_id,service_fee,created_by_account_id)
              values(${company}::uuid,${trader}::uuid,${emirate}::uuid,${area}::uuid,${fee},${actor}::uuid)`.execute(
              transaction,
            );
          await price(null, null, 25); // global
          await price(dubai, null, 20); // Dubai default
          await price(dubai, jumeirah, 30); // Dubai / Jumeirah

          const resolveFee = async (areaId: string) => {
            const result = await sql<{ fee: string }>`
              select p.service_fee::text as fee
                from areas a
                join trader_service_prices p
                  on p.company_id=a.company_id and p.trader_id=${trader}::uuid
                 and ((p.emirate_id=a.emirate_id and p.area_id=a.id)
                      or (p.emirate_id=a.emirate_id and p.area_id is null)
                      or (p.emirate_id is null and p.area_id is null))
               where a.id=${areaId}::uuid and a.company_id=${company}::uuid
               order by (p.area_id is not null) desc, (p.emirate_id is not null) desc
               limit 1
            `.execute(transaction);
            return result.rows[0]?.fee;
          };

          // Specific Area beats the Emirate default, which beats the global row.
          expect(await resolveFee(jumeirah)).toBe("30.00");
          expect(await resolveFee(deira)).toBe("20.00");
          expect(await resolveFee(auhArea)).toBe("25.00");

          // One price per scope.
          await rejected(() => price(dubai, null, 99), "23505");
          // An Area cannot be priced under the wrong Emirate.
          await rejected(() => price(abuDhabi, jumeirah, 5), "23514");
          // An Area needs an Emirate.
          await rejected(() => price(null, jumeirah, 5), "23514");
          // Prices are history and cannot be deleted.
          await rejected(
            () =>
              sql`delete from trader_service_prices where trader_id=${trader}::uuid`.execute(
                transaction,
              ),
            "23001",
          );

          throw rollbackMarker;
        }),
      ).rejects.toBe(rollbackMarker);
    } finally {
      await database.destroy();
    }
  }, 60_000);
});
