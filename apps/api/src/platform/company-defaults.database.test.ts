import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

import {
  defaultEmployeeRoles,
  defaultExpenseTypes,
  seedCompanyDefaults,
  seedStandardEmployeeRoles,
} from "./company-defaults.js";

const runDatabaseTests = process.env.RUN_PROVISIONING_DATABASE === "true";
const rollbackMarker = Symbol("rollback provisioning database test");

interface ExpenseTypeRow {
  code: string;
  displayName: string;
  isActive: boolean;
  nameEn: string;
}

interface EmployeeRoleRow {
  code: string;
  isDriverRole: boolean;
  nameEn: string;
}

describe.skipIf(!runDatabaseTests)("company provisioning defaults", () => {
  it("seeds reconciliation Expense Types idempotently for existing and new Companies", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });

    try {
      // Existing Companies must already carry the seeded types from the migration.
      const existing = await sql<{ companiesWithoutTypes: number }>`
        select count(*)::int as "companiesWithoutTypes"
          from companies company
         where (
           select count(*) from expense_types expense_type
            where expense_type.company_id = company.id
         ) < ${defaultExpenseTypes.length}
      `.execute(database);
      expect(existing.rows[0]?.companiesWithoutTypes).toBe(0);

      await database.transaction().execute(async (transaction) => {
        const companyId = randomUUID();
        const suffix = companyId.slice(0, 8);
        await sql`
          insert into companies (id, code, subdomain, name_en, status, activated_at)
          values (
            ${companyId}::uuid, ${`PROV-${suffix}`}, ${`prov-${suffix}`},
            'Provisioning Test', 'active', now()
          )
        `.execute(transaction);

        const readTypes = async (): Promise<ExpenseTypeRow[]> => {
          const result = await sql<ExpenseTypeRow>`
            select code, display_name as "displayName", name_en as "nameEn",
                   is_active as "isActive"
              from expense_types
             where company_id = ${companyId}::uuid
             order by code
          `.execute(transaction);
          return [...result.rows];
        };

        const readEmployeeRoles = async (): Promise<EmployeeRoleRow[]> => {
          const result = await sql<EmployeeRoleRow>`
            select code, name_en as "nameEn", is_driver_role as "isDriverRole"
              from employee_roles
             where company_id = ${companyId}::uuid
             order by code
          `.execute(transaction);
          return [...result.rows];
        };

        await seedStandardEmployeeRoles(transaction, companyId);
        const employeeRoles = await readEmployeeRoles();
        expect(employeeRoles).toHaveLength(defaultEmployeeRoles.length);
        expect(employeeRoles.filter((role) => role.isDriverRole)).toEqual([
          expect.objectContaining({ code: "DRIVER", nameEn: "Driver" }),
        ]);

        // Re-provisioning neither duplicates the defaults nor overwrites a
        // Company's own display-name customization.
        await sql`update employee_roles set name_en='Delivery Rider'
          where company_id=${companyId}::uuid and code='DRIVER'`.execute(transaction);
        await seedStandardEmployeeRoles(transaction, companyId);
        await seedStandardEmployeeRoles(transaction, companyId);
        const employeeRolesAfterRepeat = await readEmployeeRoles();
        expect(employeeRolesAfterRepeat).toHaveLength(defaultEmployeeRoles.length);
        expect(employeeRolesAfterRepeat.find((role) => role.code === "DRIVER")).toMatchObject({
          isDriverRole: true,
          nameEn: "Delivery Rider",
        });

        // A newly provisioned Company receives exactly the approved types, all active.
        await seedCompanyDefaults(transaction, companyId);
        const seeded = await readTypes();
        expect(seeded.map((row) => row.code)).toEqual(
          [...defaultExpenseTypes].map((expenseType) => expenseType.code).sort(),
        );
        expect(seeded.every((row) => row.isActive)).toBe(true);
        // One Name field: the legacy English column tracks the display Name.
        expect(seeded.every((row) => row.nameEn === row.displayName)).toBe(true);

        // Repeated provisioning must not duplicate rows.
        await seedCompanyDefaults(transaction, companyId);
        await seedCompanyDefaults(transaction, companyId);
        const afterRepeat = await readTypes();
        expect(afterRepeat).toHaveLength(defaultExpenseTypes.length);

        // A Company rename must survive further provisioning runs.
        await sql`
          update expense_types set display_name = 'بنزين'
           where company_id = ${companyId}::uuid and code = 'PETROL'
        `.execute(transaction);
        await seedCompanyDefaults(transaction, companyId);
        const afterRename = await readTypes();
        expect(afterRename).toHaveLength(defaultExpenseTypes.length);
        const petrol = afterRename.find((row) => row.code === "PETROL");
        expect(petrol?.displayName).toBe("بنزين");
        expect(petrol?.nameEn).toBe("بنزين");

        // The internal code is immutable.
        await sql.raw("savepoint provisioning_code").execute(transaction);
        await expect(
          sql`
            update expense_types set code = 'FUEL'
             where company_id = ${companyId}::uuid and code = 'PETROL'
          `.execute(transaction),
        ).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
        await sql.raw("rollback to savepoint provisioning_code").execute(transaction);

        throw rollbackMarker;
      });
    } catch (error) {
      if (error !== rollbackMarker) {
        throw error;
      }
    } finally {
      await database.destroy();
    }
  }, 30_000);
});
