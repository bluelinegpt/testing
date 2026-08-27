import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { KyselyTransactionManager, TransactionWork } from "../infrastructure/database/transaction-manager.js";
import { NoopNotificationPublisher } from "../notifications/noop-notification-publisher.js";
import { RequestSecurityContextStore } from "../security/request-security-context.js";
import { StoreOrderService } from "../store-order/store-order.service.js";

import { CommerceCheckoutService } from "./commerce-checkout.service.js";
import { StoreOrderSubmissionService } from "./store-order-submission.service.js";

/**
 * Customer Commerce Prompt C3 -- Store Order submission, against the real
 * schema. One outer transaction, always rolled back; `KyselyTransactionManager`
 * stubbed to a savepoint per call (mirrors `store-order.database.test.ts`,
 * required because Kysely refuses a nested `.transaction()` on an
 * already-open one -- `StoreOrderService.createStoreOrder` opens its own).
 */
const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `c3_${++this.sequence}`;
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

describe.skipIf(!runDatabaseTests)("StoreOrderSubmissionService (Customer Commerce Prompt C3)", () => {
  it("revalidates, creates exactly one Store Order per idempotency key, and snapshots correctly", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const rollbackMarker = Symbol("rollback c3 test");

    try {
      await database.transaction().execute(async (transaction) => {
        const ids = {
          areaId: randomUUID(),
          categoryId: randomUUID(),
          commerceId: randomUUID(),
          companyId: randomUUID(),
          groupId: randomUUID(),
          pricingCreatorAccountId: randomUUID(),
          productId: randomUUID(),
          relationshipCompanyId: randomUUID(),
          relationshipTraderId: randomUUID(),
          storefrontId: randomUUID(),
          traderId: randomUUID(),
          valueId: randomUUID(),
        };
        const short = ids.companyId.slice(0, 8);
        const relShort = ids.relationshipCompanyId.slice(0, 8);

        const dubai = await sql<{ id: string }>`select id from emirates where name_en = 'Dubai'`.execute(
          transaction,
        );
        const emirateId = dubai.rows[0]!.id;

        await sql`insert into companies(id,code,subdomain,name_en,status,activated_at) values
          (${ids.companyId}::uuid,${`C3-${short}`},${`c3-${short}`},'C3 Test','active',now()),
          (${ids.relationshipCompanyId}::uuid,${`C3R-${relShort}`},${`c3r-${relShort}`},'C3 Delivery Co','active',now())`.execute(
          transaction,
        );
        await sql`insert into traders(id,company_id,code,name_en,mobile_number) values
          (${ids.traderId}::uuid,${ids.companyId}::uuid,${`C3T-${short}`},'C3 Trader','971500000040'),
          (${ids.relationshipTraderId}::uuid,${ids.relationshipCompanyId}::uuid,${`C3TR-${relShort}`},'C3 Delivery Trader','971500000041')`.execute(
          transaction,
        );
        await sql`insert into trader_commerce_profiles(id,public_name,registration_source,approval_status)
          values(${ids.commerceId}::uuid,'C3 Shop','delivery_company_registered','approved')`.execute(transaction);
        await sql`insert into trader_commerce_company_links(trader_commerce_id,company_id,trader_id,link_source)
          values(${ids.commerceId}::uuid,${ids.companyId}::uuid,${ids.traderId}::uuid,'migration_backfill')`.execute(
          transaction,
        );
        await sql`insert into trader_delivery_company_relationships(
            trader_commerce_id, company_id, trader_id, relationship_source, status,
            enabled_for_store_orders, is_default_for_store_orders) values
          (${ids.commerceId}::uuid,${ids.relationshipCompanyId}::uuid,${ids.relationshipTraderId}::uuid,
           'delivery_company_registered','active',true,true)`.execute(transaction);
        await sql`insert into trader_storefronts(
            id,company_id,trader_id,trader_commerce_id,display_name,slug,business_template,theme,status,published_at
          ) values(${ids.storefrontId}::uuid,${ids.companyId}::uuid,${ids.traderId}::uuid,${ids.commerceId}::uuid,
            'C3 Shop',${`c3-shop-${short}`},'general','modern','published',now())`.execute(transaction);
        await sql`insert into trader_storefront_categories(id,company_id,storefront_id,name_en,slug)
          values(${ids.categoryId}::uuid,${ids.companyId}::uuid,${ids.storefrontId}::uuid,'General',${`general-${short}`})`.execute(
          transaction,
        );
        await sql`insert into trader_storefront_products(
            id,company_id,storefront_id,trader_id,category_id,name,slug,product_code,selling_price,
            lifecycle_status,availability_status,minimum_quantity,maximum_quantity
          ) values(${ids.productId}::uuid,${ids.companyId}::uuid,${ids.storefrontId}::uuid,${ids.traderId}::uuid,
            ${ids.categoryId}::uuid,'C3 Product',${`c3-product-${short}`},${`C3P-${short}`},50.00,
            'active','available',1,5)`.execute(transaction);
        await sql`insert into trader_storefront_product_option_groups(id,storefront_id,product_id,name,display_order,is_required,is_active)
          values(${ids.groupId}::uuid,${ids.storefrontId}::uuid,${ids.productId}::uuid,'Size',0,true,true)`.execute(
          transaction,
        );
        await sql`insert into trader_storefront_product_option_values(id,storefront_id,option_group_id,value,display_order,is_active)
          values(${ids.valueId}::uuid,${ids.storefrontId}::uuid,${ids.groupId}::uuid,'Medium',0,true)`.execute(
          transaction,
        );
        await sql`insert into areas(id,company_id,emirate_id,code,name_en,name_ar,is_active)
          values(${ids.areaId}::uuid,${ids.relationshipCompanyId}::uuid,${emirateId}::uuid,${`AB-${relShort}`},'Al Barsha','البرشاء',true)`.execute(
          transaction,
        );
        await sql`insert into accounts(id,company_id,account_kind,username,normalized_username,password_hash)
          values(${ids.pricingCreatorAccountId}::uuid,${ids.relationshipCompanyId}::uuid,'company_user',
            ${`c3pricer-${relShort}`},${`c3pricer-${relShort}`},'x')`.execute(transaction);
        await sql`insert into trader_service_prices(company_id,trader_id,emirate_id,area_id,service_fee,reason,created_by_account_id)
          values(${ids.relationshipCompanyId}::uuid,${ids.relationshipTraderId}::uuid,${emirateId}::uuid,${ids.areaId}::uuid,15.00,'c3 test',${ids.pricingCreatorAccountId}::uuid)`.execute(
          transaction,
        );

        const securityContext = new RequestSecurityContextStore();
        const checkout = new CommerceCheckoutService(transaction, securityContext);
        const storeOrders = new StoreOrderService(
          transaction,
          new SavepointTransactionManager(transaction) as unknown as KyselyTransactionManager,
          new NoopNotificationPublisher(),
        );
        const submission = new StoreOrderSubmissionService(transaction, checkout, storeOrders);

        const baseInput = {
          cartLines: [
            {
              productSlug: `c3-product-${short}`,
              quantity: 2,
              selectedOptions: [{ groupName: "Size", value: "Medium" }],
            },
          ],
          customerMobile: "971509990100",
          customerName: "C3 Guest",
          expectedCodTotal: "115.00", // 50.00 x 2 + 15.00 delivery
          idempotencyKey: randomUUID(),
          newAddress: { address: "Street 9", area: "Al Barsha", emirate: "Dubai" },
          paymentMethod: "cod" as const,
          storeSlug: `c3-shop-${short}`,
        };

        // --- success: creates exactly one Store Order, snapshots correctly,
        // and correctly persists the Company's own service fee SEPARATELY
        // from the Customer-facing delivery fee (C3 corrective, Part D) ---
        const created = await submission.placeOrder(baseInput);
        expect(created.productSubtotal).toBe("100.00");
        expect(created.customerDeliveryFee).toBe("15.00");
        expect(created.codTotal).toBe("115.00");
        expect(created.status).toBe("confirmed"); // a Company was resolved
        expect(created.items[0]!.productNameSnapshot).toBe("C3 Product");
        expect(created.items[0]!.selectedOptionsSnapshot).toEqual([{ group: "Size", value: "Medium" }]);
        expect(created.trackingToken).not.toBeNull();
        expect(created.trackingToken!.length).toBeGreaterThan(20);
        expect(created.deliveryCompanyName).not.toBeNull();

        const feeRow = await sql<{ deliveryCompanyServiceFee: string; customerDeliveryFee: string }>`
          select delivery_company_service_fee::text as "deliveryCompanyServiceFee",
                 customer_delivery_fee::text as "customerDeliveryFee"
            from store_orders where store_order_number = ${created.storeOrderNumber}
        `.execute(transaction);
        expect(feeRow.rows[0]!.deliveryCompanyServiceFee).toBe("15.00");
        expect(feeRow.rows[0]!.customerDeliveryFee).toBe("15.00");

        const countAfterFirst = await sql<{ count: string }>`
          select count(*)::text as count from store_orders where store_order_number = ${created.storeOrderNumber}
        `.execute(transaction);
        expect(countAfterFirst.rows[0]!.count).toBe("1");

        // --- idempotent retry: SAME key, SAME payload -> same Store Order,
        // no second row created, and NO raw tracking token reissued (C3
        // corrective, Part B) -- the Store Order itself replays in full. ---
        const retried = await submission.placeOrder(baseInput);
        expect(retried.storeOrderNumber).toBe(created.storeOrderNumber);
        expect(retried.codTotal).toBe(created.codTotal);
        expect(retried.trackingToken).toBeNull();
        const countAfterRetry = await sql<{ count: string }>`
          select count(*)::text as count from store_orders where store_order_number = ${created.storeOrderNumber}
        `.execute(transaction);
        expect(countAfterRetry.rows[0]!.count).toBe("1");

        // --- no plaintext raw tracking token anywhere at rest, after either
        // the original submission or the replay (C3 corrective, Part M) ---
        const plaintextScan = await sql<{ count: string }>`
          select count(*)::text as count from store_order_idempotency_keys
           where idempotency_key = ${baseInput.idempotencyKey}
        `.execute(transaction);
        expect(plaintextScan.rows[0]!.count).toBe("1"); // the reservation row itself still exists...
        const columnScan = await sql<{ columnName: string }>`
          select column_name as "columnName" from information_schema.columns
           where table_name = 'store_order_idempotency_keys'
        `.execute(transaction);
        expect(columnScan.rows.map((row) => row.columnName)).not.toContain("raw_tracking_token"); // ...but has nowhere to put a raw token even if it wanted to

        // --- same key, DIFFERENT payload -> safe conflict, no duplicate,
        // no unrelated prior Order returned ---
        await expect(
          submission.placeOrder({ ...baseInput, customerName: "Different Name" }),
        ).rejects.toMatchObject({ status: 409, errorCode: "checkout_idempotency_conflict" });

        // --- price changed since Review -> rejected, no Store Order created ---
        await sql`update trader_storefront_products set selling_price = 60.00 where id = ${ids.productId}::uuid`.execute(
          transaction,
        );
        const staleInput = { ...baseInput, idempotencyKey: randomUUID() };
        await expect(submission.placeOrder(staleInput)).rejects.toMatchObject({
          status: 409,
          errorCode: "checkout_changed",
        });
        const countAfterStale = await sql<{ count: string }>`
          select count(*)::text as count from store_orders where trader_commerce_id = ${ids.commerceId}::uuid
        `.execute(transaction);
        expect(countAfterStale.rows[0]!.count).toBe("1"); // still just the one from earlier
        // A rejected submission must not leave its idempotency reservation
        // behind blocking a legitimate retry with the same key (§1).
        const orphanedReservation = await sql<{ count: string }>`
          select count(*)::text as count from store_order_idempotency_keys where idempotency_key = ${staleInput.idempotencyKey}
        `.execute(transaction);
        expect(orphanedReservation.rows[0]!.count).toBe("0");
        await sql`update trader_storefront_products set selling_price = 50.00 where id = ${ids.productId}::uuid`.execute(
          transaction,
        );

        // --- guest snapshot: Store Order carries no account, only a frozen
        // name/mobile; a later profile change cannot rewrite history ---
        expect(created.storeOrderNumber).toMatch(/^SO-\d{6}$/);

        // --- zero eligible Delivery Company: still creates the Store Order,
        // awaiting_trader_confirmation, delivery_company_id null ---
        await sql`update trader_delivery_company_relationships set enabled_for_store_orders = false, is_default_for_store_orders = false
          where trader_commerce_id = ${ids.commerceId}::uuid`.execute(transaction);
        const zeroCompanyInput = {
          ...baseInput,
          expectedCodTotal: "100.00",
          idempotencyKey: randomUUID(),
        };
        const zeroCompanyOrder = await submission.placeOrder(zeroCompanyInput);
        expect(zeroCompanyOrder.status).toBe("awaiting_trader_confirmation");
        expect(zeroCompanyOrder.deliveryCompanyName).toBeNull();
        expect(zeroCompanyOrder.customerDeliveryFee).toBe("0.00");
        const zeroCompanyRow = await sql<{ deliveryCompanyId: string | null; deliveryCompanyRelationshipId: string | null }>`
          select delivery_company_id as "deliveryCompanyId", delivery_company_relationship_id as "deliveryCompanyRelationshipId"
            from store_orders where store_order_number = ${zeroCompanyOrder.storeOrderNumber}
        `.execute(transaction);
        expect(zeroCompanyRow.rows[0]!.deliveryCompanyId).toBeNull();
        expect(zeroCompanyRow.rows[0]!.deliveryCompanyRelationshipId).toBeNull();
        // C3 corrective, §23: zero-Company means BOTH fee fields are zero,
        // not just the Customer-facing one.
        const zeroCompanyFeeRow = await sql<{ deliveryCompanyServiceFee: string }>`
          select delivery_company_service_fee::text as "deliveryCompanyServiceFee"
            from store_orders where store_order_number = ${zeroCompanyOrder.storeOrderNumber}
        `.execute(transaction);
        expect(zeroCompanyFeeRow.rows[0]!.deliveryCompanyServiceFee).toBe("0.00");

        // --- Company pricing freeze (C3 corrective, §13/§56): changing the
        // Trader's live pricing AFTER a Store Order exists must never rewrite
        // that Store Order's already-frozen Company fee ---
        await sql`update trader_service_prices set service_fee = 99.00
          where company_id = ${ids.relationshipCompanyId}::uuid and trader_id = ${ids.relationshipTraderId}::uuid`.execute(
          transaction,
        );
        const frozenFeeRow = await sql<{ deliveryCompanyServiceFee: string }>`
          select delivery_company_service_fee::text as "deliveryCompanyServiceFee"
            from store_orders where store_order_number = ${created.storeOrderNumber}
        `.execute(transaction);
        expect(frozenFeeRow.rows[0]!.deliveryCompanyServiceFee).toBe("15.00"); // unchanged despite the live price now being 99.00

        // --- Store→Delivery boundary: delivery_order_id stays null (§26/§89) ---
        const boundaryRow = await sql<{ deliveryOrderId: string | null }>`
          select delivery_order_id as "deliveryOrderId" from store_orders where store_order_number = ${created.storeOrderNumber}
        `.execute(transaction);
        expect(boundaryRow.rows[0]!.deliveryOrderId).toBeNull();

        throw rollbackMarker;
      });
    } catch (error) {
      if (error !== rollbackMarker) throw error;
    } finally {
      await database.destroy();
    }
  });
});
