import { randomUUID } from "node:crypto";

import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect } from "kysely";
import { Logger } from "nestjs-pino";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApiExceptionFilter } from "../presentation/errors/api-exception.filter.js";
import { CompanyHostResolver } from "../tenancy/company-host-resolver.js";
import {
  assertDisposableDatabase,
  AUDIT_TABLES,
  CONFIGURATION_TABLES,
  fingerprint,
  MASTER_TABLES,
  type ResetFixture,
  seedResetCompany,
  USER_TABLES,
  WORKFORCE_TABLES,
} from "./company-data-reset.fixture.js";
import { PLATFORM_SUPER_ADMIN_ROLE_CODE } from "./platform-authorization.js";

/**
 * Company Data Reset over HTTP (Company Data Reset, Prompt 1). COMMITS on a
 * DISPOSABLE database only (hard name guard): preview -> execute exactly the
 * previewed plan, with a verified pg_dump backup, inside one transaction.
 * Enable with RUN_RESET_DATABASE=true.
 */

const runDatabase = process.env.RUN_RESET_DATABASE === "true";

describe.skipIf(!runDatabase)("Company Data Reset HTTP (disposable, committed)", () => {
  let pool: pg.Pool;
  let db: Kysely<DatabaseSchema>;
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  let adminCookie = "";
  let readerCookie = "";
  let a: ResetFixture;
  let b: ResetFixture;

  const count = async (text: string, values: unknown[]) =>
    Number(Object.values((await pool.query<Record<string, string>>(text, values)).rows[0] ?? {})[0] ?? 0);
  const base = (companyId: string) => `/api/v1/platform/companies/${companyId}/data-reset`;
  const post = (path: string, body: object, cookie = adminCookie) =>
    request(server).post(path).set("Cookie", cookie).set("X-Blueline-Session", "cookie").send(body);

  beforeAll(async () => {
    assertDisposableDatabase(process.env.DATABASE_URL);
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const client = await pool.connect();
    try {
      await client.query("begin");
      a = await seedResetCompany(client, "HA", { driverHistory: false });
      b = await seedResetCompany(client, "HB", { driverHistory: false });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue(db)
      .overrideProvider(CompanyHostResolver)
      .useValue({ isReservedHost: () => false, resolve: (host: string | undefined) => host?.split(".")[0] })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(new ValidationPipe({ forbidNonWhitelisted: true, stopAtFirstError: false, transform: true, whitelist: true }));
    app.useGlobalFilters(new ApiExceptionFilter(app.get(Logger)));
    await app.init();
    server = app.getHttpServer() as Parameters<typeof request>[0];

    const suffix = randomUUID().slice(0, 8);
    const password = "company-data-reset-password";
    const hash = await new PasswordHasher().hash(password);
    const adminId = randomUUID();
    const readerId = randomUUID();
    await pool.query(
      `insert into accounts (id, company_id, account_kind, username, password_hash, status, password_changed_at)
       values ($1, null, 'platform_administrator', $3, $5, 'active', now()), ($2, null, 'platform_administrator', $4, $5, 'active', now())`,
      [adminId, readerId, `cdr.admin.${suffix}`, `cdr.reader.${suffix}`, hash],
    );
    const superRole = (await pool.query<{ id: string }>("select id from roles where company_id is null and lower(code) = $1", [PLATFORM_SUPER_ADMIN_ROLE_CODE])).rows[0]!;
    await pool.query("insert into account_roles (account_id, role_id, company_id) values ($1, $2, null)", [adminId, superRole.id]);
    const readRole = randomUUID();
    const roleClient = await pool.connect();
    try {
      await roleClient.query("begin");
      await roleClient.query("insert into roles (id, company_id, code, name, is_system) values ($1, null, $2, $3, false)", [readRole, `cdr_reader_${suffix}`, `CDR Reader ${suffix}`]);
      await roleClient.query("insert into role_permissions (role_id, permission_code) values ($1, 'platform.access'), ($1, 'platform.companies.read')", [readRole]);
      await roleClient.query("commit");
    } finally {
      roleClient.release();
    }
    await pool.query("insert into account_roles (account_id, role_id, company_id) values ($1, $2, null)", [readerId, readRole]);
    const signIn = async (username: string) => {
      const response = await request(server).post("/api/v1/platform/auth/login").send({ identifier: username, password }).expect(200);
      return (response.headers["set-cookie"] as unknown as string[])[0]?.split(";")[0] ?? "";
    };
    adminCookie = await signIn(`cdr.admin.${suffix}`);
    readerCookie = await signIn(`cdr.reader.${suffix}`);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  it("security: reset permission required, anonymous 401, unknown Company 404, strict validation", async () => {
    await post(`${base(a.company)}/preview`, { preset: "OPERATIONAL_DATA" }, readerCookie).expect(403);
    await request(server).post(`${base(a.company)}/preview`).send({ preset: "OPERATIONAL_DATA" }).expect(401);
    await post(`${base(randomUUID())}/preview`, { preset: "OPERATIONAL_DATA" }).expect(404);
    await post(`${base(a.company)}/preview`, { preset: "DROP_EVERYTHING" }).expect(400);
    await post(`${base(a.company)}/preview`, { preset: "OPERATIONAL_DATA", sql: "delete from orders" }).expect(400);
    const implied = await post(`${base(a.company)}/preview`, { preset: "OPERATIONAL_DATA", userMode: "DELETE_ALL_ELIGIBLE_USERS" }).expect(400);
    expect(JSON.stringify(implied.body)).toContain("reset_request_invalid");
    await post(`${base(a.company)}/execute`, { confirmation: `RESET ${a.code}`, planVersion: `crp1:${"0".repeat(64)}`, preset: "OPERATIONAL_DATA" }, readerCookie).expect(403);
  });

  it("preview is read-only and deterministic; a wrong confirmation or a stale plan is refused with nothing changed (Prompt 3: plus one failure-evidence audit row)", async () => {
    const tables = [...USER_TABLES, ...WORKFORCE_TABLES, ...MASTER_TABLES, ...CONFIGURATION_TABLES, ...AUDIT_TABLES.filter((t) => t !== "audit_events"), "orders"];
    const auditNotFailure = "select count(*) from audit_events where company_id = $1 and action <> 'platform.company.data_reset.failed'";
    const client = await pool.connect();
    try {
      const before = await fingerprint(client, a.company, tables);
      const auditBefore = await count(auditNotFailure, [a.company]);
      const first = await post(`${base(a.company)}/preview`, { preset: "OPERATIONAL_DATA" }).expect(200);
      const second = await post(`${base(a.company)}/preview`, { preset: "OPERATIONAL_DATA" }).expect(200);
      expect(first.body.planVersion).toBe(second.body.planVersion);
      expect(first.body).toMatchObject({ effectiveDomains: ["OPERATIONAL"], executable: true, summary: { orders: { delete: 1 }, platformRepairExecutions: "PRESERVE" } });
      await post(`${base(a.company)}/execute`, { confirmation: "RESET WRONG", planVersion: first.body.planVersion, preset: "OPERATIONAL_DATA" }).expect(400);
      const stale = await post(`${base(a.company)}/execute`, { confirmation: `RESET ${a.code}`, planVersion: `crp1:${"0".repeat(64)}`, preset: "OPERATIONAL_DATA" }).expect(409);
      expect(JSON.stringify(stale.body)).toContain("reset_plan_stale");
      expect(await fingerprint(client, a.company, tables)).toEqual(before);
      expect(await count(auditNotFailure, [a.company])).toBe(auditBefore);
      expect(
        await count(
          "select count(*) from audit_events where company_id = $1 and action = 'platform.company.data_reset.failed' and result = 'failure' and failure_reason = 'reset_plan_stale'",
          [a.company],
        ),
      ).toBe(1);
    } finally {
      client.release();
    }
  });

  it("CASES 6 + 7 (Prompt 2): the legacy reset-execute and users-reset-execute request shapes are RETIRED -- 410 company_reset_retired, zero mutation, no user deleted", async () => {
    const tables = [...USER_TABLES, ...WORKFORCE_TABLES, ...MASTER_TABLES, ...CONFIGURATION_TABLES, ...AUDIT_TABLES, "orders", "journal_entries"];
    const legacy = (route: string) => `/api/v1/platform/companies/${a.company}/${route}`;
    const client = await pool.connect();
    try {
      const before = await fingerprint(client, a.company, tables);
      const bBefore = await fingerprint(client, b.company, tables);
      // CASE 6: the exact legacy body (confirmation only, no user mode) and an empty body.
      for (const body of [{ confirmation: `RESET ${a.code}` }, {}]) {
        const response = await post(legacy("reset-execute"), body).expect(410);
        expect(response.body).toMatchObject({ error: { code: "company_reset_retired" } });
        expect(JSON.stringify(response.body)).toContain("data-reset/preview");
      }
      // CASE 7: the exact legacy users-only body selecting a real deletable user.
      const users = await post(legacy("users-reset-execute"), { accountIds: [a.employeeUser], confirmation: `RESET USERS ${a.code}` }).expect(410);
      expect(users.body).toMatchObject({ error: { code: "company_reset_retired" } });
      // Still behind the reset permission (403 for a reader), never a mutation.
      await post(legacy("reset-execute"), { confirmation: `RESET ${a.code}` }, readerCookie).expect(403);
      await post(legacy("users-reset-execute"), { accountIds: [a.employeeUser] }, readerCookie).expect(403);
      expect(await fingerprint(client, a.company, tables)).toEqual(before);
      expect(await fingerprint(client, b.company, tables)).toEqual(bBefore);
      expect(await count("select count(*) from accounts where id = $1", [a.employeeUser])).toBe(1);
      // The read-only legacy previews still answer (no mutation).
      await request(server).get(legacy("reset-preview")).set("Cookie", adminCookie).set("X-Blueline-Session", "cookie").expect(200);
      expect(await fingerprint(client, a.company, tables)).toEqual(before);
    } finally {
      client.release();
    }
  });

  it("execute OPERATIONAL_DATA commits: orders removed; users, workforce, masters, configuration and Platform audit kept; reset audited; Company B unchanged", async () => {
    const client = await pool.connect();
    try {
      const kept = [...USER_TABLES, ...WORKFORCE_TABLES, ...MASTER_TABLES, ...CONFIGURATION_TABLES, "platform_repair_executions", "platform_repair_attempts"];
      const bTables = [...kept, "orders", "journal_entries", "audit_events"];
      const keptBefore = await fingerprint(client, a.company, kept);
      const bBefore = await fingerprint(client, b.company, bTables);
      const preview = await post(`${base(a.company)}/preview`, { preset: "OPERATIONAL_DATA" }).expect(200);
      const result = await post(`${base(a.company)}/execute`, { confirmation: `RESET ${a.code}`, planVersion: preview.body.planVersion, preset: "OPERATIONAL_DATA" }).expect(200);
      expect(result.body).toMatchObject({ effectiveDomains: ["OPERATIONAL"], identitiesDeleted: 0, planVersion: preview.body.planVersion });
      expect(result.body.backupFile).toMatch(/^company-data-reset-.*\.dump$/u);
      expect(result.body.integrityChecks).toEqual(expect.arrayContaining(["company preserved", "repair executions preserved", "removal set empty"]));
      expect(await count("select count(*) from orders where company_id = $1", [a.company])).toBe(0);
      expect(await fingerprint(client, a.company, kept)).toEqual(keptBefore);
      expect(await count("select count(*) from audit_events where company_id = $1 and action = 'platform.company.data_reset.planned'", [a.company])).toBe(1);
      expect(await fingerprint(client, b.company, bTables)).toEqual(bBefore);
    } finally {
      client.release();
    }
  });

  it("execute DELETE_SELECTED_USERS (Employee user) commits exactly the preview: user + Employee removed, Admin link cleaned, everyone else kept", async () => {
    const body = { preset: "USERS_WORKFORCE", selectedAccountIds: [a.employeeUser], userMode: "DELETE_SELECTED_USERS" };
    const preview = await post(`${base(a.company)}/preview`, body).expect(200);
    const employee = preview.body.users.find((user: { accountId: string }) => user.accountId === a.employeeUser);
    expect(employee).toMatchObject({ employee: { action: "DELETE", reference: "EMP-0001" }, identity: { action: "DELETE" }, remove: true });
    const result = await post(`${base(a.company)}/execute`, { ...body, confirmation: `RESET ${a.code}`, planVersion: preview.body.planVersion }).expect(200);
    expect(result.body).toMatchObject({ employeesDeleted: 1, entityLinksRemoved: 1, identitiesDeleted: 1 });
    expect(await count("select count(*) from accounts where id = $1", [a.employeeUser])).toBe(0);
    expect(await count("select count(*) from employees where id = $1", [a.employee])).toBe(0);
    expect(await count("select count(*) from accounts where id = any($1::uuid[]) and status = 'active'", [[a.admin, a.ordinaryUser, a.driverUser, a.driverUserNoHistory]])).toBe(4);
    expect(await count("select count(*) from user_business_links where company_id = $1 and entity_type = 'employee'", [a.company])).toBe(0);
  });

  it("a blocked plan is refused at execution (selected Platform administrator)", async () => {
    const platformAdmin = (await pool.query<{ id: string }>("select id from accounts where account_kind = 'platform_administrator' order by created_at limit 1")).rows[0]!.id;
    const body = { preset: "USERS_WORKFORCE", selectedAccountIds: [platformAdmin], userMode: "DELETE_SELECTED_USERS" };
    const preview = await post(`${base(a.company)}/preview`, body).expect(200);
    expect(preview.body.executable).toBe(false);
    expect(preview.body.users.find((user: { accountId: string }) => user.accountId === platformAdmin).classification).toBe("PROTECTED_PLATFORM_ADMIN");
    const refused = await post(`${base(a.company)}/execute`, { ...body, confirmation: `RESET ${a.code}`, planVersion: preview.body.planVersion }).expect(409);
    expect(JSON.stringify(refused.body)).toContain("reset_plan_blocked");
    expect(await count("select count(*) from accounts where id = $1", [platformAdmin])).toBe(1);
  });
});
