import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { Test } from "@nestjs/testing";
import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import { AppModule } from "../app.module.js";
import { configuration } from "../configuration/environment.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";

import {
  inspectFixture,
  PartialFixtureError,
  seedReconciliationDemo,
} from "./reconciliation-demo-seed.js";

const runDatabaseTests = process.env.RUN_FIXTURE_DATABASE === "true";
const rollbackMarker = Symbol("rollback fixture seed test");

/**
 * Everything runs inside one rolled-back transaction, so the live development
 * fixture (32 working Orders) is never modified.
 */
describe.skipIf(!runDatabaseTests)("reconciliation demonstration fixture", () => {
  it("guards the environment, Company and fixture state, and seeds correctly", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const originalEnvironment = process.env.NODE_ENV;

    try {
      await database.transaction().execute(async (transaction) => {
        const module = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(DATABASE)
          .useValue(transaction)
          .overrideProvider(KyselyTransactionManager)
          .useValue({
            execute: (work: (value: typeof transaction) => unknown) => work(transaction),
          })
          .compile();
        const context = await module.init();

        try {
          const suffix = randomUUID().slice(0, 8);
          const subdomain = `fixture-${suffix}`;
          const otherSubdomain = `other-${suffix}`;

          const makeCompany = async (sub: string, status: string): Promise<string> => {
            const companyId = randomUUID();
            const accountId = randomUUID();
            const roleId = randomUUID();
            await sql`
              insert into companies (id, code, subdomain, name_en, status, activated_at)
              values (${companyId}::uuid, ${`FIX-${companyId.slice(0, 8).toUpperCase()}`}, ${sub}, 'Fixture Co',
                      ${status}, now())
            `.execute(transaction);
            await sql`
              insert into accounts (id, company_id, account_kind, username, password_hash, status)
              values (${accountId}::uuid, ${companyId}::uuid, 'company_user',
                      ${`fix.admin.${sub}`}, 'x', 'active')
            `.execute(transaction);
            await sql`
              insert into company_users (company_id, account_id, display_name, name_en)
              values (${companyId}::uuid, ${accountId}::uuid, 'Fixture Admin', 'Fixture Admin')
            `.execute(transaction);
            await sql`
              insert into roles (id, company_id, code, name, is_system)
              values (${roleId}::uuid, ${companyId}::uuid, 'company_admin', ${`Role ${sub}`}, true)
            `.execute(transaction);
            await sql`
              insert into role_permissions (role_id, permission_code) values
                (${roleId}::uuid, 'users_roles.manage'),
                (${roleId}::uuid, 'orders.assign_driver'),
                (${roleId}::uuid, 'orders.update_delivery_status')
            `.execute(transaction);
            await sql`
              insert into account_roles (account_id, role_id, company_id)
              values (${accountId}::uuid, ${roleId}::uuid, ${companyId}::uuid)
            `.execute(transaction);
            return companyId;
          };

          const companyId = await makeCompany(subdomain, "active");
          const otherCompanyId = await makeCompany(otherSubdomain, "active");
          const disabledSubdomain = `disabled-${suffix}`;
          await makeCompany(disabledSubdomain, "disabled");

          // 1 + 2. Environment refusal.
          process.env.NODE_ENV = "production";
          await expect(seedReconciliationDemo(context, { subdomain })).rejects.toThrow(
            /Refusing to seed demonstration data in production/,
          );
          process.env.NODE_ENV = "staging";
          await expect(seedReconciliationDemo(context, { subdomain })).rejects.toThrow(
            /Refusing to seed demonstration data/,
          );
          process.env.NODE_ENV = originalEnvironment ?? "development";

          // 3. Explicit subdomain required.
          await expect(seedReconciliationDemo(context, { subdomain: "  " })).rejects.toThrow(
            /Company subdomain is required/,
          );
          // 4. Unknown Company.
          await expect(
            seedReconciliationDemo(context, { subdomain: `missing-${suffix}` }),
          ).rejects.toThrow(/No Company found/);
          // 5. Disabled Company.
          await expect(
            seedReconciliationDemo(context, { subdomain: disabledSubdomain }),
          ).rejects.toThrow(/is not active/);

          // 7-11. Seeding the fixture.
          const result = await seedReconciliationDemo(context, { subdomain });
          expect(result.alreadyPresent).toBe(false);
          expect(result.companyId).toBe(companyId);
          expect(result.deliveredPendingOrders).toBe(32);
          expect(result.orderNumbers).toHaveLength(32);

          const orders = await sql<{
            assigned: string | null;
            cash: string;
            delivery: string;
            fee: string | null;
          }>`
            select delivery_status as delivery, driver_reconciliation_status as cash,
                   assigned_driver_id as assigned, final_service_fee_snapshot::text as fee
              from orders where company_id = ${companyId}::uuid
          `.execute(transaction);
          expect(orders.rows).toHaveLength(32);
          // 8 + 9.
          expect(orders.rows.every((row) => row.delivery === "delivered")).toBe(true);
          expect(orders.rows.every((row) => row.cash === "pending")).toBe(true);
          // 10.
          expect(new Set(orders.rows.map((row) => row.assigned))).toEqual(
            new Set([result.driverId]),
          );
          // 11. Pricing snapshots captured on every Order.
          expect(orders.rows.every((row) => row.fee !== null)).toBe(true);

          // 12. Full status history chain.
          const history = await sql<{ status: string }>`
            select distinct to_status as status from order_status_history
             where company_id = ${companyId}::uuid and status_dimension = 'delivery'
          `.execute(transaction);
          const statuses = new Set(history.rows.map((row) => row.status));
          for (const expected of ["assigned_to_driver", "out_for_delivery", "delivered"]) {
            expect(statuses).toContain(expected);
          }

          // 13. Events and audit records exist.
          const events = await sql<{ value: number }>`
            select count(*)::int as value from order_events where company_id = ${companyId}::uuid
          `.execute(transaction);
          expect(events.rows[0]?.value ?? 0).toBeGreaterThan(0);
          const audits = await sql<{ value: number }>`
            select count(*)::int as value from audit_events where company_id = ${companyId}::uuid
          `.execute(transaction);
          expect(audits.rows[0]?.value ?? 0).toBeGreaterThan(0);

          // 14. No reconciliation was created.
          const reconciliations = await sql<{ value: number }>`
            select count(*)::int as value from driver_reconciliations
             where company_id = ${companyId}::uuid
          `.execute(transaction);
          expect(reconciliations.rows[0]?.value).toBe(0);

          // 15 + 6. The unrelated Company was untouched.
          const other = await sql<{ areas: number; drivers: number; orders: number }>`
            select
              (select count(*)::int from orders where company_id = ${otherCompanyId}::uuid) as orders,
              (select count(*)::int from areas where company_id = ${otherCompanyId}::uuid) as areas,
              (select count(*)::int from drivers where company_id = ${otherCompanyId}::uuid)
                as drivers
          `.execute(transaction);
          expect(other.rows[0]).toEqual({ areas: 0, drivers: 0, orders: 0 });

          // 17. The Driver used belongs to this Company only.
          const driverScope = await sql<{ value: number }>`
            select count(*)::int as value from drivers
             where id = ${result.driverId}::uuid and company_id = ${companyId}::uuid
          `.execute(transaction);
          expect(driverScope.rows[0]?.value).toBe(1);
          const foreignDrivers = await sql<{ value: number }>`
            select count(*)::int as value from orders
             where company_id = ${companyId}::uuid
               and assigned_driver_id not in (
                 select id from drivers where company_id = ${companyId}::uuid
               )
          `.execute(transaction);
          expect(foreignDrivers.rows[0]?.value).toBe(0);

          // 16. A complete second execution creates nothing.
          const repeat = await seedReconciliationDemo(context, { subdomain });
          expect(repeat.alreadyPresent).toBe(true);
          const afterRepeat = await sql<{ value: number }>`
            select count(*)::int as value from orders where company_id = ${companyId}::uuid
          `.execute(transaction);
          expect(afterRepeat.rows[0]?.value).toBe(32);

          // Partial state must fail safely rather than silently resuming.
          await sql`
            update orders set driver_reconciliation_status = 'not_applicable'
             where company_id = ${companyId}::uuid
               and id in (select id from orders where company_id = ${companyId}::uuid limit 2)
          `.execute(transaction);
          const partial = await inspectFixture(transaction, companyId);
          expect(partial.state).toBe("partial");
          await expect(seedReconciliationDemo(context, { subdomain })).rejects.toBeInstanceOf(
            PartialFixtureError,
          );
          // The rejected run changed nothing.
          const afterPartial = await sql<{ value: number }>`
            select count(*)::int as value from orders where company_id = ${companyId}::uuid
          `.execute(transaction);
          expect(afterPartial.rows[0]?.value).toBe(32);
          // --resume is accepted for recovery and stays scoped to this Company.
          await seedReconciliationDemo(context, { resume: true, subdomain });
          const afterResume = await sql<{ orders: number; other: number }>`
            select
              (select count(*)::int from orders where company_id = ${companyId}::uuid) as orders,
              (select count(*)::int from orders where company_id = ${otherCompanyId}::uuid) as other
          `.execute(transaction);
          expect(afterResume.rows[0]?.other).toBe(0);
          expect(afterResume.rows[0]?.orders).toBe(32);

          throw rollbackMarker;
        } finally {
          await module.close();
        }
      });
    } catch (error) {
      if (error !== rollbackMarker) throw error;
    } finally {
      process.env.NODE_ENV = originalEnvironment;
      await database.destroy();
    }
  }, 300_000);
});
