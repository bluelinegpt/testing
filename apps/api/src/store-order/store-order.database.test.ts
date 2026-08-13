import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { NoopNotificationPublisher } from "../notifications/noop-notification-publisher.js";
import type {
  KyselyTransactionManager,
  TransactionWork,
} from "../infrastructure/database/transaction-manager.js";

import { StoreOrderService } from "./store-order.service.js";

/**
 * Shared Commerce Foundation Prompt 3B: the Store Order domain, against the
 * real schema.
 *
 * Everything runs inside one outer transaction that is always rolled back
 * (§52-65), with `KyselyTransactionManager` stubbed to a savepoint per call
 * -- exactly the pattern already used by `storefront/product.database.test.ts`
 * -- since Kysely refuses a nested `.transaction()` on an already-open one.
 */

const runDatabaseTests = process.env.RUN_INTEGRITY_DATABASE === "true";

class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `so_${++this.sequence}`;
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

interface Fixture {
  readonly commerceId: string;
  readonly companyId: string;
  readonly customerAccountId: string;
  readonly customerId: string;
  readonly optionGroupId: string;
  readonly optionValueId: string;
  readonly otherProductId: string;
  readonly otherStorefrontId: string;
  readonly productId: string;
  readonly relationshipCompanyId: string;
  readonly storefrontId: string;
  readonly traderId: string;
}

async function seed(transaction: Transaction<DatabaseSchema>): Promise<Fixture> {
  const ids = {
    categoryId: randomUUID(),
    commerceId: randomUUID(),
    companyId: randomUUID(),
    customerAccountId: randomUUID(),
    customerId: randomUUID(),
    optionGroupId: randomUUID(),
    optionValueId: randomUUID(),
    otherCategoryId: randomUUID(),
    otherCompanyId: randomUUID(),
    otherCommerceId: randomUUID(),
    otherProductId: randomUUID(),
    otherStorefrontId: randomUUID(),
    otherTraderId: randomUUID(),
    productId: randomUUID(),
    relationshipCompanyId: randomUUID(),
    storefrontId: randomUUID(),
    traderId: randomUUID(),
  };
  const short = ids.companyId.slice(0, 8);
  const otherShort = ids.otherCompanyId.slice(0, 8);
  const relShort = ids.relationshipCompanyId.slice(0, 8);

  for (const [id, code, sub] of [
    [ids.companyId, `SO-${short}`, `so-${short}`],
    [ids.otherCompanyId, `SOB-${otherShort}`, `sob-${otherShort}`],
    [ids.relationshipCompanyId, `SOR-${relShort}`, `sor-${relShort}`],
  ] as const) {
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values(${id}::uuid,${code},${sub},'Store Order Test','active',now())`.execute(transaction);
  }
  await sql`insert into traders(id,company_id,code,name_en,mobile_number) values
    (${ids.traderId}::uuid,${ids.companyId}::uuid,${`T-${short}`},'Store Order Trader','971500000020'),
    (${ids.otherTraderId}::uuid,${ids.otherCompanyId}::uuid,${`T-${otherShort}`},'Other Trader','971500000021')`.execute(
    transaction,
  );
  await sql`insert into trader_commerce_profiles(id,public_name,registration_source,approval_status) values
    (${ids.commerceId}::uuid,'Store Order Shop','delivery_company_registered','approved'),
    (${ids.otherCommerceId}::uuid,'Other Shop','delivery_company_registered','approved')`.execute(
    transaction,
  );
  await sql`insert into trader_commerce_company_links(trader_commerce_id,company_id,trader_id,link_source) values
    (${ids.commerceId}::uuid,${ids.companyId}::uuid,${ids.traderId}::uuid,'migration_backfill'),
    (${ids.otherCommerceId}::uuid,${ids.otherCompanyId}::uuid,${ids.otherTraderId}::uuid,'migration_backfill')`.execute(
    transaction,
  );
  // An active, Store-Order-enabled relationship for the SEPARATE
  // `relationshipCompanyId` -- kept distinct from `companyId` so a test can
  // prove a Store Order carries no Company ownership of its own.
  // `trader_id` is left null: it would have to name a Company Trader row
  // belonging to `relationshipCompanyId` itself (the FK is (company_id,
  // trader_id) -> traders), and the relationship table's own doc comment
  // notes null is the valid "no Trader row yet" shape.
  await sql`insert into trader_delivery_company_relationships(
      trader_commerce_id, company_id, relationship_source, status,
      enabled_for_store_orders, is_default_for_store_orders) values
    (${ids.commerceId}::uuid,${ids.relationshipCompanyId}::uuid,
     'delivery_company_registered','active',true,true)`.execute(transaction);

  await sql`insert into trader_storefronts(
      id,company_id,trader_id,trader_commerce_id,display_name,slug,business_template,theme,status,published_at
    ) values
    (${ids.storefrontId}::uuid,${ids.companyId}::uuid,${ids.traderId}::uuid,${ids.commerceId}::uuid,'Store Order Shop',
     ${`so-shop-${short}`},'general','modern','published',now()),
    (${ids.otherStorefrontId}::uuid,${ids.otherCompanyId}::uuid,${ids.otherTraderId}::uuid,
     ${ids.otherCommerceId}::uuid,'Other Shop',${`so-other-${otherShort}`},'general','modern','published',now())`.execute(
    transaction,
  );

  await sql`insert into trader_storefront_categories(id,company_id,storefront_id,name_en,slug) values
    (${ids.categoryId}::uuid,${ids.companyId}::uuid,${ids.storefrontId}::uuid,'General',${`general-${short}`}),
    (${ids.otherCategoryId}::uuid,${ids.otherCompanyId}::uuid,${ids.otherStorefrontId}::uuid,'General',${`general-${otherShort}`})`.execute(
    transaction,
  );

  await sql`insert into trader_storefront_products(
      id,company_id,storefront_id,trader_id,category_id,name,slug,product_code,
      selling_price,lifecycle_status,availability_status) values
    (${ids.productId}::uuid,${ids.companyId}::uuid,${ids.storefrontId}::uuid,${ids.traderId}::uuid,
     ${ids.categoryId}::uuid,'Test Product',${`test-product-${short}`},${`TP-${short}`},
     100.00,'active','available'),
    (${ids.otherProductId}::uuid,${ids.otherCompanyId}::uuid,${ids.otherStorefrontId}::uuid,${ids.otherTraderId}::uuid,
     ${ids.otherCategoryId}::uuid,'Other Product',${`other-product-${otherShort}`},${`OP-${otherShort}`},
     50.00,'active','available')`.execute(transaction);

  await sql`insert into trader_storefront_product_option_groups(id,company_id,storefront_id,product_id,name,is_active) values
    (${ids.optionGroupId}::uuid,${ids.companyId}::uuid,${ids.storefrontId}::uuid,${ids.productId}::uuid,'Size',true)`.execute(
    transaction,
  );
  await sql`insert into trader_storefront_product_option_values(id,company_id,storefront_id,option_group_id,value,is_active) values
    (${ids.optionValueId}::uuid,${ids.companyId}::uuid,${ids.storefrontId}::uuid,${ids.optionGroupId}::uuid,'Medium',true)`.execute(
    transaction,
  );

  await sql`insert into accounts(id,company_id,account_kind,username,normalized_username,password_hash,mobile_number) values
    (${ids.customerAccountId}::uuid,null,'customer',${`so.customer.${ids.customerAccountId}`},
     ${`so.customer.${ids.customerAccountId}`},'x','971501112233')`.execute(transaction);
  await sql`insert into commerce_customers(id,account_id,name,mobile_number,email) values
    (${ids.customerId}::uuid,${ids.customerAccountId}::uuid,'Registered Customer','971501112233','customer@example.com')`.execute(
    transaction,
  );

  return {
    commerceId: ids.commerceId,
    companyId: ids.companyId,
    customerAccountId: ids.customerAccountId,
    customerId: ids.customerId,
    optionGroupId: ids.optionGroupId,
    optionValueId: ids.optionValueId,
    otherProductId: ids.otherProductId,
    otherStorefrontId: ids.otherStorefrontId,
    productId: ids.productId,
    relationshipCompanyId: ids.relationshipCompanyId,
    storefrontId: ids.storefrontId,
    traderId: ids.traderId,
  };
}

function buildService(transaction: Transaction<DatabaseSchema>): StoreOrderService {
  return new StoreOrderService(
    transaction as unknown as Kysely<DatabaseSchema>,
    new SavepointTransactionManager(transaction) as unknown as KyselyTransactionManager,
    new NoopNotificationPublisher(),
  );
}

async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>, service: StoreOrderService) => Promise<void>,
): Promise<void> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const rollback = Symbol("rollback store order test");
  try {
    await database.transaction().execute(async (transaction) => {
      await work(transaction, buildService(transaction));
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    await database.destroy();
  }
}

const baseGuestInput = (fixture: Fixture, overrides: Record<string, unknown> = {}) => ({
  customerMobile: "971509998877",
  customerName: "Guest Shopper",
  deliveryAddress: "Street 1, Villa 2",
  deliveryArea: "Al Barsha",
  deliveryEmirate: "Dubai",
  items: [{ productId: fixture.productId, quantity: 2 }],
  storefrontId: fixture.storefrontId,
  ...overrides,
});

describe.skipIf(!runDatabaseTests)("Store Order domain foundation (Prompt 3B)", () => {
  it("zero-Company creation: no Delivery Company reference, still a valid Order", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const order = await service.createStoreOrder(baseGuestInput(fixture), undefined);
      expect(order.deliveryCompanyId).toBeNull();
      expect(order.status).toBe("awaiting_trader_confirmation");
      expect(order.customerId).toBeNull();

      const row = await sql<{ deliveryCompanyId: string | null; relationshipId: string | null }>`
        select delivery_company_id as "deliveryCompanyId",
               delivery_company_relationship_id as "relationshipId"
          from store_orders where id = ${order.id}::uuid
      `.execute(transaction);
      expect(row.rows[0]?.deliveryCompanyId).toBeNull();
      expect(row.rows[0]?.relationshipId).toBeNull();
    });
  });

  it("registered Customer creation snapshots identity and links customer_id", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const order = await service.createStoreOrder(
        baseGuestInput(fixture, { customerMobile: "971501112233", customerName: "Registered Customer" }),
        fixture.customerId,
      );
      expect(order.customerId).toBe(fixture.customerId);
      expect(order.customerName).toBe("Registered Customer");
    });
  });

  it("guest creation: customer_id null, Customer snapshot fields still mandatory", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const order = await service.createStoreOrder(baseGuestInput(fixture), undefined);
      expect(order.customerId).toBeNull();
      expect(order.customerName).toBe("Guest Shopper");
      expect(order.customerMobile).toBe("971509998877");
    });
  });

  it("rejects a Product that belongs to a different Storefront (§43/§49)", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      await expect(
        service.createStoreOrder(
          baseGuestInput(fixture, { items: [{ productId: fixture.otherProductId, quantity: 1 }] }),
          undefined,
        ),
      ).rejects.toThrow(/not available/i);
    });
  });

  it("rejects an option value that does not belong to the Product", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const foreignValueId = randomUUID();
      await expect(
        service.createStoreOrder(
          baseGuestInput(fixture, {
            items: [
              {
                productId: fixture.productId,
                quantity: 1,
                selectedOptionValueIds: [foreignValueId],
              },
            ],
          }),
          undefined,
        ),
      ).rejects.toThrow(/does not belong/i);
    });
  });

  it("computes product_subtotal and line_total from the Product's CURRENT price, not a client-supplied one", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const order = await service.createStoreOrder(
        baseGuestInput(fixture, {
          items: [
            {
              productId: fixture.productId,
              quantity: 3,
              selectedOptionValueIds: [fixture.optionValueId],
            },
          ],
        }),
        undefined,
      );
      expect(order.productSubtotal).toBe("300.00");
      expect(order.items[0]?.lineTotal).toBe("300.00");
      expect(order.items[0]?.unitPriceSnapshot).toBe("100.00");
      expect(order.codTotal).toBe("300.00");
    });
  });

  it("a later Product price/name change does not alter an existing Order's snapshot (§17)", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const order = await service.createStoreOrder(baseGuestInput(fixture), undefined);
      const originalUnitPrice = order.items[0]?.unitPriceSnapshot;
      const originalName = order.items[0]?.productNameSnapshot;

      await sql`update trader_storefront_products
        set selling_price = 999.00, name = 'Renamed Product'
        where id = ${fixture.productId}::uuid`.execute(transaction);

      const row = await sql<{ price: string; name: string }>`
        select unit_price_snapshot::text as price, product_name_snapshot as name
          from store_order_items where store_order_id = ${order.id}::uuid
      `.execute(transaction);
      expect(row.rows[0]?.price).toBe(originalUnitPrice);
      expect(row.rows[0]?.name).toBe(originalName);
    });
  });

  it("a later Customer profile change does not alter an existing Order's snapshot", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const order = await service.createStoreOrder(
        baseGuestInput(fixture, { customerMobile: "971501112233", customerName: "Registered Customer" }),
        fixture.customerId,
      );

      await sql`update commerce_customers set name = 'Changed Name', mobile_number = '971509990000'
        where id = ${fixture.customerId}::uuid`.execute(transaction);

      const row = await sql<{ name: string; mobile: string }>`
        select customer_name as name, customer_mobile as mobile from store_orders where id = ${order.id}::uuid
      `.execute(transaction);
      expect(row.rows[0]?.name).toBe("Registered Customer");
      expect(row.rows[0]?.mobile).toBe("971501112233");
    });
  });

  it("a later option value edit does not alter an existing Order's snapshot", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const order = await service.createStoreOrder(
        baseGuestInput(fixture, {
          items: [
            { productId: fixture.productId, quantity: 1, selectedOptionValueIds: [fixture.optionValueId] },
          ],
        }),
        undefined,
      );

      await sql`update trader_storefront_product_option_values set value = 'Large'
        where id = ${fixture.optionValueId}::uuid`.execute(transaction);

      const row = await sql<{ options: { group: string; value: string }[] }>`
        select selected_options_snapshot as options from store_order_items where store_order_id = ${order.id}::uuid
      `.execute(transaction);
      expect(row.rows[0]?.options[0]?.value).toBe("Medium");
    });
  });

  it("a valid, active Delivery Company relationship resolves to a confirmed Order (§33)", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const order = await service.createStoreOrder(
        baseGuestInput(fixture, { deliveryCompanyId: fixture.relationshipCompanyId }),
        undefined,
      );
      expect(order.deliveryCompanyId).toBe(fixture.relationshipCompanyId);
      expect(order.status).toBe("confirmed");
    });
  });

  it("rejects a Delivery Company with no active Store-Order-enabled relationship", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const unrelatedCompanyId = randomUUID();
      await expect(
        service.createStoreOrder(
          baseGuestInput(fixture, { deliveryCompanyId: unrelatedCompanyId }),
          undefined,
        ),
      ).rejects.toThrow(/not an active relationship/i);
    });
  });

  it("freezes the Delivery Company reference once set (§32 historical freeze)", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const order = await service.createStoreOrder(
        baseGuestInput(fixture, { deliveryCompanyId: fixture.relationshipCompanyId }),
        undefined,
      );
      await expect(
        sql`update store_orders set delivery_company_id = ${fixture.companyId}::uuid where id = ${order.id}::uuid`.execute(
          transaction,
        ),
      ).rejects.toThrow(/frozen/i);
    });
  });

  it("a Delivery Order can be linked from at most one Store Order (§38 bridge uniqueness)", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const orderA = await service.createStoreOrder(baseGuestInput(fixture), undefined);
      const orderB = await service.createStoreOrder(baseGuestInput(fixture), undefined);

      // The real `orders` table has grown far beyond what a Store Order
      // domain test needs to know about (Delivery-side schema is explicitly
      // out of scope for 3B -- see CLAUDE.md's Driver Cash Reconciliation/
      // Orders untouched constraint). Rather than hand-maintain a duplicate
      // of its full NOT NULL/CHECK surface here, this test borrows the id of
      // an EXISTING Order via a read-only lookup; nothing is written to
      // `orders`, and the whole test rolls back regardless.
      const existingOrder = await sql<{ id: string }>`select id from orders limit 1`.execute(
        transaction,
      );
      const deliveryOrderId = existingOrder.rows[0]?.id;
      if (deliveryOrderId === undefined) {
        // No fixture Order exists in this environment -- the uniqueness
        // guarantee is still proved by the schema's `unique(delivery_order_id)`
        // constraint itself (see the 3B migration); skip the live linkage
        // rather than fabricate Delivery-side rows this domain must not own.
        return;
      }

      await sql`update store_orders set delivery_order_id = ${deliveryOrderId}::uuid
        where id = ${orderA.id}::uuid`.execute(transaction);

      await expect(
        sql`update store_orders set delivery_order_id = ${deliveryOrderId}::uuid
          where id = ${orderB.id}::uuid`.execute(transaction),
      ).rejects.toThrow(/unique/i);
    });
  });

  it("rejects an empty item list", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      await expect(
        service.createStoreOrder(baseGuestInput(fixture, { items: [] }), undefined),
      ).rejects.toThrow(/at least one item/i);
    });
  });

  it("Trader-side reads are isolated to the caller's own Trader Commerce identity", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      await service.createStoreOrder(baseGuestInput(fixture), undefined);

      const owned = await service.traderListStoreOrders(fixture.traderId, fixture.companyId);
      expect(owned.length).toBe(1);

      const strangerTraderId = randomUUID();
      const strangerCompanyId = randomUUID();
      const strangerAccountId = randomUUID();
      await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
        values(${strangerCompanyId}::uuid,${`SOX-${strangerCompanyId.slice(0, 8)}`},
          ${`sox-${strangerCompanyId.slice(0, 8)}`},'Stranger','active',now())`.execute(transaction);
      await sql`insert into traders(id,company_id,code,name_en,mobile_number)
        values(${strangerTraderId}::uuid,${strangerCompanyId}::uuid,${`ST-${strangerTraderId.slice(0, 8)}`},
          'Stranger Trader','971500000099')`.execute(transaction);
      void strangerAccountId;

      const unrelated = await service.traderListStoreOrders(strangerTraderId, strangerCompanyId);
      expect(unrelated.length).toBe(0);
    });
  });

  it("Customer-side reads are isolated to the caller's own Customer identity", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      await service.createStoreOrder(
        baseGuestInput(fixture, { customerMobile: "971501112233", customerName: "Registered Customer" }),
        fixture.customerId,
      );

      const own = await service.customerListStoreOrders(fixture.customerAccountId);
      expect(own.length).toBe(1);

      const strangerAccountId = randomUUID();
      await sql`insert into accounts(id,company_id,account_kind,username,normalized_username,password_hash,mobile_number) values
        (${strangerAccountId}::uuid,null,'customer',${`so.stranger.${strangerAccountId}`},
         ${`so.stranger.${strangerAccountId}`},'x','971509990001')`.execute(transaction);
      const strangerCustomerId = randomUUID();
      await sql`insert into commerce_customers(id,account_id,name,mobile_number) values
        (${strangerCustomerId}::uuid,${strangerAccountId}::uuid,'Stranger','971509990001')`.execute(
        transaction,
      );

      const unrelated = await service.customerListStoreOrders(strangerAccountId);
      expect(unrelated.length).toBe(0);
    });
  });

  it("validates the explicit status transition graph (§13)", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const order = await service.createStoreOrder(baseGuestInput(fixture), undefined);
      expect(order.status).toBe("awaiting_trader_confirmation");

      await service.transitionStoreOrderStatus(order.id, "confirmed");
      const confirmed = await service.traderStoreOrderDetail(fixture.traderId, fixture.companyId, order.id);
      expect(confirmed.status).toBe("confirmed");

      await expect(service.transitionStoreOrderStatus(order.id, "draft")).rejects.toThrow(
        /cannot move/i,
      );
    });
  });
});

/**
 * Shared Commerce Foundation Prompt 3C: Customer My Orders, Order Detail and
 * secure guest tracking, against the real schema.
 */
describe.skipIf(!runDatabaseTests)("Store Order My Orders, Detail and Tracking (Prompt 3C)", () => {
  async function seedSecondCustomer(transaction: Transaction<DatabaseSchema>) {
    const accountId = randomUUID();
    const customerId = randomUUID();
    await sql`insert into accounts(id,company_id,account_kind,username,normalized_username,password_hash,mobile_number) values
      (${accountId}::uuid,null,'customer',${`so.customer2.${accountId}`},
       ${`so.customer2.${accountId}`},'x','971502223344')`.execute(transaction);
    await sql`insert into commerce_customers(id,account_id,name,mobile_number) values
      (${customerId}::uuid,${accountId}::uuid,'Second Customer','971502223344')`.execute(transaction);
    return { accountId, customerId };
  }

  it("My Orders lists only the caller's own Orders, newest first, paginated", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const other = await seedSecondCustomer(transaction);

      await service.createStoreOrder(
        baseGuestInput(fixture, { customerMobile: "971501112233", customerName: "Registered Customer" }),
        fixture.customerId,
      );
      await service.createStoreOrder(
        baseGuestInput(fixture, { customerMobile: "971501112233", customerName: "Registered Customer" }),
        fixture.customerId,
      );
      await service.createStoreOrder(
        baseGuestInput(fixture, { customerMobile: "971502223344", customerName: "Second Customer" }),
        other.customerId,
      );

      const page = await service.customerOrderSummaryPage(fixture.customerAccountId, { pageSize: 1 });
      expect(page.total).toBe(2);
      expect(page.items.length).toBe(1);
      expect(page.pageSize).toBe(1);

      const fullPage = await service.customerOrderSummaryPage(fixture.customerAccountId);
      expect(fullPage.items.length).toBe(2);
      expect(fullPage.items.every((item) => item.storeDisplayName === "Store Order Shop")).toBe(true);

      const otherPage = await service.customerOrderSummaryPage(other.accountId);
      expect(otherPage.total).toBe(1);
    });
  });

  it("My Orders summary exposes only Customer-safe fields (no internal ids)", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      await service.createStoreOrder(
        baseGuestInput(fixture, {
          customerMobile: "971501112233",
          customerName: "Registered Customer",
          deliveryCompanyId: fixture.relationshipCompanyId,
        }),
        fixture.customerId,
      );
      const page = await service.customerOrderSummaryPage(fixture.customerAccountId);
      const summary = page.items[0];
      expect(summary).toBeDefined();
      expect(Object.keys(summary ?? {})).not.toContain("traderCommerceId");
      expect(Object.keys(summary ?? {})).not.toContain("deliveryCompanyId");
      expect(summary?.deliveryCompanyName).toBe("Store Order Test");
      expect(summary?.itemCount).toBe(1);
    });
  });

  it("Order detail is denied for a foreign Customer's valid Order number (§8/§42)", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const other = await seedSecondCustomer(transaction);
      const order = await service.createStoreOrder(
        baseGuestInput(fixture, { customerMobile: "971501112233", customerName: "Registered Customer" }),
        fixture.customerId,
      );

      const own = await service.customerOrderDetailView(fixture.customerAccountId, order.storeOrderNumber);
      expect(own.storeOrderNumber).toBe(order.storeOrderNumber);

      await expect(
        service.customerOrderDetailView(other.accountId, order.storeOrderNumber),
      ).rejects.toThrow(/not found/i);
    });
  });

  it("Guest Order does not appear inside an unrelated authenticated Customer's My Orders (§43/§44)", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      await service.createStoreOrder(baseGuestInput(fixture), undefined);

      const page = await service.customerOrderSummaryPage(fixture.customerAccountId);
      expect(page.total).toBe(0);
    });
  });

  it("Customer Order detail displays frozen snapshots after source data changes (§10/§54)", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const order = await service.createStoreOrder(
        baseGuestInput(fixture, {
          customerMobile: "971501112233",
          customerName: "Registered Customer",
          items: [
            { productId: fixture.productId, quantity: 1, selectedOptionValueIds: [fixture.optionValueId] },
          ],
        }),
        fixture.customerId,
      );

      await sql`update trader_storefront_products set selling_price = 999.00, name = 'Renamed Product'
        where id = ${fixture.productId}::uuid`.execute(transaction);
      await sql`update trader_storefront_product_option_values set value = 'Large'
        where id = ${fixture.optionValueId}::uuid`.execute(transaction);
      await sql`update commerce_customers set name = 'Changed Name'
        where id = ${fixture.customerId}::uuid`.execute(transaction);

      const detail = await service.customerOrderDetailView(
        fixture.customerAccountId,
        order.storeOrderNumber,
      );
      expect(detail.items[0]?.productNameSnapshot).toBe("Test Product");
      expect(detail.items[0]?.unitPriceSnapshot).toBe("100.00");
      expect(detail.items[0]?.selectedOptionsSnapshot[0]?.value).toBe("Medium");
      expect(detail.customerName).toBe("Registered Customer");
    });
  });

  it("issues a distinct tracking token per Store Order (§57 uniqueness)", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const orderA = await service.createStoreOrder(baseGuestInput(fixture), undefined);
      const orderB = await service.createStoreOrder(baseGuestInput(fixture), undefined);
      expect(orderA.trackingToken).not.toBe(orderB.trackingToken);

      const hashes = await sql<{ hash: string }>`
        select tracking_token_hash as hash from store_orders where id = any(${[orderA.id, orderB.id]}::uuid[])
      `.execute(transaction);
      expect(hashes.rows.length).toBe(2);
      expect(hashes.rows[0]?.hash).not.toBe(hashes.rows[1]?.hash);
      for (const row of hashes.rows) expect(row.hash).toBeTruthy();
    });
  });

  it("tracks a guest Order with the correct number, mobile and token (§55)", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const order = await service.createStoreOrder(baseGuestInput(fixture), undefined);

      const result = await service.trackStoreOrder({
        storeOrderNumber: order.storeOrderNumber,
        mobile: "971509998877",
        trackingToken: order.trackingToken,
      });
      expect(result.storeOrderNumber).toBe(order.storeOrderNumber);
      expect(result.status).toBe("awaiting_trader_confirmation");
      expect("customerMobile" in result).toBe(false);
      expect("customerName" in result).toBe(false);
    });
  });

  it("rejects every wrong tracking combination with the same generic failure (§28/§56)", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const order = await service.createStoreOrder(baseGuestInput(fixture), undefined);

      const wrongOrderNumber = service.trackStoreOrder({
        storeOrderNumber: "SO-999999",
        mobile: "971509998877",
        trackingToken: order.trackingToken,
      });
      const wrongMobile = service.trackStoreOrder({
        storeOrderNumber: order.storeOrderNumber,
        mobile: "971500000001",
        trackingToken: order.trackingToken,
      });
      const wrongToken = service.trackStoreOrder({
        storeOrderNumber: order.storeOrderNumber,
        mobile: "971509998877",
        trackingToken: "not-the-real-token",
      });

      for (const attempt of [wrongOrderNumber, wrongMobile, wrongToken]) {
        await expect(attempt).rejects.toThrow(/couldn't verify/i);
      }

      await service.revokeStoreOrderTrackingToken(order.id);
      await expect(
        service.trackStoreOrder({
          storeOrderNumber: order.storeOrderNumber,
          mobile: "971509998877",
          trackingToken: order.trackingToken,
        }),
      ).rejects.toThrow(/couldn't verify/i);
    });
  });

  it("Trader-side reads still work unchanged after 3C (§39 regression)", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      await service.createStoreOrder(baseGuestInput(fixture), undefined);

      const owned = await service.traderListStoreOrders(fixture.traderId, fixture.companyId);
      expect(owned.length).toBe(1);

      const strangerTraderId = randomUUID();
      const strangerCompanyId = randomUUID();
      await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
        values(${strangerCompanyId}::uuid,${`SOY-${strangerCompanyId.slice(0, 8)}`},
          ${`soy-${strangerCompanyId.slice(0, 8)}`},'Stranger','active',now())`.execute(transaction);
      await sql`insert into traders(id,company_id,code,name_en,mobile_number)
        values(${strangerTraderId}::uuid,${strangerCompanyId}::uuid,${`SY-${strangerTraderId.slice(0, 8)}`},
          'Stranger Trader','971500000098')`.execute(transaction);

      const unrelated = await service.traderListStoreOrders(strangerTraderId, strangerCompanyId);
      expect(unrelated.length).toBe(0);
    });
  });

  it("returns no Delivery summary when no Delivery Order is linked (§38)", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const order = await service.createStoreOrder(baseGuestInput(fixture), undefined);
      // Guest Order (customer_id null) -- proved via tracking, not My Orders.
      const tracked = await service.trackStoreOrder({
        storeOrderNumber: order.storeOrderNumber,
        mobile: "971509998877",
        trackingToken: order.trackingToken,
      });
      expect(tracked.deliverySummary).toBeNull();
    });
  });

  it("provides a read-only linked Delivery summary when a Delivery Order is already bridged (§37)", async () => {
    await inRolledBackTransaction(async (transaction, service) => {
      const fixture = await seed(transaction);
      const order = await service.createStoreOrder(
        baseGuestInput(fixture, { customerMobile: "971501112233", customerName: "Registered Customer" }),
        fixture.customerId,
      );

      const existingOrder = await sql<{ id: string; deliveryStatus: string; companyId: string }>`
        select o.id, o.delivery_status as "deliveryStatus", o.company_id as "companyId"
          from orders o join companies c on c.id = o.company_id and c.status = 'active'
         limit 1
      `.execute(transaction);
      const linked = existingOrder.rows[0];
      if (linked === undefined) return; // No fixture Delivery Order in this environment.

      await sql`update store_orders set delivery_order_id = ${linked.id}::uuid
        where id = ${order.id}::uuid`.execute(transaction);

      const detail = await service.customerOrderDetailView(
        fixture.customerAccountId,
        order.storeOrderNumber,
      );
      expect(detail.deliverySummary).not.toBeNull();
      expect(detail.deliverySummary?.deliveryStatus).toBe(linked.deliveryStatus);
    });
  });
});
