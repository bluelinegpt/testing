import { randomUUID } from "node:crypto";

import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { unzipSync } from "fflate";

import { AppModule } from "../app.module.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApiExceptionFilter } from "../presentation/errors/api-exception.filter.js";
import { Logger } from "nestjs-pino";
import { CompanyHostResolver } from "../tenancy/company-host-resolver.js";

function binary(requestBuilder: request.Test): request.Test {
  return requestBuilder.buffer(true).parse((response, callback) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => callback(null, Buffer.concat(chunks)));
  });
}

const enabled = process.env.RUN_ORDERS_REPORT_HTTP_DATABASE === "true";
const expectedUrl = "postgresql://LENOVO@127.0.0.1:55432/blueline_stage2_international_20260930";

describe.skipIf(!enabled)("Orders Report authenticated export routes", () => {
  let pool: Pool;
  let database: Kysely<DatabaseSchema>;
  let app: INestApplication;

  afterAll(async () => {
    await app?.close();
    await database?.destroy();
  });

  it("exports all filtered rows through the real authenticated routes", async () => {
    expect(process.env.BLUELINE_DISABLE_DOTENV).toBe("1");
    expect(process.env.DATABASE_URL).toBe(expectedUrl);
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const identity = await sql<{ database: string; host: string; port: number }>`
      select current_database() as database, host(inet_server_addr()) as host, inet_server_port() as port
    `.execute(database);
    expect(identity.rows[0]).toEqual({
      database: "blueline_stage2_international_20260930",
      host: "127.0.0.1",
      port: 55432,
    });

    const companyId = randomUUID();
    const accountId = randomUUID();
    const roleId = randomUUID();
    const traderId = randomUUID();
    const emirateId = randomUUID();
    const areaId = randomUUID();
    const password = "Orders-report-test-password";
    const username = `orders-report-${randomUUID().slice(0, 8)}`;
    const subdomain = `orders-report-${randomUUID().slice(0, 8)}`;
    await database.transaction().execute(async (tx) => {
      await sql`insert into permissions(code, description) values ('reports.export', 'Orders report test') on conflict (code) do nothing`.execute(tx);
      await sql`insert into companies(id,code,subdomain,name_en,name_ar,status,activated_at)
        values (${companyId}::uuid,${`RPT-${companyId.slice(0,8)}`},${subdomain},'Orders Export Test','تقرير الطلبات','active',now())`.execute(tx);
      const hash = await new PasswordHasher().hash(password);
      await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status,password_changed_at)
        values (${accountId}::uuid,${companyId}::uuid,'company_user',${username},${hash},'active',now())`.execute(tx);
      await sql`insert into company_users(company_id,account_id,display_name,name_en,name_ar)
        values (${companyId}::uuid,${accountId}::uuid,'Orders Administrator','Orders Administrator','مدير الطلبات')`.execute(tx);
      await sql`insert into roles(id,company_id,code,name,is_system) values
        (${roleId}::uuid,${companyId}::uuid,'report_admin','Report Administrator',true)`.execute(tx);
      await sql`insert into role_permissions(role_id,permission_code) values (${roleId}::uuid,'reports.export')`.execute(tx);
      await sql`insert into account_roles(account_id,role_id,company_id) values (${accountId}::uuid,${roleId}::uuid,${companyId}::uuid)`.execute(tx);
      const existingEmirate = await sql<{ id: string }>`select id from emirates where code = 'DXB' limit 1`.execute(tx);
      const emirate = existingEmirate.rows[0]?.id ?? emirateId;
      if (existingEmirate.rows[0] === undefined) {
        await sql`insert into emirates(id,code,name_en,name_ar,display_order)
          values (${emirateId}::uuid,'DXB','Dubai','دبي',999)`.execute(tx);
      }
      await sql`insert into areas(id,company_id,code,name_en,name_ar,emirate_id)
        values (${areaId}::uuid,${companyId}::uuid,${`RPT-${companyId.slice(0,6)}`},'Report Area','منطقة التقرير',${emirate}::uuid)`.execute(tx);
      await sql`insert into traders(id,company_id,code,name_en,name_ar,mobile_number,pickup_area_id,created_by_account_id)
        values (${traderId}::uuid,${companyId}::uuid,${`RPT-${companyId.slice(0,6)}`},'Report Trader','تاجر التقرير','971500000001',${areaId}::uuid,${accountId}::uuid)`.execute(tx);
      for (let i = 0; i < 205; i += 1) {
        const id = randomUUID();
        const status = i % 2 === 0 ? "delivered" : "new";
        await sql`insert into orders(id,company_id,order_number,order_date,trader_id,area_id,created_by_account_id,
          customer_name,customer_mobile_number,customer_address,package_count,payment_condition,service_fee,
          final_service_fee_snapshot,configured_service_fee_snapshot,customer_provenance_status,pricing_provenance_status,customer_amount_due,
          trader_gross_payable,trader_paid_service_fee,trader_net_payable,trader_paid_amount,delivery_status,
          driver_reconciliation_status,trader_settlement_status,return_status)
          values (${id}::uuid,${companyId}::uuid,${`RPT-${String(i).padStart(4,"0")}`},current_date,
          ${traderId}::uuid,${areaId}::uuid,${accountId}::uuid,${i % 2 === 0 ? "عميل عربي" : "English Customer"},
          '971500000002','Address',1,'customer_pays_cod_trader_pays_fee',18,18,18,'legacy_unattributed','manual',0,0,18,0,0,
          ${status},'not_applicable','not_eligible','not_applicable')`.execute(tx);
      }
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(DATABASE).useValue(tx)
        .overrideProvider(CompanyHostResolver).useValue({
          resolve: (host: string | undefined) => host?.split(".")[0],
          isReservedHost: () => false,
        })
        .compile();
      app = module.createNestApplication();
      app.setGlobalPrefix("api/v1");
      app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
      app.useGlobalFilters(new ApiExceptionFilter(app.get(Logger)));
      await app.init();
      const login = await request(app.getHttpServer()).post("/api/v1/auth/login").set("Host", `${subdomain}.blueline.test`)
        .send({ identifier: username, password }).expect(200);
      const token = String(login.body.accessToken);
      const query = "dateFrom=2026-01-01&dateTo=2027-01-01&statuses=delivered,new";
      const xlsx = await binary(request(app.getHttpServer()).get(`/api/v1/operations/reports/orders.xlsx?${query}`).set("Authorization", `Bearer ${token}`)).expect(200);
      expect(xlsx.headers["content-type"]).toContain("spreadsheetml");
      expect(Buffer.isBuffer(xlsx.body)).toBe(true);
      expect(xlsx.body.length).toBeGreaterThan(1000);
      const sheetXml = Buffer.from(unzipSync(xlsx.body)["xl/worksheets/sheet1.xml"]).toString("utf8");
      // Header + 205 orders + the totals row.
      expect((sheetXml.match(/<row\b/g) ?? []).length).toBe(207);
      const allStatuses = await binary(request(app.getHttpServer()).get("/api/v1/operations/reports/orders.xlsx?dateFrom=2026-01-01&dateTo=2027-01-01").set("Authorization", `Bearer ${token}`)).expect(200);
      expect(Buffer.from(allStatuses.body).subarray(0, 2).toString()).toBe("PK");
      const pdf = await binary(request(app.getHttpServer()).get(`/api/v1/operations/reports/orders.pdf?${query}`).set("Authorization", `Bearer ${token}`)).expect(200);
      expect(pdf.headers["content-type"]).toContain("application/pdf");
      expect(Buffer.isBuffer(pdf.body)).toBe(true);
      expect(pdf.body.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdf.body.length).toBeGreaterThan(1000);
      const allStatusesPdf = await binary(request(app.getHttpServer()).get("/api/v1/operations/reports/orders.pdf?dateFrom=2026-01-01&dateTo=2027-01-01").set("Authorization", `Bearer ${token}`)).expect(200);
      expect(allStatusesPdf.body.subarray(0, 5).toString()).toBe("%PDF-");
    });
  }, 120_000);
});
