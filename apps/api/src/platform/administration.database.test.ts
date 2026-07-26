import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import request from "supertest";

import { AppModule } from "../app.module.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import { configuration } from "../configuration/environment.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { CompanyHostResolver } from "../tenancy/company-host-resolver.js";
import { bootstrapPlatformAdministratorInTransaction } from "./platform-administrator-bootstrap.js";

const runDatabaseTests = process.env.RUN_ADMINISTRATION_INTEGRATION === "true";
const rollbackMarker = Symbol("rollback administration integration test");

describe.skipIf(!runDatabaseTests)("administration PostgreSQL integration", () => {
  it("bootstraps once and keeps Company role administration isolated", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });

    try {
      await database.transaction().execute(async (transaction) => {
        const module = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(DATABASE)
          .useValue(transaction)
          .overrideProvider(KyselyTransactionManager)
          .useValue({
            execute: (work: (value: typeof transaction) => unknown) => work(transaction),
          })
          .overrideProvider(CompanyHostResolver)
          .useValue({
            resolve: (host: string | undefined) => host?.split(".")[0],
          })
          .compile();
        let app: INestApplication | undefined;
        try {
          app = module.createNestApplication();
          app.setGlobalPrefix("api/v1");
          app.useGlobalPipes(
            new ValidationPipe({ forbidNonWhitelisted: true, transform: true, whitelist: true }),
          );
          await app.init();

          const hasher = new PasswordHasher();
          const platformPassword = "Rollback-platform-password";
          const platformHash = await hasher.hash(platformPassword);
          await bootstrapPlatformAdministratorInTransaction(
            transaction,
            "platform.admin",
            platformHash,
          );
          await expect(
            bootstrapPlatformAdministratorInTransaction(
              transaction,
              "second.platform.admin",
              platformHash,
            ),
          ).rejects.toThrow("already been completed");

          const companyA = randomUUID();
          const companyB = randomUUID();
          const accountA = randomUUID();
          const employeeA = randomUUID();
          const accountB = randomUUID();
          const managerRoleA = randomUUID();
          const managerRoleB = randomUUID();
          const suffix = companyA.slice(0, 8);
          const subdomainA = `admin-a-${suffix}`;
          const subdomainB = `admin-b-${suffix}`;
          const [passwordA, employeePasswordA, passwordB] = await Promise.all([
            hasher.hash("Rollback-company-A-password"),
            hasher.hash("Rollback-employee-A-password"),
            hasher.hash("Rollback-company-B-password"),
          ]);
          await sql`
            insert into companies (id, code, subdomain, name_en, status, activated_at) values
              (${companyA}::uuid, ${`ADMIN-A-${suffix}`}, ${subdomainA}, 'Admin Company A', 'active', now()),
              (${companyB}::uuid, ${`ADMIN-B-${suffix}`}, ${subdomainB}, 'Admin Company B', 'active', now())
          `.execute(transaction);
          await sql`
            insert into accounts (id, company_id, account_kind, username, password_hash) values
              (${accountA}::uuid, ${companyA}::uuid, 'company_user', 'administrator', ${passwordA}),
              (${employeeA}::uuid, ${companyA}::uuid, 'company_user', 'employee', ${employeePasswordA}),
              (${accountB}::uuid, ${companyB}::uuid, 'company_user', 'administrator', ${passwordB})
          `.execute(transaction);
          await sql`
            insert into company_users (company_id, account_id, name_en, display_name) values
              (${companyA}::uuid, ${accountA}::uuid, 'Administrator A', 'Administrator A'),
              (${companyA}::uuid, ${employeeA}::uuid, 'Employee A', 'Employee A'),
              (${companyB}::uuid, ${accountB}::uuid, 'Administrator B', 'Administrator B')
          `.execute(transaction);
          await sql`
            insert into roles (id, company_id, code, name, is_system) values
              (${managerRoleA}::uuid, ${companyA}::uuid, 'company_admin', 'Company Administrator', true),
              (${managerRoleB}::uuid, ${companyB}::uuid, 'company_admin', 'Company Administrator', true)
          `.execute(transaction);
          await sql`
            insert into role_permissions (role_id, permission_code) values
              (${managerRoleA}::uuid, 'users_roles.manage'),
              (${managerRoleB}::uuid, 'users_roles.manage')
          `.execute(transaction);
          await sql`
            insert into account_roles (account_id, role_id, company_id) values
              (${accountA}::uuid, ${managerRoleA}::uuid, ${companyA}::uuid),
              (${accountB}::uuid, ${managerRoleB}::uuid, ${companyB}::uuid)
          `.execute(transaction);

          const loginCompany = async (subdomain: string, password: string): Promise<string> => {
            const response = await request(app!.getHttpServer())
              .post("/api/v1/auth/login")
              .set("Host", `${subdomain}.blueline.test`)
              .send({ identifier: "administrator", password })
              .expect(200);
            return String(response.body.accessToken);
          };
          const [tokenA, tokenB] = await Promise.all([
            loginCompany(subdomainA, "Rollback-company-A-password"),
            loginCompany(subdomainB, "Rollback-company-B-password"),
          ]);
          const platformLogin = await request(app.getHttpServer())
            .post("/api/v1/platform/auth/login")
            .send({ identifier: "platform.admin", password: platformPassword })
            .expect(200);
          const platformToken = String(platformLogin.body.accessToken);

          await request(app.getHttpServer())
            .post("/api/v1/roles")
            .set("Authorization", `Bearer ${platformToken}`)
            .send({ isActive: true, name: "Dispatcher", permissions: ["orders.create"] })
            .expect(403);
          const roleA = await request(app.getHttpServer())
            .post("/api/v1/roles")
            .set("Authorization", `Bearer ${tokenA}`)
            .send({ isActive: true, name: "Dispatcher A", permissions: ["orders.create"] })
            .expect(201);
          const roleB = await request(app.getHttpServer())
            .post("/api/v1/roles")
            .set("Authorization", `Bearer ${tokenB}`)
            .send({ isActive: true, name: "Dispatcher B", permissions: ["orders.create"] })
            .expect(201);
          expect(roleA.body.id).not.toBe(roleB.body.id);

          await request(app.getHttpServer())
            .patch(`/api/v1/roles/${managerRoleA}`)
            .set("Authorization", `Bearer ${tokenA}`)
            .send({ name: "Mutated System Administrator" })
            .expect(409);
          await request(app.getHttpServer())
            .patch(`/api/v1/roles/${String(roleB.body.id)}`)
            .set("Authorization", `Bearer ${tokenA}`)
            .send({ name: "Cross Company Mutation" })
            .expect(404);
          const updatedRoleA = await request(app.getHttpServer())
            .patch(`/api/v1/roles/${String(roleA.body.id)}`)
            .set("Authorization", `Bearer ${tokenA}`)
            .send({ name: "Dispatch Operations", permissions: ["orders.assign_driver"] })
            .expect(200);
          expect(updatedRoleA.body).toMatchObject({
            id: roleA.body.id,
            name: "Dispatch Operations",
            permissions: ["orders.assign_driver"],
          });

          await request(app.getHttpServer())
            .put(`/api/v1/users/${accountA}/roles`)
            .set("Authorization", `Bearer ${tokenA}`)
            .send({ roleIds: [] })
            .expect(400);
          await request(app.getHttpServer())
            .put(`/api/v1/users/${employeeA}/roles`)
            .set("Authorization", `Bearer ${tokenA}`)
            .send({ roleIds: [roleB.body.id] })
            .expect(400);
          await request(app.getHttpServer())
            .put(`/api/v1/users/${employeeA}/roles`)
            .set("Authorization", `Bearer ${tokenA}`)
            .send({ roleIds: [roleA.body.id] })
            .expect(204);
          await request(app.getHttpServer())
            .post(`/api/v1/users/${accountB}/unlock`)
            .set("Authorization", `Bearer ${tokenA}`)
            .expect(404);

          await sql`
            update accounts set failed_login_attempts = 5, locked_until = now() + interval '1 hour'
             where id = ${employeeA}::uuid
          `.execute(transaction);
          await request(app.getHttpServer())
            .post(`/api/v1/users/${employeeA}/unlock`)
            .set("Authorization", `Bearer ${tokenA}`)
            .expect(204);
          const employeeLogin = await request(app.getHttpServer())
            .post("/api/v1/auth/login")
            .set("Host", `${subdomainA}.blueline.test`)
            .send({
              password: "Rollback-employee-A-password",
              identifier: "employee",
            })
            .expect(200);
          const employeeToken = String(employeeLogin.body.accessToken);

          await request(app.getHttpServer())
            .get("/api/v1/users")
            .set("Authorization", `Bearer ${employeeToken}`)
            .expect(403);
          await request(app.getHttpServer())
            .get("/api/v1/operations/orders")
            .set("Authorization", `Bearer ${employeeToken}`)
            .expect(200);

          const usersA = await request(app.getHttpServer())
            .get("/api/v1/users")
            .set("Authorization", `Bearer ${tokenA}`)
            .expect(200);
          expect(usersA.body.items).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ accountId: employeeA, displayName: "Employee A" }),
            ]),
          );
          expect(usersA.body.items).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ accountId: accountB })]),
          );

          await request(app.getHttpServer())
            .post(`/api/v1/users/${accountA}/deactivate`)
            .set("Authorization", `Bearer ${tokenA}`)
            .send({ reason: "Self deactivation test" })
            .expect(409);
          await request(app.getHttpServer())
            .post(`/api/v1/users/${employeeA}/deactivate`)
            .set("Authorization", `Bearer ${tokenA}`)
            .send({ reason: "Employment ended during integration verification" })
            .expect(204);
          await request(app.getHttpServer())
            .get("/api/v1/auth/me")
            .set("Authorization", `Bearer ${employeeToken}`)
            .expect(401);

          const listA = await request(app.getHttpServer())
            .get("/api/v1/roles")
            .set("Authorization", `Bearer ${tokenA}`)
            .expect(200);
          const listB = await request(app.getHttpServer())
            .get("/api/v1/roles")
            .set("Authorization", `Bearer ${tokenB}`)
            .expect(200);
          expect(listA.body.items).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: roleA.body.id, name: "Dispatch Operations" }),
            ]),
          );
          expect(listA.body.items).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ id: roleB.body.id })]),
          );
          expect(listB.body.items).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: roleB.body.id, name: "Dispatcher B" }),
            ]),
          );

          const audit = await sql<{ action: string; companyId: string; count: number }>`
            select action, company_id as "companyId", count(*)::int as count
              from audit_events
             where action in (
               'role.create', 'role.update', 'company_user.roles_assign',
               'company_user.unlock', 'company_user.deactivate'
             )
             group by action, company_id
          `.execute(transaction);
          expect(audit.rows).toEqual(
            expect.arrayContaining([
              { action: "role.create", companyId: companyA, count: 1 },
              { action: "role.create", companyId: companyB, count: 1 },
              { action: "role.update", companyId: companyA, count: 1 },
              { action: "company_user.roles_assign", companyId: companyA, count: 1 },
              { action: "company_user.unlock", companyId: companyA, count: 1 },
              { action: "company_user.deactivate", companyId: companyA, count: 1 },
            ]),
          );
        } finally {
          await app?.close();
        }
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
