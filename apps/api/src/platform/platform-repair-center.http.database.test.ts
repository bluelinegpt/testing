import { randomUUID } from "node:crypto";

import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Logger } from "nestjs-pino";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { markTraderDeductionV1Order } from "../operations/order-obligation-snapshot.fixture.js";
import { ApiExceptionFilter } from "../presentation/errors/api-exception.filter.js";
import { CompanyHostResolver } from "../tenancy/company-host-resolver.js";
import { PLATFORM_SUPER_ADMIN_ROLE_CODE } from "./platform-authorization.js";

/**
 * Platform Repair Center over HTTP (Phase 2 Prompt 1, Parts A / V / W / X).
 *
 * The real application (global validation pipe, authentication guard,
 * PlatformTargetCompanyGuard) against the disposable database. Proves:
 *   - Platform-only and permission-gated (a Platform reader without the
 *     Repair Center code is refused);
 *   - the Company comes only from the path (unknown/malformed -> 404, a
 *     `companyId` query parameter -> 400);
 *   - View Details (Verify First) is Company-scoped: another Company's Order
 *     is 404 even with a valid UUID;
 *   - reads write no audit row; no mutating verb exists.
 */

const disposableName = process.env.BLUELINE_DISPOSABLE_DB_NAME ?? "";
const databaseUrl = process.env.DATABASE_URL ?? "";
const runTests =
  process.env.RUN_INTEGRITY_DATABASE === "true" &&
  disposableName.length > 0 &&
  databaseUrl.endsWith(`/${disposableName}`);

describe.skipIf(!runTests)("Platform Repair Center HTTP", () => {
  let pool: Pool;
  let db: Kysely<DatabaseSchema>;
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  let adminCookie = "";
  let readerCookie = "";
  let adminId = "";
  const companyA = randomUUID();
  const companyB = randomUUID();
  let orderA = "";
  let orderB = "";

  async function company(id: string, tag: string) {
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values (${id}::uuid,${`RC-${tag}`},${`rc-${tag.toLowerCase()}`},${`Repair ${tag}`},'active',now())`.execute(
      db,
    );
    const actor = randomUUID();
    await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status)
      values (${actor}::uuid,${id}::uuid,'company_user',${`rc.${actor}`},'x','disabled')`.execute(db);
    const emirate = await sql<{ id: string }>`select id from emirates order by code limit 1`.execute(db);
    const area = randomUUID();
    const trader = randomUUID();
    await sql`insert into areas(id,company_id,code,name_en,name_ar,emirate_id)
      values (${area}::uuid,${id}::uuid,${`A-${tag}`},'Area','منطقة',${emirate.rows[0]!.id}::uuid)`.execute(db);
    await sql`insert into traders(id,company_id,code,name_en,mobile_number,pickup_area_id,created_by_account_id)
      values (${trader}::uuid,${id}::uuid,${`T-${tag}`},'Trader','971500000003',${area}::uuid,${actor}::uuid)`.execute(
      db,
    );
    // A legacy delivered Trader-pays-fee Order with no Receivable (crafted):
    // the Repair Center must report it as ISSUE.
    const order = randomUUID();
    await sql`insert into orders(id,company_id,order_number,order_date,trader_id,area_id,
      created_by_account_id,customer_name,customer_mobile_number,customer_address,package_count,
      payment_condition,service_fee,final_service_fee_snapshot,customer_provenance_status,
      pricing_provenance_status,customer_amount_due,trader_gross_payable,trader_paid_service_fee,
      trader_net_payable,trader_paid_amount,delivery_status,driver_reconciliation_status,
      trader_settlement_status,return_status,delivered_at)
    values (${order}::uuid,${id}::uuid,'ORD-0001',current_date,${trader}::uuid,${area}::uuid,${actor}::uuid,
      'Private Customer','971500000001','Private Address',1,'customer_pays_cod_trader_pays_fee',18,18,
      'legacy_unattributed','legacy_unattributed',0,0,18,0,0,'delivered','not_applicable','not_eligible',
      'not_applicable',now())`.execute(db);
    await markTraderDeductionV1Order(db, order);
    return order;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    db = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue(db)
      .overrideProvider(CompanyHostResolver)
      .useValue({
        isReservedHost: () => false,
        resolve: (host: string | undefined) => host?.split(".")[0],
      })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix("api/v1");
    app.useGlobalPipes(
      new ValidationPipe({
        forbidNonWhitelisted: true,
        stopAtFirstError: false,
        transform: true,
        whitelist: true,
      }),
    );
    app.useGlobalFilters(new ApiExceptionFilter(app.get(Logger)));
    await app.init();
    server = app.getHttpServer() as Parameters<typeof request>[0];

    await sql`insert into emirates(code,name_en,name_ar,display_order)
      values ('DXB','DXB','DXB',200) on conflict (code) do nothing`.execute(db);
    const suffix = randomUUID().slice(0, 8);
    orderA = await company(companyA, `A${suffix}`);
    orderB = await company(companyB, `B${suffix}`);

    const password = "repair-center-password";
    const hash = await new PasswordHasher().hash(password);
    adminId = randomUUID();
    const readerId = randomUUID();
    await sql`insert into accounts (id, company_id, account_kind, username, password_hash, status, password_changed_at)
      values (${adminId}::uuid, null, 'platform_administrator', ${`rc.admin.${suffix}`}, ${hash}, 'active', now()),
             (${readerId}::uuid, null, 'platform_administrator', ${`rc.reader.${suffix}`}, ${hash}, 'active', now())`.execute(
      db,
    );
    const superRole = (
      await sql<{ id: string }>`select id from roles where company_id is null
        and lower(code) = ${PLATFORM_SUPER_ADMIN_ROLE_CODE}`.execute(db)
    ).rows[0]!;
    await sql`insert into account_roles (account_id, role_id, company_id)
      values (${adminId}::uuid, ${superRole.id}::uuid, null)`.execute(db);
    // A Platform reader: may see Companies, but holds no Repair Center code.
    const readRole = randomUUID();
    // One transaction: an active Role must hold a Permission at commit.
    await db.transaction().execute(async (transaction) => {
      await sql`insert into roles (id, company_id, code, name, is_system)
        values (${readRole}::uuid, null, ${`rc_reader_${suffix}`}, ${`RC Reader ${suffix}`}, false)`.execute(
        transaction,
      );
      await sql`insert into role_permissions (role_id, permission_code)
        values (${readRole}::uuid, 'platform.access'), (${readRole}::uuid, 'platform.companies.read')`.execute(
        transaction,
      );
    });
    await sql`insert into account_roles (account_id, role_id, company_id)
      values (${readerId}::uuid, ${readRole}::uuid, null)`.execute(db);

    const signIn = async (username: string) => {
      const response = await request(server)
        .post("/api/v1/platform/auth/login")
        .send({ identifier: username, password })
        .expect(200);
      return (response.headers["set-cookie"] as unknown as string[])[0]?.split(";")[0] ?? "";
    };
    adminCookie = await signIn(`rc.admin.${suffix}`);
    readerCookie = await signIn(`rc.reader.${suffix}`);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.destroy();
  });

  const get = (path: string, cookie = adminCookie) =>
    request(server).get(`/api/v1/${path}`).set("Cookie", cookie).set("X-Blueline-Session", "cookie");

  const base = (companyId: string) => `platform/companies/${companyId}/repair-center`;

  it("Super Admin: summary, default list and Verify First of the selected Company", async () => {
    const summary = await get(`${base(companyA)}/health/orders/summary`).expect(200);
    expect(summary.body).toMatchObject({
      accountingMode: { enabled: false },
      company: { id: companyA },
      companyHealth: "ISSUE",
      issueOrders: 1,
      reviewOrders: 0,
      scope: { scope: "last30" },
      totalOrders: 1,
    });
    expect(summary.body.generatedAt).toEqual(expect.any(String));

    const list = await get(`${base(companyA)}/health/orders`).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({
      health: "ISSUE",
      orderId: orderA,
      orderNumber: "ORD-0001",
      reasonCode: "MISSING_RECEIVABLE",
    });
    expect(JSON.stringify(list.body)).not.toMatch(/Private Customer|Private Address|971500000001/u);

    const verify = await get(`${base(companyA)}/orders/${orderA}/verify`).expect(200);
    expect(verify.body).toMatchObject({ classification: "MISSING_RECEIVABLE", health: "ISSUE" });
    expect(JSON.stringify(verify.body)).not.toMatch(/Private Customer|Private Address/u);
  });

  it("Part A: a Platform reader without the Repair Center permission is refused", async () => {
    await get(`${base(companyA)}/health/orders/summary`, readerCookie).expect(403);
    await get(`${base(companyA)}/health/orders`, readerCookie).expect(403);
    await get(`${base(companyA)}/orders/${orderA}/verify`, readerCookie).expect(403);
    await request(server).get(`/api/v1/${base(companyA)}/health/orders/summary`).expect(401);
  });

  it("Part A / V: the Company is explicit in the path; never by Order number alone", async () => {
    await get(`${base(randomUUID())}/health/orders/summary`).expect(404);
    await get(`platform/companies/not-a-uuid/repair-center/health/orders`).expect(404);
    // Company A's path cannot reach Company B's Order -- same Order number, valid UUID.
    await get(`${base(companyA)}/orders/${orderB}/verify`).expect(404);
    // A Company id smuggled through the query string is rejected outright.
    await get(`${base(companyA)}/health/orders?companyId=${companyB}`).expect(400);
    await get(`${base(companyA)}/health/orders?orderNumber=ORD-0001`).expect(400);
    // Company B is evaluated on its own: its Order is not in A's list.
    const listB = await get(`${base(companyB)}/health/orders?health=all`).expect(200);
    expect(listB.body.items.map((row: { orderId: string }) => row.orderId)).toEqual([orderB]);
  });

  it("Part M / N: query validation", async () => {
    await get(`${base(companyA)}/health/orders?health=everything`).expect(400);
    await get(`${base(companyA)}/health/orders?pageSize=1000`).expect(400);
    await get(`${base(companyA)}/health/orders?scope=custom`).expect(400);
    await get(`${base(companyA)}/health/orders?scope=custom&dateFrom=2026-02-01&dateTo=2026-01-01`).expect(400);
    await get(`${base(companyA)}/health/orders?reasonCode=DROP_TABLE`).expect(400);
    const custom = await get(
      `${base(companyA)}/health/orders?scope=custom&dateFrom=2000-01-01&dateTo=2000-01-31&health=all`,
    ).expect(200);
    expect(custom.body).toMatchObject({ total: 0, scope: { dateFrom: "2000-01-01", dateTo: "2000-01-31" } });
  });

  it("Part Q / X: reads write no audit row and no mutating verb is exposed", async () => {
    const audits = async () =>
      (
        await sql<{ n: number }>`select count(*)::int as n from audit_events
          where actor_account_id = ${adminId}::uuid or company_id in (${companyA}::uuid, ${companyB}::uuid)`.execute(
          db,
        )
      ).rows[0]!.n;
    const before = await audits();
    await get(`${base(companyA)}/health/orders/summary?scope=all`).expect(200);
    await get(`${base(companyA)}/health/orders?health=all&scope=all`).expect(200);
    await get(`${base(companyA)}/orders/${orderA}/verify`).expect(200);
    expect(await audits()).toBe(before);
    for (const method of ["post", "put", "patch", "delete"] as const) {
      const agent = request(server);
      const response = await agent[method](`/api/v1/${base(companyA)}/health/orders`)
        .set("Cookie", adminCookie)
        .set("X-Blueline-Session", "cookie");
      expect(response.status).toBe(404);
    }
  });

  describe("Phase 2 Prompt 2 -- findings and repair plan preview (Part W)", () => {
    const companyC = randomUUID();
    const orders: Record<"ready" | "blocked" | "healthy" | "manual", string> = {
      blocked: "",
      healthy: "",
      manual: "",
      ready: "",
    };
    let companyUserToken = "";

    /** A legacy delivered Order in Company C (crafted; triggers bypassed). */
    async function legacyOrder(
      number: string,
      values: { cod: number; condition: string; driverStatus?: string },
    ): Promise<string> {
      const refs = (
        await sql<{ actor: string; area: string; trader: string }>`
          select (select id from accounts where company_id = ${companyC}::uuid limit 1) as actor,
                 (select id from areas where company_id = ${companyC}::uuid limit 1) as area,
                 (select id from traders where company_id = ${companyC}::uuid limit 1) as trader`.execute(db)
      ).rows[0]!;
      const id = randomUUID();
      await db.transaction().execute(async (transaction) => {
        await sql`set local session_replication_role = replica`.execute(transaction);
        await sql`insert into orders(id,company_id,order_number,order_date,trader_id,area_id,
          created_by_account_id,customer_name,customer_mobile_number,customer_address,package_count,
          payment_condition,cod_amount,service_fee,final_service_fee_snapshot,customer_provenance_status,
          pricing_provenance_status,customer_amount_due,trader_gross_payable,trader_paid_service_fee,
          trader_net_payable,trader_paid_amount,delivery_status,driver_reconciliation_status,
          trader_settlement_status,return_status,delivered_at)
        values (${id}::uuid,${companyC}::uuid,${number},current_date,${refs.trader}::uuid,${refs.area}::uuid,
          ${refs.actor}::uuid,'Private Customer','971500000001','Private Address',1,${values.condition},
          ${values.cod},18,18,'legacy_unattributed','legacy_unattributed',0,0,18,0,0,'delivered',
          ${values.driverStatus ?? "not_applicable"},'not_eligible','not_applicable',now())`.execute(transaction);
      });
      await markTraderDeductionV1Order(db, id);
      return id;
    }

    beforeAll(async () => {
      const tag = `C${randomUUID().slice(0, 8)}`;
      // company() also creates ORD-0001: MISSING_RECEIVABLE, fee 18 -> READY.
      orders.ready = await company(companyC, tag);
      // COD 5 changes what the financial model says the Trader owes -> BLOCKED.
      orders.blocked = await legacyOrder("ORD-0002", { cod: 5, condition: "customer_pays_cod_trader_pays_fee" });
      orders.healthy = await legacyOrder("ORD-0003", { cod: 100, condition: "customer_pays_cod_and_fee" });
      orders.manual = await legacyOrder("ORD-0004", {
        cod: 100,
        condition: "customer_pays_cod_and_fee",
        driverStatus: "reconciled",
      });

      // An ACTIVE Company user of Company C holding the domain permissions the
      // repairs would need -- still never a Platform administrator.
      const password = "repair-center-company-user";
      const hash = await new PasswordHasher().hash(password);
      const accountId = randomUUID();
      const roleId = randomUUID();
      const username = `rc.company.${tag.toLowerCase()}`;
      await db.transaction().execute(async (transaction) => {
        await sql`insert into accounts (id, company_id, account_kind, username, password_hash, status,
            password_changed_at)
          values (${accountId}::uuid, ${companyC}::uuid, 'company_user', ${username}, ${hash}, 'active', now())`.execute(
          transaction,
        );
        await sql`insert into roles (id, company_id, code, name, is_system)
          values (${roleId}::uuid, ${companyC}::uuid, ${`rc_company_${tag.toLowerCase()}`}, ${`RC Company ${tag}`}, true)`.execute(
          transaction,
        );
        await sql`insert into role_permissions (role_id, permission_code)
          values (${roleId}::uuid, 'users_roles.manage'), (${roleId}::uuid, 'trader_receivables.reverse')`.execute(
          transaction,
        );
        await sql`insert into account_roles (account_id, role_id, company_id)
          values (${accountId}::uuid, ${roleId}::uuid, ${companyC}::uuid)`.execute(transaction);
      });
      const login = await request(server)
        .post("/api/v1/auth/login")
        .set("Host", `rc-${tag.toLowerCase()}.blueline.test`)
        .send({ identifier: username, password })
        .expect(200);
      companyUserToken = String(login.body.accessToken);
    }, 120_000);

    const preview = (companyId: string, orderId: string, body: object = {}, cookie = adminCookie) =>
      request(server)
        .post(`/api/v1/${base(companyId)}/orders/${orderId}/repair-preview`)
        .set("Cookie", cookie)
        .set("X-Blueline-Session", "cookie")
        .send(body);

    /** Every table a repair could touch, for Company C, plus all audit rows. */
    const footprint = async () =>
      (
        await sql<{ digest: string }>`select md5(concat_ws('|',
            (select string_agg(t::text, ',' order by t::text) from orders t where company_id = ${companyC}::uuid),
            (select string_agg(t::text, ',' order by t::text) from trader_receivables t where company_id = ${companyC}::uuid),
            (select string_agg(t::text, ',' order by t::text) from trader_credits t where company_id = ${companyC}::uuid),
            (select string_agg(t::text, ',' order by t::text) from accounting_events t where company_id = ${companyC}::uuid),
            (select string_agg(t::text, ',' order by t::text) from journal_entries t where company_id = ${companyC}::uuid),
            (select string_agg(t::text, ',' order by t::text) from order_events t where company_id = ${companyC}::uuid),
            (select count(*)::text from audit_events where actor_account_id = ${adminId}::uuid
                                                     or company_id = ${companyC}::uuid))) as digest`.execute(db)
      ).rows[0]!.digest;

    it("Super Admin: findings and READY preview (accounting OFF), no PII, nothing written", async () => {
      const before = await footprint();
      const findings = await get(`${base(companyC)}/orders/${orders.ready}/findings`).expect(200);
      expect(findings.body.findings[0]).toMatchObject({
        companyId: companyC,
        reasonCode: "MISSING_RECEIVABLE",
        repairCapability: "REPAIR_TRADER_RECEIVABLE",
        repairability: "READY",
      });
      const response = await preview(companyC, orders.ready).expect(200);
      expect(response.body).toMatchObject({
        accountingMode: { enabled: false },
        companyId: companyC,
        execution: { available: true, requiredPlatformPermission: "platform.companies.repair_center.execute" },
        orderId: orders.ready,
        orderNumber: "ORD-0001",
        repairability: "READY",
        requiredPermission: "users_roles.manage",
      });
      expect(response.body.previewVersion).toBe(findings.body.previewVersion);
      expect(response.body.warnings.map((w: { code: string }) => w.code)).toContain("ACCOUNTING_OFF_NO_GL_EVENT");
      expect(JSON.stringify(response.body)).not.toMatch(/Private Customer|Private Address|971500000001/u);
      // Same state, same fingerprint.
      const again = await preview(companyC, orders.ready).expect(200);
      expect(again.body.previewVersion).toBe(response.body.previewVersion);
      expect(await footprint()).toBe(before);
    });

    it("healthy -> NOT_REQUIRED; blocked -> BLOCKED; driver cash -> MANUAL_REVIEW", async () => {
      const healthy = await preview(companyC, orders.healthy).expect(200);
      expect(healthy.body).toMatchObject({ proposedChanges: [], repairability: "NOT_REQUIRED" });
      const blocked = await preview(companyC, orders.blocked).expect(200);
      expect(blocked.body.repairability).toBe("BLOCKED");
      expect(blocked.body.blockers.map((b: { code: string }) => b.code)).toContain(
        "REPAIR_AMOUNT_DIFFERS_FROM_FINANCIAL_MODEL",
      );
      const manual = await preview(companyC, orders.manual).expect(200);
      expect(manual.body.repairability).toBe("MANUAL_REVIEW");
      expect(manual.body.finding.domain).toBe("DRIVER_CASH");
    });

    it("accounting ON changes the mode and the fingerprint (then back)", async () => {
      const off = await preview(companyC, orders.ready).expect(200);
      await sql`insert into accounting_configurations(company_id, accounting_enabled)
        values (${companyC}::uuid, true)`.execute(db);
      try {
        const on = await preview(companyC, orders.ready).expect(200);
        expect(on.body.accountingMode).toEqual({ enabled: true });
        expect(on.body.previewVersion).not.toBe(off.body.previewVersion);
        expect(on.body.warnings.map((w: { code: string }) => w.code)).not.toContain("ACCOUNTING_OFF_NO_GL_EVENT");
      } finally {
        await sql`delete from accounting_configurations where company_id = ${companyC}::uuid`.execute(db);
      }
      const back = await preview(companyC, orders.ready).expect(200);
      expect(back.body.previewVersion).toBe(off.body.previewVersion);
    });

    it("authorization: Platform reader 403, anonymous 401, Company user refused", async () => {
      await get(`${base(companyC)}/orders/${orders.ready}/findings`, readerCookie).expect(403);
      await preview(companyC, orders.ready, {}, readerCookie).expect(403);
      await request(server).post(`/api/v1/${base(companyC)}/orders/${orders.ready}/repair-preview`).expect(401);
      const companyUser = await request(server)
        .post(`/api/v1/${base(companyC)}/orders/${orders.ready}/repair-preview`)
        .set("Authorization", `Bearer ${companyUserToken}`)
        .send({});
      expect([401, 403]).toContain(companyUser.status);
      const companyUserFindings = await request(server)
        .get(`/api/v1/${base(companyC)}/orders/${orders.ready}/findings`)
        .set("Authorization", `Bearer ${companyUserToken}`);
      expect([401, 403]).toContain(companyUserFindings.status);
    });

    it("tenant scoping: malformed / unknown Company, wrong-Company Order, duplicate Order number", async () => {
      await preview("not-a-uuid", orders.ready).expect(404);
      await preview(randomUUID(), orders.ready).expect(404);
      // ORD-0001 exists in Companies A, B and C; each path reaches only its own.
      await preview(companyA, orders.ready).expect(404);
      await get(`${base(companyA)}/orders/${orders.ready}/findings`).expect(404);
      const a = await preview(companyA, orderA).expect(200);
      const c = await preview(companyC, orders.ready).expect(200);
      expect(a.body.orderNumber).toBe(c.body.orderNumber);
      expect(a.body.orderId).not.toBe(c.body.orderId);
      expect(a.body.finding.findingId).not.toBe(c.body.finding.findingId);
    });

    it("input validation: unknown field 400, bad reason code 400, non-current reason 409", async () => {
      await preview(companyC, orders.ready, { force: true }).expect(400);
      await preview(companyC, orders.ready, { reasonCode: "DROP_TABLE" }).expect(400);
      const stale = await preview(companyC, orders.ready, { reasonCode: "MULTIPLE_EFFECTIVE_SETTLEMENTS" }).expect(409);
      expect(JSON.stringify(stale.body)).toContain("repair_finding_not_current");
      await preview(companyC, orders.ready, { reasonCode: "MISSING_RECEIVABLE" }).expect(200);
    });

    it("no confirm / reset / reverse / reprocess / bulk route exists (execute is the only write route)", async () => {
      for (const suffix of ["repair-execute", "confirm", "reset", "reverse", "reprocess", "force-status", "repair-all"]) {
        const response = await request(server)
          .post(`/api/v1/${base(companyC)}/orders/${orders.ready}/${suffix}`)
          .set("Cookie", adminCookie)
          .set("X-Blueline-Session", "cookie")
          .send({});
        expect(response.status).toBe(404);
      }
    });
    describe("Phase 2 Prompt 3 -- safe repair execution over HTTP", () => {
      let readerWithPreviewCookie = "";
      let executable = "";
      let blocked = "";

      const execute = (orderId: string, body: object, cookie = adminCookie, companyId: string = companyC) =>
        request(server)
          .post(`/api/v1/${base(companyId)}/orders/${orderId}/execute`)
          .set("Cookie", cookie)
          .set("X-Blueline-Session", "cookie")
          .send(body);

      const bodyFor = async (orderId: string, overrides: object = {}) => {
        const current = await preview(companyC, orderId).expect(200);
        return {
          capabilityCode: "REPAIR_TRADER_RECEIVABLE",
          findingId: current.body.finding.findingId,
          idempotencyKey: `rc-http-${randomUUID()}`,
          previewVersion: current.body.previewVersion,
          reason: "Legacy order never received its Trader receivable",
          ...overrides,
        };
      };

      const receivableCount = async (orderNumber: string) =>
        (
          await sql<{ n: number }>`select count(*)::int as n from trader_receivables
            where company_id = ${companyC}::uuid and source_reference = ${orderNumber}`.execute(db)
        ).rows[0]!.n;

      beforeAll(async () => {
        executable = await legacyOrder("ORD-0101", { cod: 0, condition: "customer_pays_cod_trader_pays_fee" });
        blocked = orders.blocked;
        // CASE 14: a Platform user who may READ the Repair Center (health +
        // previews) but holds no execute permission.
        const tag = randomUUID().slice(0, 8);
        const password = "repair-center-preview-reader";
        const hash = await new PasswordHasher().hash(password);
        const accountId = randomUUID();
        const roleId = randomUUID();
        await db.transaction().execute(async (transaction) => {
          await sql`insert into accounts (id, company_id, account_kind, username, password_hash, status, password_changed_at)
            values (${accountId}::uuid, null, 'platform_administrator', ${`rc.preview.${tag}`}, ${hash}, 'active', now())`.execute(
            transaction,
          );
          await sql`insert into roles (id, company_id, code, name, is_system)
            values (${roleId}::uuid, null, ${`rc_preview_${tag}`}, ${`RC Preview ${tag}`}, false)`.execute(transaction);
          await sql`insert into role_permissions (role_id, permission_code)
            values (${roleId}::uuid, 'platform.access'), (${roleId}::uuid, 'platform.companies.read'),
                   (${roleId}::uuid, 'platform.companies.repair_center.read')`.execute(transaction);
          await sql`insert into account_roles (account_id, role_id, company_id)
            values (${accountId}::uuid, ${roleId}::uuid, null)`.execute(transaction);
        });
        const login = await request(server)
          .post("/api/v1/platform/auth/login")
          .send({ identifier: `rc.preview.${tag}`, password })
          .expect(200);
        readerWithPreviewCookie = (login.headers["set-cookie"] as unknown as string[])[0]?.split(";")[0] ?? "";
      }, 120_000);

      it("CASE 14 / 15 / 13: preview reader 403, Company user refused, anonymous 401, wrong Company 404 -- zero mutation", async () => {
        const body = await bodyFor(executable);
        const before = await footprint();
        // The preview reader can see the preview ...
        await preview(companyC, executable, {}, readerWithPreviewCookie).expect(200);
        // ... but can never execute it.
        await execute(executable, body, readerWithPreviewCookie).expect(403);
        await execute(executable, body, readerCookie).expect(403);
        const companyUser = await request(server)
          .post(`/api/v1/${base(companyC)}/orders/${executable}/execute`)
          .set("Authorization", `Bearer ${companyUserToken}`)
          .send(body);
        expect([401, 403]).toContain(companyUser.status);
        await request(server).post(`/api/v1/${base(companyC)}/orders/${executable}/execute`).send(body).expect(401);
        await execute(executable, body, adminCookie, companyA).expect(404);
        await execute(executable, body, adminCookie, randomUUID()).expect(404);
        await execute(executable, body, adminCookie, "not-a-uuid").expect(404);
        expect(await footprint()).toBe(before);
        expect(await receivableCount("ORD-0101")).toBe(0);
      });

      it("request validation: only a registered capability, a reason, a fingerprint and a key are accepted", async () => {
        const body = await bodyFor(executable);
        const before = await footprint();
        for (const bad of [
          { ...body, reason: "" },
          { ...body, previewVersion: "stale" },
          { ...body, capabilityCode: "DROP_TABLE" },
          { ...body, idempotencyKey: "short" },
          { ...body, findingId: "fnd_x" },
          { ...body, amount: "18.00" },
          { ...body, status: "delivered" },
          { ...body, handler: "OperationsService.repairTraderReceivable" },
          { ...body, inputs: { sql: ["drop"] } },
        ]) {
          await execute(executable, bad).expect(400);
        }
        expect(await footprint()).toBe(before);
      });

      it("BLOCKED cannot execute; stale preview -> 409 repair_preview_stale with the refresh message", async () => {
        const before = await footprint();
        const blockedResponse = await execute(blocked, await bodyFor(blocked)).expect(409);
        expect(JSON.stringify(blockedResponse.body)).toContain("repair_not_ready");
        const body = await bodyFor(executable);
        await db.transaction().execute(async (transaction) => {
          await sql`set local session_replication_role = replica`.execute(transaction);
          await sql`update orders set version = version + 1 where id = ${executable}::uuid`.execute(transaction);
        });
        const after = await footprint();
        const stale = await execute(executable, body).expect(409);
        expect(JSON.stringify(stale.body)).toContain("repair_preview_stale");
        expect(JSON.stringify(stale.body)).toContain("The order changed after the repair preview");
        expect(await footprint()).toBe(after);
        expect(before).not.toBe(after); // only the crafted version bump
      });

      it("CASE 1 / 2 / 3 over HTTP: execute READY, replay returns the same result, a new key is refused", async () => {
        const body = await bodyFor(executable);
        const first = await execute(executable, body).expect(200);
        expect(first.body).toMatchObject({
          afterHealth: "HEALTHY",
          beforeClassification: "MISSING_RECEIVABLE",
          beforeHealth: "ISSUE",
          capabilityCode: "REPAIR_TRADER_RECEIVABLE",
          companyId: companyC,
          orderId: executable,
          orderNumber: "ORD-0101",
          replayed: false,
          status: "succeeded",
        });
        expect(JSON.stringify(first.body)).not.toMatch(/Private Customer|Private Address|971500000001|select |insert /u);
        expect(await receivableCount("ORD-0101")).toBe(1);
        const replay = await execute(executable, body).expect(200);
        expect(replay.body).toEqual({ ...first.body, replayed: true });
        const again = await execute(executable, { ...body, idempotencyKey: `rc-http-${randomUUID()}` }).expect(409);
        expect(JSON.stringify(again.body)).toContain("repair_finding_not_current");
        expect(await receivableCount("ORD-0101")).toBe(1);
        const audit = await sql<{ n: number }>`select count(*)::int as n from platform_repair_executions
          where company_id = ${companyC}::uuid and order_id = ${executable}::uuid and actor_account_id = ${adminId}::uuid`.execute(db);
        expect(audit.rows[0]!.n).toBe(1);
        // Verify Again: the Order is now healthy.
        const verify = await get(`${base(companyC)}/orders/${executable}/verify`).expect(200);
        expect(verify.body).toMatchObject({ health: "HEALTHY" });
      });
      describe("Phase 2 Prompt 4 -- Accounting Health and accounting recovery over HTTP", () => {
        let eventId = "";
        const accounting = (path: string) => `${base(companyC)}/accounting/${path}`;

        beforeAll(async () => {
          // Crafted (GL Accounting is OFF for Company C): one historical FAILED
          // order event, shaped exactly like enqueue_operational_accounting_event.
          const actor = (
            await sql<{ id: string }>`select id from accounts where company_id = ${companyC}::uuid
              and account_kind = 'company_user' order by created_at limit 1`.execute(db)
          ).rows[0]!.id;
          eventId = randomUUID();
          await sql`insert into accounting_events (id, company_id, event_type, event_version, source_entity_type,
              source_entity_id, source_reference, effective_accounting_date, currency, correlation_id,
              idempotency_key, event_hash, actor_id, actor_type, description, supplementary_metadata,
              processing_status, operational_area, source_operation_id, failed_at, attempt_count,
              error_code, safe_error_summary, failure_category)
            values (${eventId}::uuid, ${companyC}::uuid, 'order_delivered', 1, 'order', ${orders.healthy}::uuid,
              'ORD-0003', current_date, 'AED', 'http-fixture', ${`order_delivered:${orders.healthy}:v1`},
              md5(${eventId}), ${actor}::uuid, 'company_user', 'order_delivered for ORD-0003',
              '{"customer":"Private Customer"}'::jsonb, 'failed', 'orders', 'http-fixture', now(), 1,
              'accounting_event_mapping_missing', 'A mapping was missing', 'configuration')`.execute(db);
        });

        it("summary and list: Super Admin 200 (mode-aware, Accounting OFF); reader 403; anonymous 401", async () => {
          const summary = await get(accounting("health/summary")).expect(200);
          expect(summary.body).toMatchObject({
            accountingHealth: "NOT_APPLICABLE",
            accountingMode: { enabled: false },
            companyId: companyC,
          });
          expect(summary.body.historicalWhileOff).toBeGreaterThanOrEqual(1);
          const list = await get(accounting("health/events")).expect(200);
          const row = list.body.items.find((item: { eventId: string }) => item.eventId === eventId);
          expect(row).toMatchObject({ businessReference: "ORD-0003", status: "failed", triage: "NOT_REQUIRED" });
          expect(JSON.stringify(list.body)).not.toMatch(/Private Customer|supplementary/u);
          await get(accounting("health/summary"), readerCookie).expect(403);
          await get(accounting("health/events"), readerCookie).expect(403);
          await request(server).get(`/api/v1/${accounting("health/summary")}`).expect(401);
          await get(accounting("health/events?status=nope")).expect(400);
          await get(accounting("health/events?repairability=READY")).expect(400);
          await get(accounting(`health/events?companyId=${companyA}`)).expect(400);
          await get(accounting("health/events?pageSize=1000")).expect(400);
        });

        it("Phase 4 Prompt 1: integrity / missing-event findings -- Super Admin 200, reader 403, anonymous 401, validated, read-only", async () => {
          const before = await footprint();
          const page = await get(accounting("health/integrity")).expect(200);
          expect(page.body).toMatchObject({ page: 1, pageSize: 25 });
          expect(Array.isArray(page.body.items)).toBe(true);
          for (const item of page.body.items as { repairability: string }[]) expect(item.repairability).toBe("MANUAL_REVIEW");
          expect(JSON.stringify(page.body)).not.toMatch(/Private Customer|supplementary|event_hash/u);
          await get(accounting("health/integrity?kind=MISSING_REQUIRED_EVENT&eventType=order_delivered")).expect(200);
          await get(accounting("health/integrity"), readerCookie).expect(403);
          await request(server).get(`/api/v1/${accounting("health/integrity")}`).expect(401);
          await get(accounting("health/integrity?kind=nope")).expect(400);
          await get(accounting("health/integrity?eventType=drop_table")).expect(400);
          await get(accounting(`health/integrity?companyId=${companyA}`)).expect(400);
          await get(accounting("health/integrity?pageSize=1000")).expect(400);
          const summary = await get(accounting("health/summary")).expect(200);
          expect(summary.body).toMatchObject({ integrity: { total: expect.any(Number) }, missingRequiredEvents: { total: expect.any(Number) } });
          expect(Array.isArray(summary.body.headlines)).toBe(true);
          expect(await footprint()).toBe(before);
        });

        it("details and preview: no payload, tenant-scoped, read-only", async () => {
          const before = await footprint();
          const details = await get(accounting(`events/${eventId}`)).expect(200);
          expect(details.body).toMatchObject({
            event: { eventType: "order_delivered", status: "failed" },
            finding: { current: true, repairability: "NOT_REQUIRED" },
          });
          expect(JSON.stringify(details.body)).not.toMatch(/Private Customer|supplementary|event_hash/u);
          const preview = await request(server)
            .post(`/api/v1/${accounting(`events/${eventId}/repair-preview`)}`)
            .set("Cookie", adminCookie)
            .set("X-Blueline-Session", "cookie")
            .send({})
            .expect(200);
          expect(preview.body).toMatchObject({ execution: { available: false }, repairability: "NOT_REQUIRED" });
          await request(server)
            .post(`/api/v1/${accounting(`events/${eventId}/repair-preview`)}`)
            .set("Cookie", adminCookie)
            .set("X-Blueline-Session", "cookie")
            .send({ force: true })
            .expect(400);
          await get(`${base(companyA)}/accounting/events/${eventId}`).expect(404);
          await get(accounting("events/not-a-uuid")).expect(400);
          expect(await footprint()).toBe(before);
        });

        it("M / N: execute -- preview reader 403, Company user refused, Super Admin refused (not READY), zero mutation", async () => {
          const preview = await request(server)
            .post(`/api/v1/${accounting(`events/${eventId}/repair-preview`)}`)
            .set("Cookie", adminCookie)
            .set("X-Blueline-Session", "cookie")
            .send({})
            .expect(200);
          const body = {
            capabilityCode: "REPROCESS_ACCOUNTING_EVENT",
            findingId: preview.body.finding.findingId,
            idempotencyKey: `rc-http-acc-${randomUUID()}`,
            previewVersion: preview.body.previewVersion,
            reason: "Historical failure",
          };
          const before = await footprint();
          const post = (cookie: string) =>
            request(server)
              .post(`/api/v1/${accounting(`events/${eventId}/execute`)}`)
              .set("Cookie", cookie)
              .set("X-Blueline-Session", "cookie")
              .send(body);
          await post(readerWithPreviewCookie).expect(403);
          await post(readerCookie).expect(403);
          const companyUser = await request(server)
            .post(`/api/v1/${accounting(`events/${eventId}/execute`)}`)
            .set("Authorization", `Bearer ${companyUserToken}`)
            .send(body);
          expect([401, 403]).toContain(companyUser.status);
          const admin = await post(adminCookie).expect(409);
          expect(JSON.stringify(admin.body)).toContain("repair_not_ready");
          await request(server)
            .post(`/api/v1/${base(companyA)}/accounting/events/${eventId}/execute`)
            .set("Cookie", adminCookie)
            .set("X-Blueline-Session", "cookie")
            .send(body)
            .expect(404);
          await request(server)
            .post(`/api/v1/${accounting(`events/${eventId}/execute`)}`)
            .set("Cookie", adminCookie)
            .set("X-Blueline-Session", "cookie")
            .send({ ...body, journal: { lines: [] } })
            .expect(400);
          expect(await footprint()).toBe(before);
        });
      });

      // =======================================================================
      // Phase 5 Prompt 1 -- Payroll Health and Payroll repair over HTTP.
      // =======================================================================
      describe("Phase 5 Prompt 1 -- Payroll Health and Payroll repair over HTTP", () => {
        const payroll = (path: string) => `${base(companyC)}/payroll/${path}`;
        let periodId = "";
        const payrollFootprint = async () =>
          (
            await sql<{ fp: string }>`select md5(concat_ws('|',
                (select string_agg(concat_ws(':', id, status, total_net_salary, total_outstanding, version), ',' order by id)
                   from payroll_periods where company_id = ${companyC}::uuid),
                (select count(*) from platform_repair_executions),
                (select count(*) from platform_repair_attempts),
                (select count(*) from audit_events))) as fp`.execute(db)
          ).rows[0]!.fp;
        const postAs = (path: string, cookie: string, body: object) =>
          request(server)
            .post(`/api/v1/${path}`)
            .set("Cookie", cookie)
            .set("X-Blueline-Session", "cookie")
            .send(body);

        beforeAll(async () => {
          // Crafted DRAFT period whose header totals disagree with its (zero)
          // lines -- a derived cache the Payroll domain rebuilds deterministically.
          periodId = randomUUID();
          await sql`insert into payroll_periods (id, company_id, period_start, period_end, payroll_month, status,
              period_reference, total_net_salary, total_outstanding)
            values (${periodId}::uuid, ${companyC}::uuid, date '2019-03-01', date '2019-03-31', date '2019-03-01',
              'draft', 'PAY-HTTP-2019-03', 10, 10)`.execute(db);
        });

        it("summary and findings: Super Admin 200; reader 403; anonymous 401; validated; read-only", async () => {
          const before = await payrollFootprint();
          const summary = await get(payroll("health/summary")).expect(200);
          expect(summary.body).toMatchObject({ companyId: companyC, payrollHealth: "ISSUE" });
          expect(summary.body.headlines).toContain("ISSUE — Payroll calculation is inconsistent.");
          const list = await get(payroll("health/findings")).expect(200);
          const row = list.body.items.find((item: { entityId: string }) => item.entityId === periodId);
          expect(row).toMatchObject({ entityType: "payroll_period", health: "ISSUE", reference: "PAY-HTTP-2019-03" });
          expect(row.codes).toContain("PAYROLL_PERIOD_TOTALS_MISMATCH");
          await get(payroll("health/findings?status=all&page=1&pageSize=5")).expect(200);
          await get(payroll("health/summary"), readerCookie).expect(403);
          await get(payroll("health/findings"), readerCookie).expect(403);
          await request(server).get(`/api/v1/${payroll("health/summary")}`).expect(401);
          await get(payroll("health/findings?status=nope")).expect(400);
          await get(payroll("health/findings?pageSize=1000")).expect(400);
          await get(payroll(`health/findings?companyId=${companyA}`)).expect(400);
          expect(await payrollFootprint()).toBe(before);
        });

        it("preview: READY totals rebuild, tenant-scoped, validated, read-only", async () => {
          const before = await payrollFootprint();
          const preview = await postAs(payroll(`periods/${periodId}/repair-preview`), adminCookie, {}).expect(200);
          const finding = preview.body.findings.find(
            (item: { reasonCode: string }) => item.reasonCode === "PAYROLL_PERIOD_TOTALS_MISMATCH",
          );
          expect(finding).toMatchObject({ repairCapability: "REBUILD_PAYROLL_PERIOD_TOTALS", repairability: "READY", execution: { available: true } });
          expect(preview.body.previewVersion).toMatch(/^prv1:[0-9a-f]{64}$/u);
          await postAs(payroll(`periods/${periodId}/repair-preview`), adminCookie, { force: true }).expect(400);
          await postAs(payroll(`periods/${periodId}/repair-preview`), readerCookie, {}).expect(403);
          await postAs(`${base(companyA)}/payroll/periods/${periodId}/repair-preview`, adminCookie, {}).expect(404);
          await postAs(payroll("periods/not-a-uuid/repair-preview"), adminCookie, {}).expect(400);
          await postAs(payroll(`periods/${randomUUID()}/repair-preview`), adminCookie, {}).expect(404);
          expect(await payrollFootprint()).toBe(before);
        });

        it("execute: reader 403, Company user refused, wrong Company 404, extra field 400, stale 409; Super Admin repairs once; replay", async () => {
          const preview = await postAs(payroll(`periods/${periodId}/repair-preview`), adminCookie, {}).expect(200);
          const finding = preview.body.findings.find(
            (item: { reasonCode: string }) => item.reasonCode === "PAYROLL_PERIOD_TOTALS_MISMATCH",
          );
          const body = {
            capabilityCode: "REBUILD_PAYROLL_PERIOD_TOTALS",
            findingId: finding.findingId,
            idempotencyKey: `rc-http-pay-${randomUUID()}`,
            previewVersion: preview.body.previewVersion,
            reason: "Header totals disagree with lines",
          };
          const execute = payroll(`periods/${periodId}/execute`);
          const before = await payrollFootprint();
          await postAs(execute, readerWithPreviewCookie, body).expect(403);
          await postAs(execute, readerCookie, body).expect(403);
          const companyUser = await request(server)
            .post(`/api/v1/${execute}`)
            .set("Authorization", `Bearer ${companyUserToken}`)
            .send(body);
          expect([401, 403]).toContain(companyUser.status);
          await postAs(execute, adminCookie, { ...body, totals: { net: 0 } }).expect(400);
          expect(await payrollFootprint()).toBe(before);
          // Wrong Company: 404, nothing of Company C touched; the identified
          // refusal is durably recorded against the Company in the path.
          const refusedA = async () =>
            (
              await sql<{ n: number }>`select count(*)::int as n from platform_repair_attempts
                where company_id = ${companyA}::uuid and entity_type = 'payroll_period' and result = 'REFUSED'`.execute(db)
            ).rows[0]!.n;
          const refusedBefore = await refusedA();
          await postAs(`${base(companyA)}/payroll/periods/${periodId}/execute`, adminCookie, body).expect(404);
          expect(await refusedA()).toBe(refusedBefore + 1);
          const stale = await postAs(execute, adminCookie, {
            ...body,
            idempotencyKey: `rc-http-pay-${randomUUID()}`,
            previewVersion: `prv1:${"0".repeat(64)}`,
          }).expect(409);
          expect(JSON.stringify(stale.body)).toContain("repair_preview_stale");
          const done = await postAs(execute, adminCookie, body).expect(200);
          expect(JSON.stringify(done.body)).toContain("REBUILD_PAYROLL_PERIOD_TOTALS");
          const replay = await postAs(execute, adminCookie, body).expect(200);
          expect(replay.body).toEqual({ ...done.body, replayed: true });
          const row = (
            await sql<{ net: string; out: string }>`select total_net_salary::text as net, total_outstanding::text as out
              from payroll_periods where id = ${periodId}::uuid`.execute(db)
          ).rows[0]!;
          expect(Number(row.net)).toBe(0);
          expect(Number(row.out)).toBe(0);
          const audit = await sql<{ n: number }>`select count(*)::int as n from platform_repair_executions
            where company_id = ${companyC}::uuid and entity_type = 'payroll_period' and entity_id = ${periodId}::uuid
              and actor_account_id = ${adminId}::uuid`.execute(db);
          expect(audit.rows[0]!.n).toBe(1);
          const after = await postAs(payroll(`periods/${periodId}/repair-preview`), adminCookie, {}).expect(200);
          expect(
            after.body.findings.some((item: { reasonCode: string }) => item.reasonCode === "PAYROLL_PERIOD_TOTALS_MISMATCH"),
          ).toBe(false);
        });
      });

      // =======================================================================
      // Phase 2 Prompt 5 -- overview + Repair History over HTTP (Parts F-J, U).
      // =======================================================================
      describe("Phase 2 Prompt 5 -- overview and Repair History over HTTP", () => {
        const attemptCount = async (companyId: string) =>
          (
            await sql<{ n: number }>`select count(*)::int as n from platform_repair_attempts
              where company_id = ${companyId}::uuid`.execute(db)
          ).rows[0]!.n;
        const auditCount = async () =>
          (await sql<{ n: number }>`select count(*)::int as n from audit_events`.execute(db)).rows[0]!.n;
        const asCompanyUser = (path: string) =>
          request(server).get(`/api/v1/${path}`).set("Authorization", `Bearer ${companyUserToken}`);

        it("anti-amplification: 403 / 401 / malformed requests are NOT recorded as attempts; an identified refusal is", async () => {
          const body = await bodyFor(orders.blocked);
          const before = await attemptCount(companyC);
          await execute(orders.blocked, body, readerWithPreviewCookie).expect(403);
          await execute(orders.blocked, body, readerCookie).expect(403);
          await request(server).post(`/api/v1/${base(companyC)}/orders/${orders.blocked}/execute`).send(body).expect(401);
          const companyUser = await request(server)
            .post(`/api/v1/${base(companyC)}/orders/${orders.blocked}/execute`)
            .set("Authorization", `Bearer ${companyUserToken}`)
            .send(body);
          expect([401, 403]).toContain(companyUser.status);
          await execute(orders.blocked, { ...body, force: true }).expect(400);
          await execute(orders.blocked, body, adminCookie, randomUUID()).expect(404);
          expect(await attemptCount(companyC)).toBe(before);
          // The identified Super Admin's refusal IS durable.
          const refused = await execute(orders.blocked, body).expect(409);
          expect(JSON.stringify(refused.body)).toContain("repair_not_ready");
          expect(await attemptCount(companyC)).toBe(before + 1);
        });

        it("overview: Super Admin and the read-only Repair Center role see it; others refused; nothing written", async () => {
          const attempts = await attemptCount(companyC);
          const audits = await auditCount();
          const admin = await get(`${base(companyC)}/overview`).expect(200);
          expect(admin.body).toMatchObject({
            accountingHealth: { readyCandidateNote: expect.stringMatching(/READY is decided only by Preview/u) },
            accountingMode: { enabled: false },
            companyId: companyC,
            orderHealth: { totalOrders: expect.any(Number) },
            repairHistory: { refused: expect.any(Number), succeeded: expect.any(Number) },
          });
          expect(admin.body.repairHistory.refused).toBeGreaterThanOrEqual(1);
          expect(Object.keys(admin.body.accountingHealth)).not.toContain("ready");
          await get(`${base(companyC)}/overview`, readerWithPreviewCookie).expect(200);
          await get(`${base(companyC)}/overview`, readerCookie).expect(403);
          await request(server).get(`/api/v1/${base(companyC)}/overview`).expect(401);
          expect([401, 403]).toContain((await asCompanyUser(`${base(companyC)}/overview`)).status);
          await get(`${base(randomUUID())}/overview`).expect(404);
          await get(`platform/companies/not-a-uuid/repair-center/overview`).expect(404);
          expect(await attemptCount(companyC)).toBe(attempts);
          expect(await auditCount()).toBe(audits);
        });

        it("history: read permission is enough (no execute needed); others refused; validation; no PII; nothing written", async () => {
          const attempts = await attemptCount(companyC);
          const audits = await auditCount();
          const admin = await get(`${base(companyC)}/history`).expect(200);
          expect(admin.body.total).toBeGreaterThanOrEqual(1);
          const times = admin.body.items.map((row: { occurredAt: string }) => row.occurredAt);
          expect([...times].sort().reverse()).toEqual(times);
          const text = JSON.stringify(admin.body);
          expect(text).not.toMatch(/Private Customer|971500000001|Private Address|idempotency|rc-http-/u);
          const reader = await get(`${base(companyC)}/history`, readerWithPreviewCookie).expect(200);
          expect(reader.body.total).toBe(admin.body.total);
          await get(`${base(companyC)}/history`, readerCookie).expect(403);
          await request(server).get(`/api/v1/${base(companyC)}/history`).expect(401);
          expect([401, 403]).toContain((await asCompanyUser(`${base(companyC)}/history`)).status);
          await get(`${base(companyC)}/history?companyId=${companyA}`).expect(400);
          await get(`${base(companyC)}/history?pageSize=101`).expect(400);
          await get(`${base(companyC)}/history?result=DELETED`).expect(400);
          const refused = await get(`${base(companyC)}/history?result=REFUSED&pageSize=5`).expect(200);
          expect(refused.body.items.every((row: { result: string }) => row.result === "REFUSED")).toBe(true);
          const first = refused.body.items[0] as { id: string; kind: string };
          const detail = await get(`${base(companyC)}/history/${first.kind}/${first.id}`, readerWithPreviewCookie).expect(200);
          expect(detail.body).toMatchObject({ companyId: companyC, execution: null, repairApplied: false });
          expect(detail.body.repairAppliedStatement).toMatch(/^No repair was applied/u);
          await get(`${base(companyC)}/history/everything/${first.id}`).expect(400);
          await get(`${base(companyC)}/history/attempt/not-a-uuid`).expect(400);
          await get(`${base(companyC)}/history/attempt/${randomUUID()}`).expect(404);
          await get(`${base(companyC)}/history/${first.kind}/${first.id}`, readerCookie).expect(403);
          expect(await attemptCount(companyC)).toBe(attempts);
          expect(await auditCount()).toBe(audits);
        });

        it("cross-Company: Company A's path never exposes Company C's history (same order number ORD-0001 in both)", async () => {
          const c = await get(`${base(companyC)}/history?pageSize=100`).expect(200);
          const cIds = new Set(c.body.items.map((row: { id: string }) => row.id));
          const cRecord = c.body.items[0] as { id: string; kind: string; entityNumber: string | null };
          // A refused attempt in Company A on its own ORD-0001.
          const aPreview = await preview(companyA, orderA).expect(200);
          await execute(
            orderA,
            {
              capabilityCode: "REPAIR_TRADER_RECEIVABLE",
              findingId: "fnd_000000000000000000000000",
              idempotencyKey: `rc-http-${randomUUID()}`,
              previewVersion: aPreview.body.previewVersion,
              reason: "Cross-company check",
            },
            adminCookie,
            companyA,
          ).expect(409);
          const a = await get(`${base(companyA)}/history?pageSize=100`).expect(200);
          expect(a.body.items.length).toBeGreaterThanOrEqual(1);
          const companyCOrders = new Set(
            (
              await sql<{ id: string }>`select id from orders where company_id = ${companyC}::uuid`.execute(db)
            ).rows.map((row) => row.id),
          );
          for (const row of a.body.items as { id: string; entityId: string; entityNumber: string | null }[]) {
            // No Company C record, and no Company C business reference, through A's path.
            expect(cIds.has(row.id)).toBe(false);
            if (row.entityNumber !== null) expect(companyCOrders.has(row.entityId)).toBe(false);
          }
          expect(a.body.items.map((row: { entityId: string }) => row.entityId)).toContain(orderA);
          await get(`${base(companyA)}/history/${cRecord.kind}/${cRecord.id}`).expect(404);
          await get(`${base(companyB)}/history/${cRecord.kind}/${cRecord.id}`).expect(404);
          const b = await get(`${base(companyB)}/history`).expect(200);
          expect(b.body.total).toBe(0);
          const aOverview = await get(`${base(companyA)}/overview`).expect(200);
          const cOverview = await get(`${base(companyC)}/overview`).expect(200);
          expect(aOverview.body.repairHistory.refused).toBe(
            a.body.items.filter((row: { result: string }) => row.result === "REFUSED").length,
          );
          expect(cOverview.body.companyId).toBe(companyC);
        });
      });
    });
  });
});
