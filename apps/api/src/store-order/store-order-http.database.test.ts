import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { config as loadEnvironment } from "dotenv";
import { Logger } from "nestjs-pino";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import request from "supertest";

import { AppModule } from "../app.module.js";
import { configuration } from "../configuration/environment.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApiExceptionFilter } from "../presentation/errors/api-exception.filter.js";
import { CompanyHostResolver } from "../tenancy/company-host-resolver.js";
import { StoreOrderService } from "./store-order.service.js";

/**
 * HTTP-boundary tests for Prompt 3C's Customer My Orders/Detail and public
 * tracking endpoints.
 *
 * Service-level tests (`store-order.database.test.ts`) already prove the
 * isolation/snapshot/tracking logic itself; this file proves the guard,
 * DTO validation and pagination-query-coercion wiring that only exists in
 * decorators and global pipes, over a really-booted application -- the same
 * split the codebase already uses for `reconciliation-http.database.test.ts`.
 */
const runHttpTests = process.env.RUN_STORE_ORDER_HTTP === "true";
const rollbackMarker = Symbol("rollback store order http test");

describe.skipIf(!runHttpTests)("Store Order Customer/tracking HTTP boundary (Prompt 3C)", () => {
  it("enforces auth guard, pagination and enumeration-safe tracking over real HTTP", async () => {
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
          .useValue({ resolve: (host: string | undefined) => host?.split(".")[0] })
          .compile();
        let app: INestApplication | undefined;
        try {
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
          const server = app.getHttpServer();
          const storeOrders = app.get(StoreOrderService);

          // --- fixture: one Store + Product, seeded directly (mirrors the
          // DB test's `seed()`, kept minimal here since this file's job is
          // the HTTP boundary, not re-proving domain rules) --------------
          const companyId = randomUUID();
          const traderId = randomUUID();
          const commerceId = randomUUID();
          const storefrontId = randomUUID();
          const categoryId = randomUUID();
          const productId = randomUUID();
          const short = companyId.slice(0, 8);
          await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
            values(${companyId}::uuid,${`SOH-${short}`},${`soh-${short}`},'HTTP Store Test','active',now())`.execute(
            transaction,
          );
          await sql`insert into traders(id,company_id,code,name_en,mobile_number)
            values(${traderId}::uuid,${companyId}::uuid,${`SHT-${short}`},'HTTP Trader','971500000040')`.execute(
            transaction,
          );
          await sql`insert into trader_commerce_profiles(id,public_name,registration_source,approval_status)
            values(${commerceId}::uuid,'HTTP Shop','delivery_company_registered','approved')`.execute(
            transaction,
          );
          await sql`insert into trader_commerce_company_links(trader_commerce_id,company_id,trader_id,link_source)
            values(${commerceId}::uuid,${companyId}::uuid,${traderId}::uuid,'migration_backfill')`.execute(
            transaction,
          );
          await sql`insert into trader_storefronts(id,company_id,trader_id,trader_commerce_id,display_name,slug,business_template,theme,status,published_at)
            values(${storefrontId}::uuid,${companyId}::uuid,${traderId}::uuid,${commerceId}::uuid,'HTTP Shop',
              ${`http-shop-${short}`},'general','modern','published',now())`.execute(transaction);
          await sql`insert into trader_storefront_categories(id,company_id,storefront_id,name_en,slug)
            values(${categoryId}::uuid,${companyId}::uuid,${storefrontId}::uuid,'General',${`general-${short}`})`.execute(
            transaction,
          );
          await sql`insert into trader_storefront_products(id,company_id,storefront_id,trader_id,category_id,name,slug,product_code,selling_price,lifecycle_status,availability_status)
            values(${productId}::uuid,${companyId}::uuid,${storefrontId}::uuid,${traderId}::uuid,${categoryId}::uuid,
              'HTTP Product',${`http-product-${short}`},${`HP-${short}`},75.00,'active','available')`.execute(
            transaction,
          );

          const registerAndLogin = async (mobile: string, name: string) => {
            const suffix = randomUUID().slice(0, 8);
            const register = await request(server)
              .post("/api/v1/commerce/customer-auth/register")
              .send({
                acceptedTerms: true,
                mobile,
                name: `${name} ${suffix}`,
                password: "Http-Customer-Password-1",
              })
              .expect(201);
            return {
              accessToken: String(register.body.accessToken),
              accountId: String(register.body.identity.id),
            };
          };

          const customerA = await registerAndLogin("971503334455", "Customer A");
          const customerB = await registerAndLogin("971503334466", "Customer B");

          // --- guard wiring ---------------------------------------------
          await request(server).get("/api/v1/commerce/customer/orders").expect(401);

          // --- create one Store Order for Customer A directly through the
          // service (no public Checkout endpoint exists yet, by design) --
          const orderA = await storeOrders.createStoreOrder(
            {
              customerMobile: "971503334455",
              customerName: "Customer A",
              deliveryAddress: "Street 1",
              deliveryArea: "Al Barsha",
              deliveryEmirate: "Dubai",
              items: [{ productId, quantity: 2 }],
              storefrontId,
            },
            undefined,
          );
          // The service call above doesn't know Customer A's resolved
          // `commerce_customers.id`; point ownership at it directly so the
          // HTTP list/detail calls below have something of Customer A's own
          // to find (mirrors passing `callerCustomerId` through the real
          // Checkout caller a later prompt will add).
          await sql`update store_orders set customer_id =
              (select id from commerce_customers where account_id = ${customerA.accountId}::uuid)
            where id = ${orderA.id}::uuid`.execute(transaction);

          // --- My Orders: pagination + isolation over real HTTP ----------
          const listA = await request(server)
            .get("/api/v1/commerce/customer/orders?pageSize=10")
            .set("Authorization", `Bearer ${customerA.accessToken}`)
            .expect(200);
          expect(listA.body.total).toBe(1);
          expect(listA.body.items[0].storeOrderNumber).toBe(orderA.storeOrderNumber);
          expect(listA.body.items[0].traderCommerceId).toBeUndefined();

          const listB = await request(server)
            .get("/api/v1/commerce/customer/orders")
            .set("Authorization", `Bearer ${customerB.accessToken}`)
            .expect(200);
          expect(listB.body.total).toBe(0);

          // --- Order detail: cross-Customer denial ------------------------
          await request(server)
            .get(`/api/v1/commerce/customer/orders/${orderA.storeOrderNumber}`)
            .set("Authorization", `Bearer ${customerA.accessToken}`)
            .expect(200);
          await request(server)
            .get(`/api/v1/commerce/customer/orders/${orderA.storeOrderNumber}`)
            .set("Authorization", `Bearer ${customerB.accessToken}`)
            .expect(404);

          // --- invalid pagination query is rejected by the global pipe ---
          await request(server)
            .get("/api/v1/commerce/customer/orders?pageSize=9999")
            .set("Authorization", `Bearer ${customerA.accessToken}`)
            .expect(400);

          // --- public tracking: valid + enumeration-safe invalid ---------
          const guestOrder = await storeOrders.createStoreOrder(
            {
              customerMobile: "971509990011",
              customerName: "Guest Shopper",
              deliveryAddress: "Street 2",
              deliveryArea: "Deira",
              deliveryEmirate: "Dubai",
              items: [{ productId, quantity: 1 }],
              storefrontId,
            },
            undefined,
          );

          const validTrack = await request(server)
            .post("/api/v1/public/store-orders/track")
            .send({
              mobile: "971509990011",
              storeOrderNumber: guestOrder.storeOrderNumber,
              trackingToken: guestOrder.trackingToken,
            })
            .expect(200);
          expect(validTrack.body.storeOrderNumber).toBe(guestOrder.storeOrderNumber);
          expect(validTrack.body.customerMobile).toBeUndefined();
          expect(validTrack.body.customerName).toBeUndefined();

          const invalidTrack = await request(server)
            .post("/api/v1/public/store-orders/track")
            .send({
              mobile: "971509990011",
              storeOrderNumber: guestOrder.storeOrderNumber,
              trackingToken: "wrong-token",
            })
            .expect(404);
          const wrongMobileTrack = await request(server)
            .post("/api/v1/public/store-orders/track")
            .send({
              mobile: "971500000000",
              storeOrderNumber: guestOrder.storeOrderNumber,
              trackingToken: guestOrder.trackingToken,
            })
            .expect(404);
          // Same generic message regardless of which field was wrong.
          expect(invalidTrack.body.message).toBe(wrongMobileTrack.body.message);
          throw rollbackMarker;
        } finally {
          await app?.close();
        }
      });
    } catch (error) {
      if (error !== rollbackMarker) throw error;
    } finally {
      await database.destroy();
    }
  });
});
