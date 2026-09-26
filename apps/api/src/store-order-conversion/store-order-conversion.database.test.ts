import { randomUUID } from "node:crypto";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import { WhatsAppOutboxWriter } from "../whatsapp/whatsapp-outbox-writer.service.js";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { type TransactionWork } from "../infrastructure/database/transaction-manager.js";
import { OperationsService } from "../operations/operations.service.js";
import {
  AsyncIdentityContextAccessor,
  AsyncTenantContextAccessor,
  RequestSecurityContextStore,
} from "../security/request-security-context.js";

import { StoreOrderConversionService } from "./store-order-conversion.service.js";

/**
 * Customer Commerce Prompt C4 -- Store Order → Delivery Order conversion,
 * against the real schema and the real `OperationsService.createOrder`.
 *
 * One outer transaction, always rolled back; `KyselyTransactionManager`
 * stubbed to a savepoint per call (same reason as C3's equivalent test --
 * `createOrder` opens its own transaction, which Kysely cannot nest inside
 * an already-open one).
 */
const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `c4_${++this.sequence}`;
    await sql.raw(`savepoint ${savepoint}`).execute(this.transaction);
    try {
      const result = await work(this.transaction);
      await sql.raw(`release savepoint ${savepoint}`).execute(this.transaction);
      return result;
    } catch (error) {
      await sql.raw(`rollback to savepoint ${savepoint}`).execute(this.transaction);
      await sql.raw(`release savepoint ${savepoint}`).execute(this.transaction);
      throw error;
    }
  }
}

describe.skipIf(!runDatabaseTests)("StoreOrderConversionService (Customer Commerce Prompt C4)", () => {
  it("converts a confirmed Store Order into exactly one Delivery Order, idempotently and with frozen money", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const rollbackMarker = Symbol("rollback c4 test");

    try {
      await database.transaction().execute(async (transaction) => {
        const securityContext = new RequestSecurityContextStore();
        // `createOrder` only ever touches `database`/`transactions`/`tenants`/
        // `identities` on the path this test exercises -- the remaining six
        // constructor params (report/business-day/password/outsourced-fee/
        // employee-earning/push-outbox services) are used exclusively by
        // OTHER `OperationsService` methods this test never calls, so
        // `undefined as never` is the same precedent already established by
        // `order-financial-model.test.ts` for this exact class.
        const operations = new OperationsService(
          transaction,
          new SavepointTransactionManager(transaction) as unknown as import("../infrastructure/database/transaction-manager.js").KyselyTransactionManager,
          new AsyncTenantContextAccessor(securityContext),
          undefined as never,
          undefined as never,
          new AsyncIdentityContextAccessor(securityContext),
          undefined as never,
          undefined as never,
          undefined as never,
          undefined as never,
          new OperationsHistoryWriter(new WhatsAppOutboxWriter()),
        );
        const conversion = new StoreOrderConversionService(transaction, operations, securityContext);

        const ids = {
          areaId: randomUUID(),
          categoryId: randomUUID(),
          commerceId: randomUUID(),
          companyId: randomUUID(),
          otherAreaCompanyOnlyId: randomUUID(),
          pricingCreatorAccountId: randomUUID(),
          productId: randomUUID(),
          relationshipCompanyId: randomUUID(),
          relationshipTraderAccountId: randomUUID(),
          relationshipTraderId: randomUUID(),
          storefrontId: randomUUID(),
          traderId: randomUUID(),
        };
        const short = ids.companyId.slice(0, 8);
        const relShort = ids.relationshipCompanyId.slice(0, 8);

        const dubai = await sql<{ id: string }>`select id from emirates where name_en = 'Dubai'`.execute(
          transaction,
        );
        const emirateId = dubai.rows[0]!.id;

        await sql`insert into companies(id,code,subdomain,name_en,status,activated_at) values
          (${ids.companyId}::uuid,${`C4-${short}`},${`c4-${short}`},'C4 Store Test','active',now()),
          (${ids.relationshipCompanyId}::uuid,${`C4R-${relShort}`},${`c4r-${relShort}`},'C4 Delivery Co','active',now())`.execute(
          transaction,
        );
        // The relationship Company's OWN Trader row -- also needs a real
        // `accounts` row (`traders.account_id`) since `createOrder`'s
        // cross-Company bridge writes `created_by_account_id` under it.
        await sql`insert into accounts(id,company_id,account_kind,username,normalized_username,password_hash)
          values(${ids.relationshipTraderAccountId}::uuid,${ids.relationshipCompanyId}::uuid,'trader',
            ${`c4trader-${relShort}`},${`c4trader-${relShort}`},'x')`.execute(transaction);
        await sql`insert into traders(id,company_id,code,name_en,mobile_number,account_id) values
          (${ids.traderId}::uuid,${ids.companyId}::uuid,${`C4T-${short}`},'C4 Store Trader','971500000050',null),
          (${ids.relationshipTraderId}::uuid,${ids.relationshipCompanyId}::uuid,${`C4TR-${relShort}`},'C4 Delivery Trader','971500000051',${ids.relationshipTraderAccountId}::uuid)`.execute(
          transaction,
        );
        await sql`insert into trader_commerce_profiles(id,public_name,registration_source,approval_status)
          values(${ids.commerceId}::uuid,'C4 Shop','delivery_company_registered','approved')`.execute(transaction);
        await sql`insert into trader_commerce_company_links(trader_commerce_id,company_id,trader_id,link_source)
          values(${ids.commerceId}::uuid,${ids.companyId}::uuid,${ids.traderId}::uuid,'migration_backfill')`.execute(
          transaction,
        );
        const relationshipResult = await sql<{ id: string }>`
          insert into trader_delivery_company_relationships(
            trader_commerce_id, company_id, trader_id, relationship_source, status,
            enabled_for_store_orders, is_default_for_store_orders)
          values (${ids.commerceId}::uuid,${ids.relationshipCompanyId}::uuid,${ids.relationshipTraderId}::uuid,
                  'delivery_company_registered','active',true,true)
          returning id
        `.execute(transaction);
        const relationshipId = relationshipResult.rows[0]!.id;

        await sql`insert into trader_storefronts(
            id,company_id,trader_id,trader_commerce_id,display_name,slug,business_template,theme,status,published_at
          ) values(${ids.storefrontId}::uuid,${ids.companyId}::uuid,${ids.traderId}::uuid,${ids.commerceId}::uuid,
            'C4 Shop',${`c4-shop-${short}`},'general','modern','published',now())`.execute(transaction);

        // Delivery Company's own Area (name-matched at conversion time).
        await sql`insert into areas(id,company_id,emirate_id,code,name_en,name_ar,is_active)
          values(${ids.areaId}::uuid,${ids.relationshipCompanyId}::uuid,${emirateId}::uuid,${`AB-${relShort}`},'Al Barsha','البرشاء',true)`.execute(
          transaction,
        );
        await sql`insert into accounts(id,company_id,account_kind,username,normalized_username,password_hash)
          values(${ids.pricingCreatorAccountId}::uuid,${ids.relationshipCompanyId}::uuid,'company_user',
            ${`c4pricer-${relShort}`},${`c4pricer-${relShort}`},'x')`.execute(transaction);
        await sql`insert into trader_service_prices(company_id,trader_id,emirate_id,area_id,service_fee,reason,created_by_account_id)
          values(${ids.relationshipCompanyId}::uuid,${ids.relationshipTraderId}::uuid,${emirateId}::uuid,${ids.areaId}::uuid,18.00,'c4 test',${ids.pricingCreatorAccountId}::uuid)`.execute(
          transaction,
        );

        // A confirmed Store Order, Company already assigned -- built
        // directly (not through C3's own service, to keep this test
        // isolated to C4's own concern: what happens to an ALREADY-valid
        // Store Order at conversion time).
        const storeOrderId = randomUUID();
        const storeOrderNumber = `SO-C4TEST-${short}`;
        await sql`insert into store_orders(
            id, store_order_number, trader_commerce_id, storefront_id,
            store_display_name_snapshot, store_slug_snapshot,
            order_source, status, currency,
            customer_name, customer_mobile,
            delivery_emirate, delivery_area, delivery_address,
            product_subtotal, customer_delivery_fee, delivery_company_service_fee,
            platform_fee, cod_total,
            delivery_company_id, delivery_company_relationship_id,
            tracking_token_hash, tracking_token_created_at, submitted_at, confirmed_at
          ) values (
            ${storeOrderId}::uuid, ${storeOrderNumber}, ${ids.commerceId}::uuid, ${ids.storefrontId}::uuid,
            'C4 Shop', ${`c4-shop-${short}`},
            'store_web', 'confirmed', 'AED',
            'C4 Customer', '971509990300',
            'Dubai', 'Al Barsha', 'Street 9',
            179.00, 18.00, 18.00,
            0, 197.00,
            ${ids.relationshipCompanyId}::uuid, ${relationshipId}::uuid,
            'deadbeef', now(), now(), now()
          )`.execute(transaction);

        // --- happy path: converts, correct frozen money, correct Company/Trader ---
        const converted = await conversion.convertToDeliveryOrder(storeOrderNumber, "c4-test-correlation");
        expect(converted.replay).toBe(false);
        expect(converted.deliveryOrderNumber).toMatch(/^ORD-/);
        expect(converted.storeOrderStatus).toBe("converted_to_delivery");

        const deliveryOrderRow = await sql<{
          companyId: string;
          traderId: string;
          codAmount: string;
          serviceFee: string;
          customerAmountDue: string;
          traderNetPayable: string;
          deliveryStatus: string;
          assignedDriverId: string | null;
          referenceNumber: string | null;
        }>`
          select company_id as "companyId", trader_id as "traderId", cod_amount::text as "codAmount",
                 service_fee::text as "serviceFee", customer_amount_due::text as "customerAmountDue",
                 trader_net_payable::text as "traderNetPayable", delivery_status as "deliveryStatus",
                 assigned_driver_id as "assignedDriverId", reference_number as "referenceNumber"
            from orders where id = ${converted.deliveryOrderId}::uuid
        `.execute(transaction);
        const orderRow = deliveryOrderRow.rows[0]!;
        expect(orderRow.companyId).toBe(ids.relationshipCompanyId); // frozen Company, never the Store's own
        expect(orderRow.traderId).toBe(ids.relationshipTraderId); // frozen Company-scoped Trader
        expect(orderRow.codAmount).toBe("197.00");
        expect(orderRow.serviceFee).toBe("18.00");
        expect(orderRow.customerAmountDue).toBe("197.00");
        expect(orderRow.traderNetPayable).toBe("179.00"); // 197 - 18: exactly the product value back to the Trader
        expect(orderRow.deliveryStatus).toBe("new");
        expect(orderRow.assignedDriverId).toBeNull();
        expect(orderRow.referenceNumber).toBe(storeOrderNumber);

        const storeOrderRow = await sql<{ deliveryOrderId: string | null; status: string; version: string }>`
          select delivery_order_id as "deliveryOrderId", status, version::text
            from store_orders where id = ${storeOrderId}::uuid
        `.execute(transaction);
        expect(storeOrderRow.rows[0]!.deliveryOrderId).toBe(converted.deliveryOrderId);
        expect(storeOrderRow.rows[0]!.status).toBe("converted_to_delivery");

        // --- idempotent replay: same Delivery Order, no duplicate ---
        const replayed = await conversion.convertToDeliveryOrder(storeOrderNumber, "c4-test-correlation-2");
        expect(replayed.replay).toBe(true);
        expect(replayed.deliveryOrderId).toBe(converted.deliveryOrderId);
        expect(replayed.deliveryOrderNumber).toBe(converted.deliveryOrderNumber);
        const orderCount = await sql<{ count: string }>`
          select count(*)::text as count from orders where reference_number = ${storeOrderNumber}
        `.execute(transaction);
        expect(orderCount.rows[0]!.count).toBe("1");

        // --- concurrent race: two simultaneous conversions of a SECOND Store
        // Order -> exactly one Delivery Order ---
        const raceStoreOrderId = randomUUID();
        const raceStoreOrderNumber = `SO-C4RACE-${short}`;
        await sql`insert into store_orders(
            id, store_order_number, trader_commerce_id, storefront_id,
            store_display_name_snapshot, store_slug_snapshot,
            order_source, status, currency,
            customer_name, customer_mobile,
            delivery_emirate, delivery_area, delivery_address,
            product_subtotal, customer_delivery_fee, delivery_company_service_fee,
            platform_fee, cod_total,
            delivery_company_id, delivery_company_relationship_id,
            tracking_token_hash, tracking_token_created_at, submitted_at, confirmed_at
          ) values (
            ${raceStoreOrderId}::uuid, ${raceStoreOrderNumber}, ${ids.commerceId}::uuid, ${ids.storefrontId}::uuid,
            'C4 Shop', ${`c4-shop-${short}`},
            'store_web', 'confirmed', 'AED',
            'C4 Race Customer', '971509990301',
            'Dubai', 'Al Barsha', 'Street 10',
            179.00, 18.00, 18.00,
            0, 197.00,
            ${ids.relationshipCompanyId}::uuid, ${relationshipId}::uuid,
            'deadbeef2', now(), now(), now()
          )`.execute(transaction);
        const raceResults = await Promise.allSettled([
          conversion.convertToDeliveryOrder(raceStoreOrderNumber, "c4-race-1"),
          conversion.convertToDeliveryOrder(raceStoreOrderNumber, "c4-race-2"),
        ]);
        const fulfilled = raceResults.filter(
          (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof conversion.convertToDeliveryOrder>>> =>
            result.status === "fulfilled",
        );
        expect(fulfilled.length).toBeGreaterThanOrEqual(1);
        const distinctDeliveryOrderIds = new Set(fulfilled.map((result) => result.value.deliveryOrderId));
        expect(distinctDeliveryOrderIds.size).toBe(1); // never two different Delivery Orders
        const raceOrderCount = await sql<{ count: string }>`
          select count(*)::text as count from orders where reference_number = ${raceStoreOrderNumber}
        `.execute(transaction);
        expect(raceOrderCount.rows[0]!.count).toBe("1");

        // --- price freeze: live pricing change after conversion never
        // rewrites the already-created Delivery Order's service fee ---
        await sql`update trader_service_prices set service_fee = 99.00
          where company_id = ${ids.relationshipCompanyId}::uuid and trader_id = ${ids.relationshipTraderId}::uuid`.execute(
          transaction,
        );
        const frozenAfterPriceChange = await sql<{ serviceFee: string }>`
          select service_fee::text as "serviceFee" from orders where id = ${converted.deliveryOrderId}::uuid
        `.execute(transaction);
        expect(frozenAfterPriceChange.rows[0]!.serviceFee).toBe("18.00"); // unchanged despite the live price now being 99.00
        const storeOrderFeeAfterPriceChange = await sql<{ deliveryCompanyServiceFee: string }>`
          select delivery_company_service_fee::text as "deliveryCompanyServiceFee"
            from store_orders where id = ${storeOrderId}::uuid
        `.execute(transaction);
        expect(storeOrderFeeAfterPriceChange.rows[0]!.deliveryCompanyServiceFee).toBe("18.00");
        await sql`update trader_service_prices set service_fee = 18.00
          where company_id = ${ids.relationshipCompanyId}::uuid and trader_id = ${ids.relationshipTraderId}::uuid`.execute(
          transaction,
        );

        // --- zero-Company Store Order: never converts ---
        const zeroCompanyStoreOrderId = randomUUID();
        const zeroCompanyStoreOrderNumber = `SO-C4ZERO-${short}`;
        await sql`insert into store_orders(
            id, store_order_number, trader_commerce_id, storefront_id,
            store_display_name_snapshot, store_slug_snapshot,
            order_source, status, currency,
            customer_name, customer_mobile,
            delivery_emirate, delivery_area, delivery_address,
            product_subtotal, customer_delivery_fee, delivery_company_service_fee,
            platform_fee, cod_total,
            tracking_token_hash, tracking_token_created_at, submitted_at
          ) values (
            ${zeroCompanyStoreOrderId}::uuid, ${zeroCompanyStoreOrderNumber}, ${ids.commerceId}::uuid, ${ids.storefrontId}::uuid,
            'C4 Shop', ${`c4-shop-${short}`},
            'store_web', 'awaiting_trader_confirmation', 'AED',
            'C4 Zero Company Customer', '971509990302',
            'Dubai', 'Al Barsha', 'Street 11',
            179.00, 0.00, 0.00,
            0, 179.00,
            'deadbeef3', now(), now()
          )`.execute(transaction);
        await expect(
          conversion.convertToDeliveryOrder(zeroCompanyStoreOrderNumber, "c4-zero-company"),
        ).rejects.toMatchObject({ status: 409, errorCode: "store_order_not_ready_for_delivery_conversion" });
        const zeroCompanyRow = await sql<{ deliveryOrderId: string | null }>`
          select delivery_order_id as "deliveryOrderId" from store_orders where id = ${zeroCompanyStoreOrderId}::uuid
        `.execute(transaction);
        expect(zeroCompanyRow.rows[0]!.deliveryOrderId).toBeNull();

        throw rollbackMarker;
      });
    } catch (error) {
      if (error !== rollbackMarker) throw error;
    } finally {
      await database.destroy();
    }
  });
});
