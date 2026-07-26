import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";
const rollbackMarker = Symbol("rollback employee driver linkage test");

describe.skipIf(!runDatabaseTests)("Employee master and Driver linkage", () => {
  it("seeds roles and links a Driver for driver-role Employees only", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    try {
      await expect(
        database.transaction().execute(async (transaction) => {
          let sequence = 0;
          const rejected = async (work: () => Promise<unknown>, code: string) => {
            const savepoint = `link_${++sequence}`;
            await sql.raw(`savepoint ${savepoint}`).execute(transaction);
            try {
              await expect(work()).rejects.toMatchObject({ code });
            } finally {
              await sql.raw(`rollback to savepoint ${savepoint}`).execute(transaction);
              await sql.raw(`release savepoint ${savepoint}`).execute(transaction);
            }
          };

          const company = randomUUID();
          await sql`insert into companies(id,code,subdomain,name_en,status,activated_at) values
            (${company}::uuid,${`EL-${company.slice(0, 8)}`},${`el-${company.slice(0, 8)}`},'Linkage Test','active',now())`.execute(
            transaction,
          );

          // Roles are seeded per Company by the migration only for Companies that
          // existed then; seed this fresh test Company's roles the same way.
          await sql`insert into employee_roles (company_id, code, name_en, is_driver_role) values
            (${company}::uuid,'DRIVER','Driver',true),
            (${company}::uuid,'CUSTOMER_SERVICE','Customer Service',false)`.execute(transaction);

          const driverRole = (
            await sql<{ id: string }>`select id from employee_roles where company_id=${company}::uuid and is_driver_role`.execute(
              transaction,
            )
          ).rows[0]!.id;
          const csRole = (
            await sql<{ id: string }>`select id from employee_roles where company_id=${company}::uuid and code='CUSTOMER_SERVICE'`.execute(
              transaction,
            )
          ).rows[0]!.id;

          // Role names are unique per Company.
          await rejected(
            () =>
              sql`insert into employee_roles(company_id,code,name_en) values(${company}::uuid,'DRIVER2','Driver')`.execute(
                transaction,
              ),
            "23505",
          );

          const outsourcedEmp = randomUUID();
          await sql`insert into employees(id,company_id,employee_role_id,employee_number,name_en,mobile_number,basic_salary)
            values(${outsourcedEmp}::uuid,${company}::uuid,${driverRole}::uuid,'EMP-000001','Ali','971501234567',0)`.execute(
            transaction,
          );
          // An outsourced Driver may now be linked to its Employee, with a fee.
          await sql`insert into drivers(company_id,employee_id,code,name_en,mobile_number,driver_type,account_status,outsourced_fee_per_delivered_order)
            values(${company}::uuid,${outsourcedEmp}::uuid,'DRV-000001','Ali','971501234567','outsourced','active',5)`.execute(
            transaction,
          );

          const salariedEmp = randomUUID();
          await sql`insert into employees(id,company_id,employee_role_id,employee_number,name_en,mobile_number,basic_salary)
            values(${salariedEmp}::uuid,${company}::uuid,${driverRole}::uuid,'EMP-000002','Sara','971502223333',4000)`.execute(
            transaction,
          );
          await sql`insert into drivers(company_id,employee_id,code,name_en,mobile_number,driver_type,account_status)
            values(${company}::uuid,${salariedEmp}::uuid,'DRV-000002','Sara','971502223333','employee','active')`.execute(
            transaction,
          );

          // An employee-type Driver must not carry a per-delivery fee.
          await rejected(
            () =>
              sql`insert into drivers(company_id,employee_id,code,name_en,mobile_number,driver_type,account_status,outsourced_fee_per_delivered_order)
                values(${company}::uuid,${salariedEmp}::uuid,'DRV-000009','X','971509998888','employee','active',5)`.execute(
                transaction,
              ),
            "23514",
          );

          const drivers = await sql<{ count: string }>`
            select count(*)::text as count from drivers where company_id=${company}::uuid
          `.execute(transaction);
          expect(Number(drivers.rows[0]?.count ?? 0)).toBe(2);

          // A non-driver Employee needs no Driver record.
          await sql`insert into employees(company_id,employee_role_id,employee_number,name_en,mobile_number,basic_salary)
            values(${company}::uuid,${csRole}::uuid,'EMP-000003','Mona','971504445555',3500)`.execute(
            transaction,
          );

          throw rollbackMarker;
        }),
      ).rejects.toBe(rollbackMarker);
    } finally {
      await database.destroy();
    }
  }, 60_000);

  it("changes salary without ending a version before its own start date", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    try {
      await expect(
        database.transaction().execute(async (transaction) => {
          const company = randomUUID();
          const actor = randomUUID();
          await sql`insert into companies(id,code,subdomain,name_en,status,activated_at) values
            (${company}::uuid,${`SV-${company.slice(0, 8)}`},${`sv-${company.slice(0, 8)}`},'Salary Test','active',now())`.execute(
            transaction,
          );
          await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
            values(${actor}::uuid,${company}::uuid,'company_user',${`sv.${actor}`},'x')`.execute(
            transaction,
          );
          const employee = randomUUID();
          await sql`insert into employees(id,company_id,employee_number,name_en,mobile_number,basic_salary)
            values(${employee}::uuid,${company}::uuid,'EMP-000001','Test','971501234567',1000)`.execute(
            transaction,
          );
          await sql`insert into employee_salary_versions(company_id,employee_id,basic_salary,effective_from,created_by_account_id)
            values(${company}::uuid,${employee}::uuid,1000,current_date,${actor}::uuid)`.execute(
            transaction,
          );

          // The same-day edit updates the open version in place rather than
          // end-dating it to before its own start (which raised 23514).
          const sameDay = await sql<{ id: string }>`
            select id from employee_salary_versions
             where company_id=${company}::uuid and employee_id=${employee}::uuid
               and effective_from=current_date
          `.execute(transaction);
          await sql`update employee_salary_versions set basic_salary=1200
             where id=${sameDay.rows[0]!.id}::uuid and company_id=${company}::uuid`.execute(
            transaction,
          );

          const versions = await sql<{ fee: string; open: boolean }>`
            select basic_salary::text as fee, effective_to is null as open
              from employee_salary_versions
             where company_id=${company}::uuid and employee_id=${employee}::uuid
          `.execute(transaction);
          expect(versions.rows).toEqual([{ fee: "1200.00", open: true }]);

          throw rollbackMarker;
        }),
      ).rejects.toBe(rollbackMarker);
    } finally {
      await database.destroy();
    }
  }, 60_000);
});
