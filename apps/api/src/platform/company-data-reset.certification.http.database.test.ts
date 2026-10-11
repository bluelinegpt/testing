import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect } from "kysely";
import { Logger } from "nestjs-pino";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AppModule } from "../app.module.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApiExceptionFilter } from "../presentation/errors/api-exception.filter.js";
import { CompanyHostResolver } from "../tenancy/company-host-resolver.js";
import { assertDisposableDatabase } from "./company-data-reset.fixture.js";
import { type ScenarioFixture, seedScenarioCompany } from "./company-data-reset.scenario-fixture.js";
import { PLATFORM_SUPER_ADMIN_ROLE_CODE } from "./platform-authorization.js";

/**
 * COMPANY DATA RESET -- Prompt 3 HTTP certification (disposable database,
 * COMMITTED; hard name guard). Enable with RUN_RESET_DATABASE=true.
 *
 *   PERMISSIONS   Super Admin / authorised reset role / Platform user without
 *                 the permission / Company Admin / Company user / anonymous.
 *   DOUBLE SUBMIT two concurrent executions of the same plan: exactly one
 *                 resets; the other and any re-submission get 409 stale.
 *   BACKUP        mandatory verified pg_dump; checksum in the response and in
 *                 the reset audit row; RESTORED into a scratch database and
 *                 the pre-reset Company data found there.
 *   FAILURE       an injected failure mid-execution: 5xx, nothing changed,
 *                 a failure-evidence audit row, no success audit row.
 *   BLOCKED       a blocked plan executed directly over the API is refused.
 */

const failure = vi.hoisted(() => ({ inject: false }));
vi.mock("./platform-user-deletion.service.js", async (original) => {
  const actual = await original<Record<string, unknown>>();
  const real = actual.deleteResetCompanyUserAccount as (...args: unknown[]) => Promise<unknown>;
  return {
    ...actual,
    deleteResetCompanyUserAccount: vi.fn(async (...args: unknown[]) => {
      if (failure.inject) throw new Error("Injected failure while deleting an identity");
      return real(...args);
    }),
  };
});

const runDatabase = process.env.RUN_RESET_DATABASE === "true";

describe.skipIf(!runDatabase)("Company Data Reset -- Prompt 3 HTTP certification (disposable, committed)", () => {
  let pool: pg.Pool;
  let db: Kysely<DatabaseSchema>;
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  let superCookie = "";
  let resetRoleCookie = "";
  let readerCookie = "";
  const password = "company-data-reset-p3-password";

  const count = async (text: string, values: unknown[]) =>
    Number(Object.values((await pool.query<Record<string, string>>(text, values)).rows[0] ?? {})[0] ?? 0);
  const base = (companyId: string) => `/api/v1/platform/companies/${companyId}/data-reset`;
  const post = (path: string, body: object, cookie: string) =>
    request(server).post(path).set("Cookie", cookie).set("X-Blueline-Session", "cookie").send(body);

  async function seed(label: string): Promise<ScenarioFixture> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const fixture = await seedScenarioCompany(client, label);
      await client.query("commit");
      return fixture;
    } finally {
      client.release();
    }
  }

  /** Fingerprint of every Company-scoped table (zero-mutation proofs). */
  async function fingerprintAll(companyId: string, exclude: readonly string[] = []): Promise<string> {
    const tables = (
      await pool.query<{ table_name: string }>(
        `select c.table_name from information_schema.columns c
           join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
          where c.table_schema = 'public' and c.column_name = 'company_id' order by c.table_name`,
      )
    ).rows.map((row) => row.table_name).filter((table) => !exclude.includes(table));
    const parts: string[] = [];
    for (const table of tables) {
      const row = (await pool.query<{ d: string | null }>(`select md5(string_agg(t::text, '|' order by t::text)) as d from "${table}" t where t.company_id = $1`, [companyId])).rows[0]!;
      parts.push(`${table}:${row.d ?? "-"}`);
    }
    return parts.join("\n");
  }

  async function platformAccount(permissions: readonly string[] | "super"): Promise<string> {
    const suffix = randomUUID().slice(0, 8);
    const id = randomUUID();
    const hash = await new PasswordHasher().hash(password);
    await pool.query(
      "insert into accounts (id, company_id, account_kind, username, password_hash, status, password_changed_at) values ($1, null, 'platform_administrator', $2, $3, 'active', now())",
      [id, `cdr.p3.${suffix}`, hash],
    );
    let roleId: string;
    if (permissions === "super") {
      roleId = (await pool.query<{ id: string }>("select id from roles where company_id is null and lower(code) = $1", [PLATFORM_SUPER_ADMIN_ROLE_CODE])).rows[0]!.id;
    } else {
      roleId = randomUUID();
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("insert into roles (id, company_id, code, name, is_system) values ($1, null, $2, $3, false)", [roleId, `cdr_p3_${suffix}`, `CDR P3 ${suffix}`]);
        for (const permission of permissions) await client.query("insert into role_permissions (role_id, permission_code) values ($1, $2)", [roleId, permission]);
        await client.query("commit");
      } finally {
        client.release();
      }
    }
    await pool.query("insert into account_roles (account_id, role_id, company_id) values ($1, $2, null)", [id, roleId]);
    const response = await request(server).post("/api/v1/platform/auth/login").send({ identifier: `cdr.p3.${suffix}`, password }).expect(200);
    return (response.headers["set-cookie"] as unknown as string[])[0]?.split(";")[0] ?? "";
  }

  async function companyToken(fixture: ScenarioFixture, accountId: string): Promise<string> {
    const hash = await new PasswordHasher().hash(password);
    const account = (
      await pool.query<{ username: string }>("update accounts set password_hash = $2, password_changed_at = now() where id = $1 returning username", [accountId, hash])
    ).rows[0]!;
    const subdomain = (await pool.query<{ subdomain: string }>("select subdomain from companies where id = $1", [fixture.company])).rows[0]!.subdomain;
    const login = await request(server).post("/api/v1/auth/login").set("Host", `${subdomain}.blueline.test`).send({ identifier: account.username, password }).expect(200);
    return String(login.body.accessToken);
  }

  beforeAll(async () => {
    assertDisposableDatabase(process.env.DATABASE_URL);
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
    db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
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
    superCookie = await platformAccount("super");
    resetRoleCookie = await platformAccount(["platform.access", "platform.companies.read", "platform.companies.reset"]);
    readerCookie = await platformAccount(["platform.access", "platform.companies.read"]);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  it("PERMISSIONS: only Platform users holding platform.companies.reset may preview or execute; Company Admin, Company user and anonymous never; nothing changes", async () => {
    const a = await seed("P3PERM");
    const before = await fingerprintAll(a.company, ["accounts", "account_sessions", "audit_events"]);
    const body = { preset: "OPERATIONAL_DATA" };
    await post(`${base(a.company)}/preview`, body, superCookie).expect(200);
    const authorised = await post(`${base(a.company)}/preview`, body, resetRoleCookie).expect(200);
    await post(`${base(a.company)}/preview`, body, readerCookie).expect(403);
    await post(`${base(a.company)}/execute`, { ...body, confirmation: `RESET ${a.code}`, planVersion: authorised.body.planVersion }, readerCookie).expect(403);
    await request(server).post(`${base(a.company)}/preview`).send(body).expect(401);
    await request(server).post(`${base(a.company)}/execute`).send({ ...body, confirmation: `RESET ${a.code}`, planVersion: authorised.body.planVersion }).expect(401);
    for (const accountId of [a.admin, a.ordinaryUser]) {
      const token = await companyToken(a, accountId);
      for (const path of ["preview", "execute"]) {
        const response = await request(server)
          .post(`${base(a.company)}/${path}`)
          .set("Authorization", `Bearer ${token}`)
          .send({ ...body, confirmation: `RESET ${a.code}`, planVersion: authorised.body.planVersion });
        expect([401, 403], `${accountId} ${path}`).toContain(response.status);
      }
    }
    expect(await fingerprintAll(a.company, ["accounts", "account_sessions", "audit_events"])).toBe(before);
    expect(await count("select count(*) from audit_events where company_id = $1 and action like 'platform.company.data_reset%'", [a.company])).toBe(0);
    expect(await count("select count(*) from orders where company_id = $1", [a.company])).toBe(1);
  }, 300_000);

  it("BACKUP + AUDIT + DOUBLE SUBMIT: two concurrent executions of one plan -> exactly one reset; the backup is verified, checksummed, audited and RESTORES the pre-reset Company", async () => {
    const a = await seed("P3BAK");
    const ordersBefore = await count("select count(*) from orders where company_id = $1", [a.company]);
    const collectionsBefore = await count("select count(*) from trader_collections where company_id = $1", [a.company]);
    const body = { preset: "FULL_COMPANY_DATA_KEEP_COMPANY", userMode: "KEEP_ALL_USERS" };
    const plan = (await post(`${base(a.company)}/preview`, body, resetRoleCookie).expect(200)).body as { planVersion: string };
    const execute = () => post(`${base(a.company)}/execute`, { ...body, confirmation: `RESET ${a.code}`, planVersion: plan.planVersion }, resetRoleCookie);
    const [first, second] = await Promise.all([execute(), execute()]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    const success = first.status === 200 ? first : second;
    const refused = first.status === 200 ? second : first;
    expect(refused.body).toMatchObject({ error: { code: "reset_plan_stale" } });
    // A browser retry of the same approved plan is refused too.
    expect((await execute()).body).toMatchObject({ error: { code: "reset_plan_stale" } });
    expect(await count("select count(*) from audit_events where company_id = $1 and action = 'platform.company.data_reset.planned'", [a.company])).toBe(1);
    expect(await count("select count(*) from orders where company_id = $1", [a.company])).toBe(0);

    // Audit: actor, plan, result, backup reference + checksum, linked by id.
    const result = success.body as { auditEventId: string; backupFile: string; backupSha256: string; backupBytes: number; correlationId: string };
    const audit = (
      await pool.query<{ actor_account_id: string | null; correlation_id: string; result: string; before_data: Record<string, unknown>; after_data: Record<string, unknown> }>(
        "select actor_account_id, correlation_id, result, before_data, after_data from audit_events where id = $1",
        [result.auditEventId],
      )
    ).rows[0]!;
    expect(audit.actor_account_id).not.toBeNull();
    expect(audit.correlation_id).toBe(result.correlationId);
    expect(audit).toMatchObject({ after_data: { backupFile: result.backupFile, backupSha256: result.backupSha256 }, before_data: { planVersion: plan.planVersion }, result: "success" });

    // The backup file: exists, matches its checksum, lists with pg_restore, and RESTORES.
    const file = resolve(process.env.COMPANY_DELETION_BACKUP_ROOT ?? "", result.backupFile);
    const bytes = readFileSync(file);
    expect(bytes.length).toBe(result.backupBytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(result.backupSha256);
    const scratch = `blueline_reset_restore_p3_${randomUUID().slice(0, 8)}`;
    const admin = new URL(process.env.DATABASE_URL!);
    admin.pathname = "/postgres";
    const adminPool = new pg.Pool({ connectionString: admin.toString(), max: 1 });
    try {
      await adminPool.query(`create database ${scratch}`);
      const target = new URL(process.env.DATABASE_URL!);
      target.pathname = `/${scratch}`;
      const restored = spawnSync("pg_restore", ["--no-owner", "--no-privileges", "--dbname", target.toString(), file], { encoding: "utf8", timeout: 600_000 });
      expect(restored.status, restored.stderr.slice(0, 2000)).toBe(0);
      const restoredPool = new pg.Pool({ connectionString: target.toString(), max: 1 });
      try {
        const row = (
          await restoredPool.query<{ orders: string; collections: string; company: string }>(
            `select (select count(*) from orders where company_id = $1) as orders,
                    (select count(*) from trader_collections where company_id = $1) as collections,
                    (select code from companies where id = $1) as company`,
            [a.company],
          )
        ).rows[0]!;
        expect({ collections: Number(row.collections), company: row.company, orders: Number(row.orders) }).toEqual({
          collections: collectionsBefore,
          company: a.code,
          orders: ordersBefore,
        });
      } finally {
        await restoredPool.end();
      }
    } finally {
      await adminPool.query(`drop database if exists ${scratch} with (force)`);
      await adminPool.end();
    }
  }, 900_000);

  it("FORCED FAILURE: an injected failure mid-execution rolls back (nothing changed), answers an error (never success) and leaves failure evidence, no success audit", async () => {
    const a = await seed("P3FAIL");
    const body = { preset: "FULL_COMPANY_DATA_KEEP_COMPANY", selectedAccountIds: [a.employeeUser], userMode: "DELETE_SELECTED_USERS" };
    const plan = (await post(`${base(a.company)}/preview`, body, superCookie).expect(200)).body as { planVersion: string; executable: boolean };
    expect(plan.executable).toBe(true);
    const before = await fingerprintAll(a.company, ["audit_events"]);
    failure.inject = true;
    let response: request.Response;
    try {
      response = await post(`${base(a.company)}/execute`, { ...body, confirmation: `RESET ${a.code}`, planVersion: plan.planVersion }, superCookie);
    } finally {
      failure.inject = false;
    }
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(response.body)).not.toMatch(/"totalRemoved"/u);
    expect(await fingerprintAll(a.company, ["audit_events"])).toBe(before);
    expect(await count("select count(*) from audit_events where company_id = $1 and action = 'platform.company.data_reset.planned'", [a.company])).toBe(0);
    expect(
      await count(
        "select count(*) from audit_events where company_id = $1 and action = 'platform.company.data_reset.failed' and result = 'failure' and failure_reason = 'reset_failed_rolled_back'",
        [a.company],
      ),
    ).toBe(1);
    const guards = await pool.query("select t.tgname from pg_trigger t where not t.tgisinternal and t.tgenabled <> 'O' and t.tgname like any(array['%immutable%', '%append_only%', '%guard%'])");
    expect(guards.rows).toEqual([]);
    // The same plan still executes afterwards (nothing was half-applied).
    await post(`${base(a.company)}/execute`, { ...body, confirmation: `RESET ${a.code}`, planVersion: plan.planVersion }, superCookie).expect(200);
  }, 600_000);

  it("BLOCKED over the API: preview reports BLOCKED with reasons; a direct execute is refused 409 reset_plan_blocked with zero mutation", async () => {
    const a = await seed("P3BLK");
    const body = { domains: ["WORKFORCE"], preset: "CUSTOM", userMode: "KEEP_ALL_USERS" };
    const plan = (await post(`${base(a.company)}/preview`, body, superCookie).expect(200)).body as { planVersion: string; executable: boolean; blockers: string[] };
    expect(plan.executable).toBe(false);
    expect(plan.blockers.length).toBeGreaterThan(0);
    const before = await fingerprintAll(a.company, ["audit_events"]);
    const refused = await post(`${base(a.company)}/execute`, { ...body, confirmation: `RESET ${a.code}`, planVersion: plan.planVersion }, superCookie).expect(409);
    expect(refused.body).toMatchObject({ error: { code: "reset_plan_blocked" } });
    expect(await fingerprintAll(a.company, ["audit_events"])).toBe(before);
    expect(await count("select count(*) from audit_events where company_id = $1 and action = 'platform.company.data_reset.planned'", [a.company])).toBe(0);
  }, 600_000);
});
