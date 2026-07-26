import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";
const rollbackMarker = Symbol("rollback area configuration test");

describe.skipIf(!runDatabaseTests)("Emirate master and Area protections", () => {
  it("provisions Emirates immutably and enforces Area/Emirate rules", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    try {
      await expect(
        database.transaction().execute(async (transaction) => {
          let sequence = 0;
          const rejected = async (work: () => Promise<unknown>, code: string) => {
            const savepoint = `area_configuration_${++sequence}`;
            await sql.raw(`savepoint ${savepoint}`).execute(transaction);
            try {
              await expect(work()).rejects.toMatchObject({ code });
            } finally {
              await sql.raw(`rollback to savepoint ${savepoint}`).execute(transaction);
              await sql.raw(`release savepoint ${savepoint}`).execute(transaction);
            }
          };

          // --- Emirate master -------------------------------------------------
          const emirates = await sql<{ code: string; nameAr: string; nameEn: string }>`
            select code, name_en as "nameEn", name_ar as "nameAr"
              from emirates order by display_order
          `.execute(transaction);
          expect(emirates.rows.map((row) => row.code)).toEqual([
            "AUH",
            "DXB",
            "SHJ",
            "AJM",
            "UAQ",
            "RAK",
            "FUJ",
          ]);
          // Arabic display names are provisioned, not left to the client.
          expect(emirates.rows.every((row) => row.nameAr.trim().length > 0)).toBe(true);

          // Seeding again changes nothing.
          const reseed = await sql`
            insert into emirates (code, name_en, name_ar, display_order)
            values ('DXB', 'Dubai', 'دبي', 2)
            on conflict (code) do nothing
          `.execute(transaction);
          expect(Number(reseed.numAffectedRows ?? 0)).toBe(0);

          // The seeded rows are system-managed.
          await rejected(
            () =>
              sql`update emirates set name_en = 'Renamed' where code = 'DXB'`.execute(transaction),
            "23001",
          );
          await rejected(
            () => sql`delete from emirates where code = 'DXB'`.execute(transaction),
            "23001",
          );

          const dubai = await sql<{ id: string }>`
            select id from emirates where code = 'DXB'
          `.execute(transaction);
          const sharjah = await sql<{ id: string }>`
            select id from emirates where code = 'SHJ'
          `.execute(transaction);
          const dubaiId = dubai.rows[0]?.id;
          const sharjahId = sharjah.rows[0]?.id;
          if (dubaiId === undefined || sharjahId === undefined) {
            throw new Error("Emirate master is not provisioned");
          }

          // --- Company fixtures ----------------------------------------------
          const companyA = randomUUID();
          const companyB = randomUUID();
          await sql`insert into companies(id,code,subdomain,name_en,status,activated_at) values
            (${companyA}::uuid,${`AC-${companyA.slice(0, 8)}`},${`ac-${companyA.slice(0, 8)}`},'Area Test A','active',now()),
            (${companyB}::uuid,${`AC-${companyB.slice(0, 8)}`},${`ac-${companyB.slice(0, 8)}`},'Area Test B','active',now())
          `.execute(transaction);

          // --- Emirate is mandatory ------------------------------------------
          await rejected(
            () =>
              sql`insert into areas(company_id,code,name_en)
                  values(${companyA}::uuid,'AREA-000001','No Emirate')`.execute(transaction),
            "23502",
          );

          // --- Whitespace-only names are rejected -----------------------------
          await rejected(
            () =>
              sql`insert into areas(company_id,emirate_id,code,name_en)
                  values(${companyA}::uuid,${dubaiId}::uuid,'AREA-000002','   ')`.execute(
                transaction,
              ),
            "23514",
          );

          const first = randomUUID();
          await sql`insert into areas(id,company_id,emirate_id,code,name_en)
            values(${first}::uuid,${companyA}::uuid,${dubaiId}::uuid,'AREA-000001','Jumeirah')
          `.execute(transaction);

          // --- Duplicate name in the same Emirate and Company is rejected ------
          await rejected(
            () =>
              sql`insert into areas(company_id,emirate_id,code,name_en)
                  values(${companyA}::uuid,${dubaiId}::uuid,'AREA-000002','Jumeirah')`.execute(
                transaction,
              ),
            "23505",
          );
          // Case and surrounding whitespace do not defeat the rule.
          await rejected(
            () =>
              sql`insert into areas(company_id,emirate_id,code,name_en)
                  values(${companyA}::uuid,${dubaiId}::uuid,'AREA-000003','  jumeirah  ')`.execute(
                transaction,
              ),
            "23505",
          );

          // --- The same name is allowed in a different Emirate ----------------
          await sql`insert into areas(company_id,emirate_id,code,name_en)
            values(${companyA}::uuid,${sharjahId}::uuid,'AREA-000004','Jumeirah')
          `.execute(transaction);

          // --- ...and in a different Company -----------------------------------
          await sql`insert into areas(company_id,emirate_id,code,name_en)
            values(${companyB}::uuid,${dubaiId}::uuid,'AREA-000001','Jumeirah')
          `.execute(transaction);

          // --- An Emirate in use cannot be deleted out from under an Area ------
          await rejected(
            () => sql`delete from emirates where id = ${dubaiId}::uuid`.execute(transaction),
            "23001",
          );

          // Company A holds "Jumeirah" twice: once in Dubai, once in Sharjah.
          const counts = await sql<{ n: string }>`
            select count(*)::text as n from areas where company_id = ${companyA}::uuid
          `.execute(transaction);
          expect(Number(counts.rows[0]?.n ?? 0)).toBe(2);

          // Company B's identically named Area is invisible to Company A.
          const isolated = await sql<{ n: string }>`
            select count(*)::text as n from areas
             where company_id = ${companyB}::uuid and lower(btrim(name_en)) = 'jumeirah'
          `.execute(transaction);
          expect(Number(isolated.rows[0]?.n ?? 0)).toBe(1);

          throw rollbackMarker;
        }),
      ).rejects.toBe(rollbackMarker);
    } finally {
      await database.destroy();
    }
  }, 60_000);
});
