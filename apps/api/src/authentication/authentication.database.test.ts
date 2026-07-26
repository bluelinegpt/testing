import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { ConfigService } from "@nestjs/config";
import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import type { AppConfiguration } from "../configuration/environment.js";
import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { AuthenticationRepository } from "./authentication.repository.js";
import { AuthenticationService } from "./authentication.service.js";
import { PasswordHasher } from "./password-hasher.js";
import { SessionTokenService } from "./session-token.service.js";

const runDatabaseTests = process.env.RUN_DATABASE_INTEGRATION === "true";
const rollback = Symbol("rollback authentication test");

describe.skipIf(!runDatabaseTests)("authentication PostgreSQL integration", () => {
  it("isolates equal usernames by Company and revalidates sessions", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    try {
      await expect(
        database.transaction().execute(async (transaction) => {
          const companyA = randomUUID(),
            companyB = randomUUID(),
            accountA = randomUUID(),
            accountB = randomUUID(),
            roleA = randomUUID(),
            roleB = randomUUID(),
            suffix = randomUUID().slice(0, 8);
          const hasher = new PasswordHasher();
          const [passwordA, passwordB] = await Promise.all([
            hasher.hash("Company-A-password"),
            hasher.hash("Company-B-password"),
          ]);
          await sql`insert into companies(id,code,subdomain,name_en,status)values(${companyA}::uuid,${`AUTH-A-${suffix}`},${`auth-a-${suffix}`},'Auth A','active'),(${companyB}::uuid,${`AUTH-B-${suffix}`},${`auth-b-${suffix}`},'Auth B','active')`.execute(
            transaction,
          );
          await sql`insert into roles(id,company_id,code,name,is_active)values(${roleA}::uuid,${companyA}::uuid,'auth_a','Auth A',true),(${roleB}::uuid,${companyB}::uuid,'auth_b','Auth B',true)`.execute(
            transaction,
          );
          await sql`insert into role_permissions(role_id,permission_code)values(${roleA}::uuid,'orders.create'),(${roleB}::uuid,'reports.export')`.execute(
            transaction,
          );
          await sql`insert into accounts(id,company_id,account_kind,username,email,mobile_number,password_hash,status)values(${accountA}::uuid,${companyA}::uuid,'company_user','operator','operator@example.test','971501234567',${passwordA},'active'),(${accountB}::uuid,${companyB}::uuid,'company_user','operator','operator@example.test','971501234567',${passwordB},'active')`.execute(
            transaction,
          );
          await sql`insert into company_users(company_id,account_id,name_en,display_name,email,mobile_number,is_active)values(${companyA}::uuid,${accountA}::uuid,'Operator A','Operator A','operator@example.test','971501234567',true),(${companyB}::uuid,${accountB}::uuid,'Operator B','Operator B','operator@example.test','971501234567',true)`.execute(
            transaction,
          );
          await sql`insert into account_roles(account_id,role_id,company_id)values(${accountA}::uuid,${roleA}::uuid,${companyA}::uuid),(${accountB}::uuid,${roleB}::uuid,${companyB}::uuid)`.execute(
            transaction,
          );
          const repository = new AuthenticationRepository(
            transaction as unknown as Kysely<DatabaseSchema>,
          );
          const config = {
            get: (key: string) => (key === "auth.lockoutMinutes" ? 15 : 720),
          } as unknown as ConfigService<AppConfiguration, true>;
          const service = new AuthenticationService(
            repository,
            hasher,
            new SessionTokenService(),
            config,
          );
          await expect(
            service.loginCompany({
              companySubdomain: `auth-b-${suffix}`,
              password: "Company-A-password",
              identifier: "operator",
            }),
          ).rejects.toMatchObject({ errorCode: "invalid_credentials" });
          await expect(
            service.loginCompany({
              companySubdomain: `auth-a-${suffix}`,
              identifier: "operator",
              password: "company-a-password",
            }),
          ).rejects.toMatchObject({ errorCode: "invalid_credentials" });
          const loginA = await service.loginCompany({
            companySubdomain: `auth-a-${suffix}`,
            password: "Company-A-password",
            identifier: "OPERATOR",
          });
          const loginB = await service.loginCompany({
            companySubdomain: `auth-b-${suffix}`,
            password: "Company-B-password",
            identifier: "operator",
          });
          expect(loginA.identity).toMatchObject({
            companyId: companyA,
            permissions: ["orders.create"],
          });
          expect(loginB.identity).toMatchObject({
            companyId: companyB,
            permissions: ["reports.export"],
          });
          for (const identifier of [
            "Operator@Example.Test",
            "0501234567",
            "971501234567",
            "+971501234567",
          ]) {
            const login = await service.loginCompany({
              companySubdomain: `auth-a-${suffix}`,
              identifier,
              password: "Company-A-password",
            });
            expect(login.identity.id).toBe(accountA);
          }
          const identity = await service.authenticate(loginA.accessToken);
          expect(identity.companyId).toBe(companyA);
          await service.logout(identity);
          await expect(service.authenticate(loginA.accessToken)).rejects.toMatchObject({
            errorCode: "invalid_session",
          });
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    } finally {
      await database.destroy();
    }
  });
});
