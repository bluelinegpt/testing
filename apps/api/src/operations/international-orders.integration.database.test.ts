import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { Logger } from "nestjs-pino";
import { describe, expect, it } from "vitest";
import { AppModule } from "../app.module.js";
import { PasswordHasher } from "../authentication/password-hasher.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApiExceptionFilter } from "../presentation/errors/api-exception.filter.js";
import { CompanyHostResolver } from "../tenancy/company-host-resolver.js";
import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { OperationsService } from "./operations.service.js";

function connect() { loadEnvironment({ path: resolve(process.cwd(), "../../.env") }); return new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: configuration().database.url, max: 1 }) }) }); }
async function rollback(work: (tx: Transaction<DatabaseSchema>) => Promise<void>) { const db = connect(); const marker = new Error("rollback international persistence"); try { await expect(db.transaction().execute(async tx => { await work(tx); throw marker; })).rejects.toBe(marker); } finally { await db.destroy(); } }

describe("International order carrier and country persistence", () => {
  it("reads, edits, reopens, and persists carrier/country IDs and names", async () => {
    await rollback(async database => {
      const companyId=randomUUID(), actorId=randomUUID(), areaId=randomUUID(), traderId=randomUUID(), customerId=randomUUID(), addressId=randomUUID(), orderId=randomUUID();
      const carrierA=randomUUID(), carrierB=randomUUID(), countryA=randomUUID(), countryB=randomUUID(), suffix=companyId.slice(0,8);
      const emirateId=randomUUID();
      await sql`insert into emirates(id,code,name_en,name_ar,display_order) values(${emirateId}::uuid,'TST','Test Emirate','إمارة',999)`.execute(database);
      await sql`insert into companies(id,code,subdomain,name_en,status,activated_at) values(${companyId}::uuid,${`INT-${suffix}`},${`int-${suffix}`},'International Test','active',now())`.execute(database);
      await sql`insert into accounts(id,company_id,account_kind,username,password_hash) values(${actorId}::uuid,${companyId}::uuid,'company_user',${`int.${suffix}`},'x')`.execute(database);
      await sql`insert into areas(id,company_id,code,name_en,name_ar,emirate_id) values(${areaId}::uuid,${companyId}::uuid,${`A-${suffix}`},'Area','منطقة',${emirateId}::uuid)`.execute(database);
      await sql`insert into traders(id,company_id,code,name_en,mobile_number,pickup_area_id,created_by_account_id) values(${traderId}::uuid,${companyId}::uuid,${`T-${suffix}`},'Trader','971500000003',${areaId}::uuid,${actorId}::uuid)`.execute(database);
      await sql`insert into customers(id,company_id,code,name,mobile_number,created_by_account_id) values(${customerId}::uuid,${companyId}::uuid,${`CUS-${suffix}`},'Customer','971500000009',${actorId}::uuid)`.execute(database);
      await sql`insert into customer_addresses(id,company_id,customer_id,area_id,address,is_default,created_by_account_id) values(${addressId}::uuid,${companyId}::uuid,${customerId}::uuid,${areaId}::uuid,'Address',true,${actorId}::uuid)`.execute(database);
      await sql`insert into third_party_delivery_companies(id,company_id,name,is_active) values(${carrierA}::uuid,${companyId}::uuid,'Carrier A',true),(${carrierB}::uuid,${companyId}::uuid,'Carrier B',true)`.execute(database);
      await sql`insert into destination_countries(id,company_id,name,normalized_name,is_active) values(${countryA}::uuid,${companyId}::uuid,'Oman','oman',true),(${countryB}::uuid,${companyId}::uuid,'Qatar','qatar',true)`.execute(database);
      await sql`insert into orders(id,company_id,order_number,order_date,order_type,trader_id,area_id,created_by_account_id,customer_name,customer_mobile_number,customer_address,package_count,payment_condition,cod_amount,service_fee,final_service_fee_snapshot,configured_service_fee_snapshot,service_fee_override_reason,customer_provenance_status,pricing_provenance_status,customer_id,customer_address_id,customer_code_snapshot,customer_area_code_snapshot,customer_area_name_snapshot,destination_country_id,destination_country_name,third_party_delivery_company_id,third_party_delivery_company_name) values(${orderId}::uuid,${companyId}::uuid,${`ORD-${suffix}`},current_date,'gcc_international',${traderId}::uuid,${areaId}::uuid,${actorId}::uuid,'Customer','971500000009','Address',1,'customer_pays_cod_and_fee',0,0,0,0,'Configured Trader/Area price is zero','resolved','manual',${customerId}::uuid,${addressId}::uuid,${`CUS-${suffix}`},${`A-${suffix}`},'Area',${countryA}::uuid,'Oman',${carrierA}::uuid,'Carrier A')`.execute(database);
      const service=Object.create(OperationsService.prototype) as Pick<OperationsService, "orders"> & { database:Kysely<DatabaseSchema>; tenants:{current:()=>{companyId:string}}; identities:{current:()=>{kind:string}} };
      service.database=database; service.tenants={current:()=>({companyId})}; service.identities={current:()=>({kind:"company_user"})};
      const read=()=>service.orders({orderType:"gcc_international",search:`ORD-${suffix}`});
      expect((await read()).items[0]).toMatchObject({id:orderId,destinationCountryId:countryA,destinationCountryName:"Oman",thirdPartyDeliveryCompanyId:carrierA,thirdPartyDeliveryCompanyName:"Carrier A"});
      expect((await sql`select destination_country_id,third_party_delivery_company_id from orders where id=${orderId}::uuid`.execute(database)).rows[0]).toEqual({destination_country_id:countryA,third_party_delivery_company_id:carrierA});
      await sql`update orders set destination_country_id=${countryB}::uuid,destination_country_name='Qatar',third_party_delivery_company_id=${carrierB}::uuid,third_party_delivery_company_name='Carrier B' where id=${orderId}::uuid`.execute(database);
      expect((await read()).items[0]).toMatchObject({destinationCountryId:countryB,destinationCountryName:"Qatar",thirdPartyDeliveryCompanyId:carrierB,thirdPartyDeliveryCompanyName:"Carrier B"});
      expect((await sql`select destination_country_id,third_party_delivery_company_id from orders where id=${orderId}::uuid`.execute(database)).rows[0]).toEqual({destination_country_id:countryB,third_party_delivery_company_id:carrierB});
    });
  });

  it("rejects Company B carrier and country IDs on Company A create and edit routes", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const marker = new Error("rollback international HTTP tenant test");

    try {
      await expect(database.transaction().execute(async transaction => {
        const module = await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(DATABASE).useValue(transaction)
          .overrideProvider(KyselyTransactionManager).useValue({ execute: (work: (value: typeof transaction) => unknown) => work(transaction) })
          .overrideProvider(CompanyHostResolver).useValue({ resolve: (host: string | undefined) => host?.split(".")[0] })
          .compile();
        let app: INestApplication | undefined;
        try {
          app = module.createNestApplication();
          app.setGlobalPrefix("api/v1");
          app.useGlobalPipes(new ValidationPipe({ forbidNonWhitelisted: true, stopAtFirstError: false, transform: true, whitelist: true }));
          app.useGlobalFilters(new ApiExceptionFilter(app.get(Logger)));
          await app.init();
          const server = app.getHttpServer();
          const hasher = new PasswordHasher();

          const makeCompany = async (label: string) => {
            const companyId = randomUUID();
            const accountId = randomUUID();
            const roleId = randomUUID();
            const suffix = randomUUID().slice(0, 8);
            const subdomain = `http-int-${label}-${suffix}`;
            const password = `HTTP-int-${label}-password`;
            const hash = await hasher.hash(password);
            await sql`insert into companies(id,code,subdomain,name_en,status,activated_at) values(${companyId}::uuid,${`IHT-${label}-${suffix}`},${subdomain},${`International HTTP ${label}`},'active',now())`.execute(transaction);
            await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status,password_changed_at) values(${accountId}::uuid,${companyId}::uuid,'company_user',${`administrator-${label}`},${hash},'active',now())`.execute(transaction);
            await sql`insert into company_users(company_id,account_id,display_name,name_en) values(${companyId}::uuid,${accountId}::uuid,'HTTP Admin','HTTP Admin')`.execute(transaction);
            await sql`insert into roles(id,company_id,code,name,is_system) values(${roleId}::uuid,${companyId}::uuid,'company_admin',${`HTTP Admin ${label}`},true)`.execute(transaction);
            await sql`insert into permissions(code,description) values('users_roles.manage','Test role management') on conflict (code) do nothing`.execute(transaction);
            await sql`insert into role_permissions(role_id,permission_code) values(${roleId}::uuid,'users_roles.manage')`.execute(transaction);
            await sql`insert into account_roles(account_id,role_id,company_id) values(${accountId}::uuid,${roleId}::uuid,${companyId}::uuid)`.execute(transaction);
            const login = await request(server).post("/api/v1/auth/login").set("Host", `${subdomain}.blueline.test`).send({ identifier: `administrator-${label}`, password }).expect(200);
            return { accountId, companyId, token: String(login.body.accessToken), subdomain };
          };

          const a = await makeCompany("a");
          const b = await makeCompany("b");
          const emirateId = randomUUID();
          const areaId = randomUUID();
          const traderId = randomUUID();
          const driverId = randomUUID();
          const driverAccountId = randomUUID();
          const customerId = randomUUID();
          const addressId = randomUUID();
          const carrierA = randomUUID();
          const carrierB = randomUUID();
          const carrierC = randomUUID();
          const carrierD = randomUUID();
          const countryA = randomUUID();
          const countryB = randomUUID();
          const countryC = randomUUID();
          const countryD = randomUUID();
          const suffix = randomUUID().slice(0, 8);
          const driverUsername = `driver-${suffix}`;
          const driverPassword = `HTTP-int-driver-${suffix}-password`;
          const driverHash = await hasher.hash(driverPassword);
          await sql`insert into emirates(id,code,name_en,name_ar,display_order) values(${emirateId}::uuid,'HTP','HTTP Test','إمارة',999)`.execute(transaction);
          await sql`insert into areas(id,company_id,code,name_en,name_ar,emirate_id) values(${areaId}::uuid,${a.companyId}::uuid,${`HT-${suffix}`},'HTTP Area','منطقة',${emirateId}::uuid)`.execute(transaction);
          await sql`insert into traders(id,company_id,code,name_en,mobile_number,pickup_area_id) values(${traderId}::uuid,${a.companyId}::uuid,${`HT-${suffix}`},'HTTP Trader','971500000003',${areaId}::uuid)`.execute(transaction);
          await sql`insert into accounts(id,company_id,account_kind,username,password_hash,status,password_changed_at) values(${driverAccountId}::uuid,${a.companyId}::uuid,'driver',${driverUsername},${driverHash},'active',now())`.execute(transaction);
          await sql`insert into drivers(id,company_id,account_id,code,name_en,mobile_number,driver_type,account_status,outsourced_fee_per_delivered_order) values(${driverId}::uuid,${a.companyId}::uuid,${driverAccountId}::uuid,${`HD-${suffix}`},'HTTP Driver','971500000004','outsourced','active',0)`.execute(transaction);
          await sql`insert into user_business_links(id,company_id,account_id,entity_type,entity_id,access_status,is_primary,created_by_account_id) values(${randomUUID()}::uuid,${a.companyId}::uuid,${driverAccountId}::uuid,'driver',${driverId}::uuid,'active',true,${a.accountId}::uuid)`.execute(transaction);
          await sql`insert into customers(id,company_id,code,name,mobile_number,created_by_account_id) values(${customerId}::uuid,${a.companyId}::uuid,${`HC-${suffix}`},'HTTP Customer','971500000009',${a.accountId}::uuid)`.execute(transaction);
          await sql`insert into customer_addresses(id,company_id,customer_id,area_id,address,is_default,created_by_account_id) values(${addressId}::uuid,${a.companyId}::uuid,${customerId}::uuid,${areaId}::uuid,'HTTP Address',true,${a.accountId}::uuid)`.execute(transaction);
          await sql`insert into third_party_delivery_companies(id,company_id,name,is_active) values(${carrierA}::uuid,${a.companyId}::uuid,'A Carrier',true),(${carrierB}::uuid,${b.companyId}::uuid,'B Carrier',true),(${carrierC}::uuid,${a.companyId}::uuid,'C Carrier',true),(${carrierD}::uuid,${a.companyId}::uuid,'D Carrier',true)`.execute(transaction);
          await sql`insert into destination_countries(id,company_id,name,normalized_name,is_active) values(${countryA}::uuid,${a.companyId}::uuid,'Oman','oman',true),(${countryB}::uuid,${b.companyId}::uuid,'Qatar','qatar',true),(${countryC}::uuid,${a.companyId}::uuid,'Bahrain','bahrain',true),(${countryD}::uuid,${a.companyId}::uuid,'Kuwait','kuwait',true)`.execute(transaction);

          const createBody = (carrierId: string, countryId: string, serial: string, carrierName = "B Carrier", countryName = "Qatar") => ({ orderType: "gcc_international", serialNumber: serial, traderId, destinationCountryId: countryId, destinationCountryName: countryName, thirdPartyDeliveryCompanyId: carrierId, thirdPartyDeliveryCompanyName: carrierName, codAmount: 999, serviceFee: 0, packageCount: 1 });
          const assignedInternational = await request(server).post("/api/v1/operations/orders").set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).set("x-idempotency-key", randomUUID()).send({ ...createBody(carrierA, countryA, `HTTP-DRIVER-${suffix}`, "A Carrier", "Oman"), driverId });
          expect(assignedInternational.status).toBe(400);
          expect(assignedInternational.body.error?.code).toBe("international_driver_forbidden");
          expect((await sql<{ count: number }>`select count(*)::int as count from orders where company_id=${a.companyId}::uuid and order_number=${`HTTP-DRIVER-${suffix}`}`.execute(transaction)).rows[0]?.count).toBe(0);
          const createRejected = await request(server).post("/api/v1/operations/orders").set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).set("x-idempotency-key", randomUUID()).send(createBody(carrierB, countryB, `HTTP-BAD-${suffix}`));
          expect(createRejected.status).toBeGreaterThanOrEqual(400);
          expect((await sql<{ count: number }>`select count(*)::int as count from orders where company_id=${a.companyId}::uuid and order_number=${`HTTP-BAD-${suffix}`}`.execute(transaction)).rows[0]?.count).toBe(0);

          const customerBeforeInternational = await sql`select name,mobile_number from customers where id=${customerId}::uuid`.execute(transaction);
          const valid = await request(server).post("/api/v1/operations/orders").set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).set("x-idempotency-key", randomUUID()).send({ ...createBody(carrierA, countryA, `HTTP-GOOD-${suffix}`), destinationCountryName: "Oman", thirdPartyDeliveryCompanyName: "A Carrier" });
          expect(valid.status, JSON.stringify(valid.body)).toBe(201);
          const orderId = String(valid.body.id);
          expect((await sql`select area_id from orders where id=${orderId}::uuid`.execute(transaction)).rows[0]).toEqual({ area_id: null });
          expect((await sql`select name,mobile_number from customers where id=${customerId}::uuid`.execute(transaction)).rows[0]).toEqual(customerBeforeInternational.rows[0]);
          const before = await sql`select destination_country_id,third_party_delivery_company_id from orders where id=${orderId}::uuid`.execute(transaction);
          const domestic = await request(server).post("/api/v1/operations/orders").set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).set("x-idempotency-key", randomUUID()).send({ orderType: "delivery", serialNumber: `HTTP-DOMESTIC-ASSIGN-${suffix}`, traderId, areaId, codAmount: 125, serviceFee: 5, packageCount: 1 }).expect(201);
          const domesticOrderId = String(domestic.body.id);
          await sql`update orders set cod_amount = 125, service_fee = 5, customer_amount_due = 125 where id = ${domesticOrderId}::uuid`.execute(transaction);
          await sql`update orders set cod_amount = 999, service_fee = 0, customer_amount_due = 999 where id = ${orderId}::uuid`.execute(transaction);
          const assignmentSelection = { selectionMode: "ids", orderIds: [orderId, domesticOrderId], driverIdToAssign: driverId };
          const preview = await request(server).post("/api/v1/operations/orders/bulk-assign/preview").set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).send(assignmentSelection).expect(201);
          expect(preview.body.eligibleCount).toBe(1);
          expect(preview.body.ineligible).toEqual(expect.arrayContaining([expect.objectContaining({ reason: "International Orders cannot be assigned to an internal Driver" })]));
          const bulkAssignment = await request(server).post("/api/v1/operations/orders/bulk-assign").set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).send(assignmentSelection).expect(201);
          expect(bulkAssignment.body.processedCount).toBe(1);
          const assignmentRows = await sql<{ id: string; assigned_driver_id: string | null }>`select id,assigned_driver_id from orders where id in (${sql.join([orderId, domesticOrderId].map(id => sql`${id}::uuid`))}) order by id`.execute(transaction);
          expect(assignmentRows.rows.find(row => row.id === orderId)?.assigned_driver_id).toBeNull();
          expect(assignmentRows.rows.find(row => row.id === domesticOrderId)?.assigned_driver_id).toBe(driverId);

          // Test-only SQL deliberately recreates a historical/inconsistent row:
          // International orders are not assignable through the product API,
          // but a legacy row can still carry a Driver assignment. Keep both
          // sides of the assignment relation consistent so the authenticated
          // portal paths are exercised rather than bypassed.
          await sql`update orders set assigned_driver_id=${driverId}::uuid,delivery_status='assigned_to_driver' where id=${orderId}::uuid`.execute(transaction);
          await sql`insert into order_assignments(company_id,order_id,driver_id,assigned_by_account_id) values(${a.companyId}::uuid,${orderId}::uuid,${driverId}::uuid,${a.accountId}::uuid)`.execute(transaction);
          const driverLogin = await request(server).post("/api/v1/auth/login").set("Host", `${a.subdomain}.blueline.test`).send({ identifier: driverUsername, password: driverPassword }).expect(200);
          const driverToken = String(driverLogin.body.accessToken);
          const driverAuth = (path: string) => request(server).get(`/api/v1${path}`).set("Authorization", `Bearer ${driverToken}`).set("Host", `${a.subdomain}.blueline.test`);
          const driverPatch = (path: string, body: Record<string, unknown>) => request(server).patch(`/api/v1${path}`).set("Authorization", `Bearer ${driverToken}`).set("Host", `${a.subdomain}.blueline.test`).set("x-idempotency-key", randomUUID()).send(body);
          const driverDashboard = await driverAuth("/portal/driver/dashboard-summary").expect(200);
          expect(driverDashboard.body).toMatchObject({ assignedToMe: 1, activeTotal: 1 });
          const driverOrders = await driverAuth("/portal/driver/orders").expect(200);
          expect(driverOrders.body.map((item: { id: string }) => item.id)).toContain(domesticOrderId);
          expect(driverOrders.body.map((item: { id: string }) => item.id)).not.toContain(orderId);
          await driverAuth(`/portal/driver/orders/${orderId}/history`).expect(404);

          const internationalBeforeDriverActions = await sql`select delivery_status,assigned_driver_id,driver_reconciliation_status,amount_collected from orders where id=${orderId}::uuid`.execute(transaction);
          const collectionLinksBeforeDriverActions = await sql<{ count: number }>`select count(*)::int as count from driver_reconciliation_orders where company_id=${a.companyId}::uuid and order_id=${orderId}::uuid`.execute(transaction);
          const internationalDriverStatus = await driverPatch(`/portal/driver/orders/${orderId}/status`, { status: "out_for_delivery" });
          expect(internationalDriverStatus.status).toBe(404);
          expect(internationalDriverStatus.body.error?.code).toBe("driver_order_access_denied");
          expect((await sql`select delivery_status,assigned_driver_id,driver_reconciliation_status,amount_collected from orders where id=${orderId}::uuid`.execute(transaction)).rows[0]).toEqual(internationalBeforeDriverActions.rows[0]);
          expect((await sql<{ count: number }>`select count(*)::int as count from driver_reconciliation_orders where company_id=${a.companyId}::uuid and order_id=${orderId}::uuid`.execute(transaction)).rows[0]?.count).toBe(collectionLinksBeforeDriverActions.rows[0]?.count);

          const domesticDriverStatus = await driverPatch(`/portal/driver/orders/${domesticOrderId}/status`, { status: "out_for_delivery" }).expect(200);
          expect(domesticDriverStatus.body.deliveryStatus).toBe("out_for_delivery");

          await sql`update orders set delivery_status = 'delivered', delivered_at = now(), driver_reconciliation_status = 'pending' where id = ${domesticOrderId}::uuid`.execute(transaction);

          const reconciliationBefore = await sql<{ count: number }>`select count(*)::int as count from driver_reconciliations where company_id=${a.companyId}::uuid`.execute(transaction);
          const internationalSingleCollection = await request(server).post(`/api/v1/operations/orders/${orderId}/reconcile-cash`).set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).set("x-idempotency-key", randomUUID()).send({ paymentMethod: "cash", amount: 0 });
          expect(internationalSingleCollection.status).toBe(409);
          expect(internationalSingleCollection.body.error?.code).toBe("international_collection_forbidden");
          expect((await sql<{ count: number }>`select count(*)::int as count from driver_reconciliations where company_id=${a.companyId}::uuid`.execute(transaction)).rows[0]?.count).toBe(reconciliationBefore.rows[0]?.count);
          expect((await sql`select driver_reconciliation_status,amount_collected from orders where id=${orderId}::uuid`.execute(transaction)).rows[0]).toEqual({ driver_reconciliation_status: "not_applicable", amount_collected: "0.00" });

          const collectionSelection = { selectionMode: "ids", orderIds: [orderId, domesticOrderId], collectionPaymentMethod: "cash", payments: [], expenses: [] };
          const collectionPreview = await request(server).post("/api/v1/operations/cash/reconciliations/preview").set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).send(collectionSelection);
          expect(collectionPreview.status).toBe(409);
          expect(collectionPreview.body.error?.code).toBe("international_collection_forbidden");
          const collectionConfirmation = await request(server).post("/api/v1/operations/cash/reconciliations/selected").set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).set("x-idempotency-key", randomUUID()).send(collectionSelection);
          expect(collectionConfirmation.status).toBe(409);
          expect(collectionConfirmation.body.error?.code).toBe("international_collection_forbidden");
          expect((await sql<{ count: number }>`select count(*)::int as count from driver_reconciliation_orders where company_id=${a.companyId}::uuid and order_id=${orderId}::uuid`.execute(transaction)).rows[0]?.count).toBe(0);
          expect((await sql<{ count: number }>`select count(*)::int as count from driver_reconciliation_orders where company_id=${a.companyId}::uuid and order_id=${domesticOrderId}::uuid`.execute(transaction)).rows[0]?.count).toBe(0);

          const eligibleOrders = await request(server).get(`/api/v1/operations/cash/eligible-orders?driverId=${driverId}&page=1&pageSize=25`).set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).expect(200);
          expect(eligibleOrders.body.items.some((item: { id: string }) => item.id === orderId)).toBe(false);
          expect(eligibleOrders.body.items.some((item: { id: string }) => item.id === domesticOrderId)).toBe(true);
          expect(eligibleOrders.body.filteredTotals.orderCount).toBe(1);
          expect(eligibleOrders.body.filteredTotals.collectionTotal).toBe("125.00");
          const collectionDrivers = await request(server).get(`/api/v1/operations/cash/drivers?page=1&pageSize=25&search=HD-${suffix}`).set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).expect(200);
          const driverRow = collectionDrivers.body.items.find((item: { id: string }) => item.id === driverId);
          expect(driverRow?.pendingOrderCount).toBe(1);
          expect(driverRow?.pendingCollectionTotal).toBe("125.00");
          const collectionSummary = await request(server).get(`/api/v1/operations/cash/reconciliations/summary?driverId=${driverId}`).set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).expect(200);
          expect(collectionSummary.body.pendingOrderCount).toBe(1);
          expect(collectionSummary.body.pendingAmountToCollect).toBe("125.00");
          const internationalManifest = await request(server).post("/api/v1/operations/cash/driver-shipment-manifest/data").set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).send({ selectionMode: "ids", orderIds: [orderId] });
          expect(internationalManifest.status).toBe(400);
          expect(internationalManifest.body.error?.code).toBe("manifest_order_not_found");
          const domesticManifest = await request(server).post("/api/v1/operations/cash/driver-shipment-manifest/data").set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).send({ selectionMode: "ids", orderIds: [domesticOrderId] }).expect(201);
          expect(domesticManifest.body.orders).toEqual(expect.arrayContaining([expect.objectContaining({ orderNumber: expect.any(String) })]));
          const editRejected = await request(server).patch(`/api/v1/operations/orders/${orderId}`).set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).send({ destinationCountryId: countryB, thirdPartyDeliveryCompanyId: carrierB });
          expect(editRejected.status).toBeGreaterThanOrEqual(400);
          const after = await sql`select destination_country_id,third_party_delivery_company_id from orders where id=${orderId}::uuid`.execute(transaction);
          expect(after.rows[0]).toEqual(before.rows[0]);

          const countryOnlyRejected = await request(server).post("/api/v1/operations/orders").set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).set("x-idempotency-key", randomUUID()).send(createBody(carrierA, countryB, `HTTP-COUNTRY-${suffix}`, "A Carrier", "Qatar"));
          expect(countryOnlyRejected.status).toBe(400);
          expect(countryOnlyRejected.body.error?.code).toBe("destination_country_invalid");
          expect((await sql<{ count: number }>`select count(*)::int as count from orders where company_id=${a.companyId}::uuid and order_number=${`HTTP-COUNTRY-${suffix}`}`.execute(transaction)).rows[0]?.count).toBe(0);

          await request(server).patch(`/api/v1/operations/orders/${orderId}`).set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).send({ destinationCountryId: countryB, thirdPartyDeliveryCompanyId: carrierA }).expect(400);
          expect((await sql`select destination_country_id,third_party_delivery_company_id from orders where id=${orderId}::uuid`.execute(transaction)).rows[0]).toEqual(before.rows[0]);

          await request(server).patch(`/api/v1/operations/third-party-delivery-companies/${carrierC}/deactivate`).set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).expect(200);
          const inactiveCarrierEdit = await request(server).patch(`/api/v1/operations/orders/${orderId}`).set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).send({ destinationCountryId: countryA, thirdPartyDeliveryCompanyId: carrierC });
          expect(inactiveCarrierEdit.status).toBe(400);
          expect(inactiveCarrierEdit.body.error?.code).toBe("international_carrier_invalid");
          expect((await sql`select destination_country_id,third_party_delivery_company_id from orders where id=${orderId}::uuid`.execute(transaction)).rows[0]).toEqual(before.rows[0]);
          const inactiveCarrier = await request(server).post("/api/v1/operations/orders").set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).set("x-idempotency-key", randomUUID()).send(createBody(carrierC, countryD, `HTTP-INACTIVE-CARRIER-${suffix}`, "C Carrier", "Kuwait"));
          expect(inactiveCarrier.status).toBe(400);
          expect(inactiveCarrier.body.error?.code).toBe("international_carrier_invalid");

          await request(server).patch(`/api/v1/operations/destination-countries/${countryC}/deactivate`).set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).expect(200);
          const inactiveCountryEdit = await request(server).patch(`/api/v1/operations/orders/${orderId}`).set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).send({ destinationCountryId: countryC, thirdPartyDeliveryCompanyId: carrierA });
          expect(inactiveCountryEdit.status).toBe(400);
          expect(inactiveCountryEdit.body.error?.code).toBe("destination_country_invalid");
          expect((await sql`select destination_country_id,third_party_delivery_company_id from orders where id=${orderId}::uuid`.execute(transaction)).rows[0]).toEqual(before.rows[0]);
          const inactiveCountry = await request(server).post("/api/v1/operations/orders").set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).set("x-idempotency-key", randomUUID()).send(createBody(carrierD, countryC, `HTTP-INACTIVE-COUNTRY-${suffix}`, "D Carrier", "Bahrain"));
          expect(inactiveCountry.status).toBe(400);
          expect(inactiveCountry.body.error?.code).toBe("destination_country_invalid");
          const readable = await request(server).get(`/api/v1/operations/orders?search=HTTP-GOOD-${suffix}`).set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).expect(200);
          expect(readable.body.items.some((item: { id: string }) => item.id === orderId)).toBe(true);

          const referencedCarrierDelete = await request(server).delete(`/api/v1/operations/third-party-delivery-companies/${carrierA}`).set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`);
          expect(referencedCarrierDelete.status).toBe(409);
          const referencedCountryDelete = await request(server).delete(`/api/v1/operations/destination-countries/${countryA}`).set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`);
          expect(referencedCountryDelete.status).toBe(409);
          await request(server).delete(`/api/v1/operations/third-party-delivery-companies/${carrierC}`).set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).expect(200);
          await request(server).delete(`/api/v1/operations/destination-countries/${countryC}`).set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).expect(200);

          const domesticMissingArea = await request(server).post("/api/v1/operations/orders").set("Authorization", `Bearer ${a.token}`).set("Host", `${a.subdomain}.blueline.test`).set("x-idempotency-key", randomUUID()).send({ orderType: "delivery", serialNumber: `HTTP-DOMESTIC-${suffix}`, traderId, codAmount: 0, serviceFee: 0, packageCount: 1 });
          expect(domesticMissingArea.status).toBe(400);
          const customerAfter = await sql`select name,mobile_number from customers where id=${customerId}::uuid`.execute(transaction);
          expect(customerAfter.rows[0]).toEqual({ name: "HTTP Customer", mobile_number: "971500000009" });
        } finally { await app?.close(); }
        throw marker;
      })).rejects.toBe(marker);
    } finally { await database.destroy(); }
  });
});
