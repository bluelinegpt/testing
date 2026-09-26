import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { NoopNotificationPublisher } from "../notifications/noop-notification-publisher.js";
import type { TransactionWork } from "../infrastructure/database/transaction-manager.js";

import { StoreOrderService } from "./store-order.service.js";

/**
 * Customer Commerce Prompt C5 -- Trader Store Order inbox and the
 * Accept/Cancel/Complete-External actions, against the real schema.
 *
 * `KyselyTransactionManager` is stubbed to a savepoint per call (same
 * reason as C3/C4's equivalent tests): `traderAcceptStoreOrder`/
 * `traderCancelStoreOrder`/`traderCompleteExternalStoreOrder` all go
 * through `transitionStoreOrderStatus`, which opens its own transaction --
 * Kysely cannot nest that inside this test's own already-open one.
 */
const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `c5_${++this.sequence}`;
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

describe.skipIf(!runDatabaseTests)("Trader Store Order actions (Customer Commerce Prompt C5)", () => {
  it("lists, details, accepts, cancels and completes-external with correct ownership scoping", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const settings = configuration();
    const pool = new Pool({ connectionString: settings.database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    const rollbackMarker = Symbol("rollback c5 test");

    try {
      await database.transaction().execute(async (transaction) => {
        const service = new StoreOrderService(
          transaction,
          new SavepointTransactionManager(transaction) as unknown as import("../infrastructure/database/transaction-manager.js").KyselyTransactionManager,
          new NoopNotificationPublisher(),
        );

        const ids = {
          categoryId: randomUUID(),
          commerceId: randomUUID(),
          companyId: randomUUID(),
          otherCommerceId: randomUUID(),
          otherTraderId: randomUUID(),
          productId: randomUUID(),
          storefrontId: randomUUID(),
          traderId: randomUUID(),
        };
        const short = ids.companyId.slice(0, 8);

        await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
          values(${ids.companyId}::uuid,${`C5-${short}`},${`c5-${short}`},'C5 Store Test','active',now())`.execute(
          transaction,
        );
        await sql`insert into traders(id,company_id,code,name_en,mobile_number) values
          (${ids.traderId}::uuid,${ids.companyId}::uuid,${`C5T-${short}`},'C5 Store Trader','971500000060'),
          (${ids.otherTraderId}::uuid,${ids.companyId}::uuid,${`C5TX-${short}`},'C5 Other Trader','971500000061')`.execute(
          transaction,
        );
        await sql`insert into trader_commerce_profiles(id,public_name,registration_source,approval_status) values
          (${ids.commerceId}::uuid,'C5 Shop','delivery_company_registered','approved'),
          (${ids.otherCommerceId}::uuid,'C5 Other Shop','delivery_company_registered','approved')`.execute(
          transaction,
        );
        await sql`insert into trader_commerce_company_links(trader_commerce_id,company_id,trader_id,link_source) values
          (${ids.commerceId}::uuid,${ids.companyId}::uuid,${ids.traderId}::uuid,'migration_backfill'),
          (${ids.otherCommerceId}::uuid,${ids.companyId}::uuid,${ids.otherTraderId}::uuid,'migration_backfill')`.execute(
          transaction,
        );
        await sql`insert into trader_storefronts(
            id,company_id,trader_id,trader_commerce_id,display_name,slug,business_template,theme,status,published_at
          ) values(${ids.storefrontId}::uuid,${ids.companyId}::uuid,${ids.traderId}::uuid,${ids.commerceId}::uuid,
            'C5 Shop',${`c5-shop-${short}`},'general','modern','published',now())`.execute(transaction);
        await sql`insert into trader_storefront_categories(id,company_id,storefront_id,name_en,slug)
          values(${ids.categoryId}::uuid,${ids.companyId}::uuid,${ids.storefrontId}::uuid,'General',${`general-${short}`})`.execute(
          transaction,
        );
        await sql`insert into trader_storefront_products(
            id,company_id,storefront_id,trader_id,category_id,name,slug,product_code,selling_price,
            lifecycle_status,availability_status
          ) values(${ids.productId}::uuid,${ids.companyId}::uuid,${ids.storefrontId}::uuid,${ids.traderId}::uuid,
            ${ids.categoryId}::uuid,'C5 Product',${`c5-product-${short}`},${`C5P-${short}`},50.00,
            'active','available')`.execute(transaction);

        // Two zero-Company (`awaiting_trader_confirmation`) Store Orders --
        // one to Accept then Complete External, one to Cancel.
        const createZeroCompanyOrder = async (numberSuffix: string) => {
          const storeOrderId = randomUUID();
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
              ${storeOrderId}::uuid, ${`SO-C5-${numberSuffix}-${short}`}, ${ids.commerceId}::uuid, ${ids.storefrontId}::uuid,
              'C5 Shop', ${`c5-shop-${short}`},
              'store_web', 'awaiting_trader_confirmation', 'AED',
              'C5 Customer', '971509990500',
              'Dubai', 'Al Barsha', 'Street 9',
              50.00, 0.00, 0.00,
              0, 50.00,
              ${`c5hash${numberSuffix}`}, now(), now()
            )`.execute(transaction);
          return storeOrderId;
        };
        const acceptOrderId = await createZeroCompanyOrder("A");
        const cancelOrderId = await createZeroCompanyOrder("B");

        // --- list: Trader sees their own zero-Company Store Orders ---
        const page = await service.traderStoreOrderPage(ids.traderId, ids.companyId, {
          status: "awaiting_trader_confirmation",
        });
        expect(page.total).toBe(2);
        expect(page.items.map((item) => item.id).sort()).toEqual([acceptOrderId, cancelOrderId].sort());

        // --- search ---
        const searched = await service.traderStoreOrderPage(ids.traderId, ids.companyId, {
          search: "C5 Customer",
        });
        expect(searched.total).toBe(2);

        // --- detail: frozen fields visible, no live re-read ---
        const detail = await service.traderStoreOrderDetail(ids.traderId, ids.companyId, acceptOrderId);
        expect(detail.deliveryAddress).toBe("Street 9");
        expect(detail.deliveryArea).toBe("Al Barsha");
        expect(detail.customerName).toBe("C5 Customer");
        expect(detail.deliveryCompanyId).toBeNull();

        // --- cross-Trader (§49): a different Trader in the SAME Company,
        // with no link to THIS Store's own commerce id, gets the same
        // "not found" a nonexistent id would -- never a distinguishing
        // signal that someone else's Store Order exists ---
        await expect(
          service.traderStoreOrderDetail(ids.otherTraderId, ids.companyId, acceptOrderId),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
          service.traderAcceptStoreOrder(ids.otherTraderId, ids.companyId, acceptOrderId),
        ).rejects.toMatchObject({ status: 404 });

        // --- Accept ---
        const accepted = await service.traderAcceptStoreOrder(ids.traderId, ids.companyId, acceptOrderId);
        expect(accepted.status).toBe("confirmed");
        // No Delivery Order created merely by Accepting (§20).
        const acceptedRow = await sql<{ deliveryOrderId: string | null }>`
          select delivery_order_id as "deliveryOrderId" from store_orders where id = ${acceptOrderId}::uuid
        `.execute(transaction);
        expect(acceptedRow.rows[0]!.deliveryOrderId).toBeNull();

        // --- Accept again: wrong-lifecycle business error, not a crash ---
        await expect(
          service.traderAcceptStoreOrder(ids.traderId, ids.companyId, acceptOrderId),
        ).rejects.toMatchObject({ status: 400, errorCode: "store_order_transition_invalid" });

        // --- Complete External ---
        const completed = await service.traderCompleteExternalStoreOrder(
          ids.traderId,
          ids.companyId,
          acceptOrderId,
        );
        expect(completed.status).toBe("completed_external");
        // Terminal: cannot Accept/Cancel/complete again.
        await expect(
          service.traderCompleteExternalStoreOrder(ids.traderId, ids.companyId, acceptOrderId),
        ).rejects.toMatchObject({ status: 400 });
        await expect(
          service.traderCancelStoreOrder(ids.traderId, ids.companyId, acceptOrderId),
        ).rejects.toMatchObject({ status: 400 });

        // --- Cancel path (second fixture) ---
        const cancelled = await service.traderCancelStoreOrder(ids.traderId, ids.companyId, cancelOrderId);
        expect(cancelled.status).toBe("cancelled");
        // No financial/Delivery artifacts from cancelling (§26).
        const cancelledRow = await sql<{ deliveryOrderId: string | null; codTotal: string }>`
          select delivery_order_id as "deliveryOrderId", cod_total::text as "codTotal"
            from store_orders where id = ${cancelOrderId}::uuid
        `.execute(transaction);
        expect(cancelledRow.rows[0]!.deliveryOrderId).toBeNull();
        expect(cancelledRow.rows[0]!.codTotal).toBe("50.00"); // unchanged, never zeroed/rewritten

        // --- Accept-then-Cancel on a THIRD fixture: exactly one transition
        // wins, the second gets a safe business error, never corruption
        // (§53). Run sequentially rather than via `Promise.allSettled`:
        // this test's single shared `transaction`/connection cannot safely
        // model two truly concurrent transactions each opening their own
        // nested savepoint (`transitionStoreOrderStatus` opens one per
        // call) -- interleaving two savepoint scopes on ONE connection
        // corrupts both, which is a test-harness artifact, not a
        // reflection of real production behavior. In production, two
        // separate connections each doing their own transaction hit
        // `transitionStoreOrderStatus`'s `select ... for update` row lock
        // directly (already covered by C3/C4's equivalent reservation-based
        // race tests against real concurrent connections); this test proves
        // the TRANSITION VALIDATION half of that guarantee -- that a
        // second, already-stale transition attempt is rejected safely,
        // never silently corrupting the row -- which is connection-order
        // independent. ---
        const raceOrderId = await createZeroCompanyOrder("C");
        const firstTransition = await service.traderAcceptStoreOrder(ids.traderId, ids.companyId, raceOrderId);
        expect(firstTransition.status).toBe("confirmed");
        await expect(
          service.traderCancelStoreOrder(ids.traderId, ids.companyId, raceOrderId),
        ).rejects.toMatchObject({ status: 400, errorCode: "store_order_transition_invalid" });
        const raceFinal = await sql<{ status: string }>`select status from store_orders where id = ${raceOrderId}::uuid`.execute(
          transaction,
        );
        expect(raceFinal.rows[0]!.status).toBe("confirmed"); // exactly one transition took effect

        throw rollbackMarker;
      });
    } catch (error) {
      if (error !== rollbackMarker) throw error;
    } finally {
      await database.destroy();
    }
  });
});
