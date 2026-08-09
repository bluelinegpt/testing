import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type {
  KyselyTransactionManager,
  TransactionWork,
} from "../infrastructure/database/transaction-manager.js";
import { FileOwnershipService } from "../files/file-ownership.service.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import type { IdentityContextAccessor, IdentityKind } from "../security/identity-context.js";
import type { TenantContextAccessor } from "../tenancy/tenant-context.js";

import { StorefrontProductService } from "./product.service.js";
import { StorefrontDeliveryService } from "./storefront-delivery.service.js";
import { StorefrontService } from "./storefront.service.js";

/**
 * Trader Commerce as the authoritative Store owner (0B-1).
 *
 * Everything runs inside ONE transaction that is always rolled back.
 *
 * The claims under test are the ones the ownership conversion would be
 * dangerous to get wrong: that a Store survives having no Delivery Company at
 * all, that a Delivery Company reaches a Store only through an ACTIVE
 * relationship, that a Company administrator cannot escalate across a
 * relationship boundary, and that an id supplied in a request can identify a
 * resource but never assert who owns it.
 *
 * The zero-Company cases are the reason this file exists. Before 0B-1 they were
 * not merely unsupported, they were unrepresentable: `company_id NOT NULL` and
 * a composite foreign key made the Delivery Company part of the Store's
 * identity. A test that only ever exercises a Store WITH a Company would pass
 * against the old schema too, and would prove nothing about the conversion.
 */

const runDatabaseTests = process.env.RUN_COMMERCE_OWNERSHIP_DATABASE === "true";

class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `co_${++this.sequence}`;
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
  readonly actorId: string;
  readonly commerceId: string;
  readonly companyId: string;
  readonly otherActorId: string;
  readonly otherCommerceId: string;
  readonly otherCompanyId: string;
  readonly otherStorefrontId: string;
  readonly otherTraderId: string;
  readonly storefrontId: string;
  readonly thirdCompanyId: string;
  readonly traderId: string;
}

/**
 * Two complete, unrelated shops, plus a third Delivery Company connected to
 * neither.
 *
 * The third Company is what makes the "unrelated Company is denied" cases
 * meaningful: without it, denial could just as well be explained by the Company
 * not existing.
 */
async function seed(transaction: Transaction<DatabaseSchema>): Promise<Fixture> {
  const ids = {
    actorId: randomUUID(),
    commerceId: randomUUID(),
    companyId: randomUUID(),
    otherActorId: randomUUID(),
    otherCommerceId: randomUUID(),
    otherCompanyId: randomUUID(),
    otherStorefrontId: randomUUID(),
    otherTraderId: randomUUID(),
    storefrontId: randomUUID(),
    thirdCompanyId: randomUUID(),
    traderId: randomUUID(),
  };
  const short = ids.companyId.slice(0, 8);
  const otherShort = ids.otherCompanyId.slice(0, 8);
  const thirdShort = ids.thirdCompanyId.slice(0, 8);

  for (const [id, code, label] of [
    [ids.companyId, `CO-${short}`, `co-${short}`],
    [ids.otherCompanyId, `COB-${otherShort}`, `cob-${otherShort}`],
    [ids.thirdCompanyId, `COC-${thirdShort}`, `coc-${thirdShort}`],
  ] as const) {
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values(${id}::uuid,${code},${label},'Ownership Test','active',now())`.execute(transaction);
  }
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash) values
    (${ids.actorId}::uuid,${ids.companyId}::uuid,'company_user',${`co.a.${ids.actorId}`},'x'),
    (${ids.otherActorId}::uuid,${ids.otherCompanyId}::uuid,'company_user',${`co.b.${ids.otherActorId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into traders(id,company_id,code,name_en,mobile_number) values
    (${ids.traderId}::uuid,${ids.companyId}::uuid,${`T-${short}`},'Shop A Trader','971500000010'),
    (${ids.otherTraderId}::uuid,${ids.otherCompanyId}::uuid,${`T-${otherShort}`},'Shop B Trader','971500000011')`.execute(
    transaction,
  );
  await sql`insert into trader_commerce_profiles(id,public_name,registration_source,approval_status) values
    (${ids.commerceId}::uuid,'Shop A','delivery_company_registered','approved'),
    (${ids.otherCommerceId}::uuid,'Shop B','delivery_company_registered','approved')`.execute(
    transaction,
  );
  // IDENTITY links. These are what a Trader actor resolves through, and they
  // deliberately outlive any delivery arrangement.
  await sql`insert into trader_commerce_company_links(trader_commerce_id,company_id,trader_id,link_source) values
    (${ids.commerceId}::uuid,${ids.companyId}::uuid,${ids.traderId}::uuid,'migration_backfill'),
    (${ids.otherCommerceId}::uuid,${ids.otherCompanyId}::uuid,${ids.otherTraderId}::uuid,'migration_backfill')`.execute(
    transaction,
  );
  // SERVICE relationships. These are what a Company user resolves through.
  await sql`insert into trader_delivery_company_relationships(
      trader_commerce_id, company_id, trader_id, relationship_source, status,
      enabled_for_store_orders, is_default_for_store_orders) values
    (${ids.commerceId}::uuid,${ids.companyId}::uuid,${ids.traderId}::uuid,'delivery_company_registered','active',true,true),
    (${ids.otherCommerceId}::uuid,${ids.otherCompanyId}::uuid,${ids.otherTraderId}::uuid,'delivery_company_registered','active',true,true)`.execute(
    transaction,
  );
  for (const [id, commerce, company, trader, name] of [
    [ids.storefrontId, ids.commerceId, ids.companyId, ids.traderId, "Shop A"],
    [ids.otherStorefrontId, ids.otherCommerceId, ids.otherCompanyId, ids.otherTraderId, "Shop B"],
  ] as const) {
    await sql`insert into trader_storefronts(
        id, trader_commerce_id, company_id, trader_id, display_name, slug,
        business_template, theme, status, published_at)
      values(${id}::uuid, ${commerce}::uuid, ${company}::uuid, ${trader}::uuid, ${name},
        ${`shop-${id.slice(0, 12)}`}, 'fashion', 'modern', 'published', now())`.execute(
      transaction,
    );
  }
  return ids;
}

function buildStorefrontService(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly actorId: string;
    readonly companyId: string;
    readonly kind?: IdentityKind;
    readonly permissions?: readonly string[];
    readonly traderProfileId?: string;
  },
): StorefrontService {
  return new StorefrontService(
    transaction as unknown as Kysely<DatabaseSchema>,
    new SavepointTransactionManager(transaction) as unknown as KyselyTransactionManager,
    ...contexts(input),
    new OperationsHistoryWriter(),
    new FileOwnershipService(transaction as unknown as Kysely<DatabaseSchema>),
  );
}

function buildProductService(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly actorId: string;
    readonly companyId: string;
    readonly kind?: IdentityKind;
    readonly permissions?: readonly string[];
    readonly traderProfileId?: string;
  },
): StorefrontProductService {
  return new StorefrontProductService(
    transaction as unknown as Kysely<DatabaseSchema>,
    new SavepointTransactionManager(transaction) as unknown as KyselyTransactionManager,
    ...contexts(input),
    new OperationsHistoryWriter(),
    new FileOwnershipService(transaction as unknown as Kysely<DatabaseSchema>),
  );
}

function buildDeliveryService(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly actorId: string;
    readonly companyId: string;
    readonly kind?: IdentityKind;
    readonly permissions?: readonly string[];
    readonly traderProfileId?: string;
  },
): StorefrontDeliveryService {
  // No FileOwnershipService here: relationship management never creates or
  // adopts a file.
  return new StorefrontDeliveryService(
    transaction as unknown as Kysely<DatabaseSchema>,
    new SavepointTransactionManager(transaction) as unknown as KyselyTransactionManager,
    ...contexts(input),
    new OperationsHistoryWriter(),
  );
}

function contexts(input: {
  readonly actorId: string;
  readonly companyId: string;
  readonly kind?: IdentityKind;
  readonly permissions?: readonly string[];
  readonly traderProfileId?: string;
}): [TenantContextAccessor, IdentityContextAccessor] {
  const permissions = new Set(
    input.permissions ?? [
      "storefront.view",
      "storefront.manage",
      "storefront.publish",
      "storefront_products.view",
      "storefront_products.manage",
    ],
  );
  const tenants = {
    current: () => ({ companyId: input.companyId, identityId: input.actorId }),
  } as unknown as TenantContextAccessor;
  const identities = {
    current: () => ({
      companyId: input.companyId,
      forcePasswordChange: false,
      identityId: input.actorId,
      kind: input.kind ?? "company_user",
      permissions,
      sessionId: randomUUID(),
      ...(input.traderProfileId === undefined ? {} : { profileId: input.traderProfileId }),
    }),
  } as unknown as IdentityContextAccessor;
  return [tenants, identities];
}

async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
): Promise<void> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const marker = new Error("rollback ownership test");
  try {
    await expect(
      database.transaction().execute(async (transaction) => {
        await work(transaction);
        throw marker;
      }),
    ).rejects.toBe(marker);
  } finally {
    await database.destroy();
  }
}

async function rejects(
  transaction: Transaction<DatabaseSchema>,
  work: () => Promise<unknown>,
): Promise<void> {
  const savepoint = `cr_${randomUUID().replace(/-/g, "")}`;
  await sql.raw(`savepoint ${savepoint}`).execute(transaction);
  let failed = false;
  try {
    await work();
  } catch {
    failed = true;
  }
  await sql.raw(`rollback to savepoint ${savepoint}`).execute(transaction);
  await sql.raw(`release savepoint ${savepoint}`).execute(transaction);
  expect(failed).toBe(true);
}

// ---------------------------------------------------------------- zero Company

describe.skipIf(!runDatabaseTests)("Store with no Delivery Company at all", () => {
  it("builds a whole Store tree with no relationship row and no Company columns", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const commerceId = randomUUID();
      await sql`insert into trader_commerce_profiles(id,public_name,registration_source,approval_status)
        values(${commerceId}::uuid,'Solo Shop','trader_self_registered','approved')`.execute(
        transaction,
      );
      const storefrontId = randomUUID();
      // No company_id. No trader_id. No delivery relationship. No fake rows.
      await sql`insert into trader_storefronts(
          id, trader_commerce_id, display_name, slug, business_template, theme)
        values(${storefrontId}::uuid, ${commerceId}::uuid, 'Solo Shop',
          ${`solo-${storefrontId.slice(0, 12)}`}, 'general', 'modern')`.execute(transaction);
      const categoryId = randomUUID();
      await sql`insert into trader_storefront_categories(id, storefront_id, name_en, slug)
        values(${categoryId}::uuid, ${storefrontId}::uuid, 'Solo Category', 'solo-category')`.execute(
        transaction,
      );
      const productId = randomUUID();
      await sql`insert into trader_storefront_products(
          id, storefront_id, category_id, name, slug, product_code, selling_price)
        values(${productId}::uuid, ${storefrontId}::uuid, ${categoryId}::uuid,
          'Solo Product', 'solo-product', 'SOLO-1', 100)`.execute(transaction);
      const groupId = randomUUID();
      await sql`insert into trader_storefront_product_option_groups(
          id, storefront_id, product_id, name)
        values(${groupId}::uuid, ${storefrontId}::uuid, ${productId}::uuid, 'Size')`.execute(
        transaction,
      );
      await sql`insert into trader_storefront_product_option_values(
          storefront_id, option_group_id, value)
        values(${storefrontId}::uuid, ${groupId}::uuid, 'Large')`.execute(transaction);
      // Publishing must work too, or the conversion would only have produced a
      // Store that cannot be a Store.
      await sql`update trader_storefronts set status = 'published', published_at = now()
        where id = ${storefrontId}::uuid`.execute(transaction);

      const found = await sql<{
        companyId: string | null;
        relationships: string;
        status: string;
        traderId: string | null;
      }>`
        select storefront.company_id as "companyId", storefront.trader_id as "traderId",
               storefront.status,
               (select count(*)::text from trader_delivery_company_relationships
                 where trader_commerce_id = ${commerceId}::uuid) as relationships
          from trader_storefronts storefront where storefront.id = ${storefrontId}::uuid
      `.execute(transaction);
      expect(found.rows[0]).toStrictEqual({
        companyId: null,
        relationships: "0",
        status: "published",
        traderId: null,
      });
    });
  });

  it("lets a Trader manage its Store when it has no delivery relationship", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      // The service arrangement a Trader with no Delivery Company has: the
      // IDENTITY link survives, the delivery relationship is gone entirely.
      await sql`delete from trader_delivery_company_relationships
        where trader_commerce_id = ${fixture.commerceId}::uuid`.execute(transaction);
      await sql`update trader_storefronts set company_id = null, trader_id = null
        where id = ${fixture.storefrontId}::uuid`.execute(transaction);

      const storefronts = buildStorefrontService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        kind: "trader",
        traderProfileId: fixture.traderId,
      });
      const detail = await storefronts.detail(fixture.storefrontId);
      expect(detail.id).toBe(fixture.storefrontId);

      const products = buildProductService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        kind: "trader",
        traderProfileId: fixture.traderId,
      });
      const created = await products.createCategory(
        fixture.storefrontId,
        { nameEn: "Zero Company Category" },
        randomUUID(),
      );
      expect(created).toBeDefined();
      const product = await products.createProduct(
        {
          name: "Zero Company Product",
          productCode: "ZC-0001",
          sellingPrice: "50.00",
          storefrontId: fixture.storefrontId,
        },
        randomUUID(),
      );
      expect(String(product.storefrontId)).toBe(fixture.storefrontId);
    });
  });

  it("keeps the Store and its Products when the last relationship is deleted", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const before = await sql<{ orders: string; settlements: string; slug: string }>`
        select (select count(*)::text from orders) as orders,
               (select count(*)::text from trader_settlements) as settlements,
               (select slug from trader_storefronts
                 where id = ${fixture.storefrontId}::uuid) as slug
      `.execute(transaction);
      await sql`insert into trader_storefront_categories(id, storefront_id, name_en, slug)
        values(${randomUUID()}::uuid, ${fixture.storefrontId}::uuid, 'Keep', 'keep')`.execute(
        transaction,
      );
      await sql`delete from trader_delivery_company_relationships
        where trader_commerce_id = ${fixture.commerceId}::uuid`.execute(transaction);

      const after = await sql<{
        categories: string;
        orders: string;
        settlements: string;
        status: string;
        slug: string;
      }>`
        select storefront.status, storefront.slug,
               (select count(*)::text from trader_storefront_categories
                 where storefront_id = ${fixture.storefrontId}::uuid) as categories,
               (select count(*)::text from orders) as orders,
               (select count(*)::text from trader_settlements) as settlements
          from trader_storefronts storefront where storefront.id = ${fixture.storefrontId}::uuid
      `.execute(transaction);
      expect(after.rows[0]?.status).toBe("published");
      expect(after.rows[0]?.categories).toBe("1");
      // The public address is untouched by a delivery arrangement ending —
      // compared against the slug captured BEFORE the relationship was removed.
      expect(after.rows[0]?.slug).toBe(before.rows[0]?.slug);
      expect(after.rows[0]?.orders).toBe(before.rows[0]?.orders);
      expect(after.rows[0]?.settlements).toBe(before.rows[0]?.settlements);
    });
  });
});

// -------------------------------------------------------- one / many Companies

describe.skipIf(!runDatabaseTests)("Delivery Company relationships", () => {
  it("keeps the Store Commerce-owned while one Company serves it", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const found = await sql<{ traderCommerceId: string }>`
        select trader_commerce_id as "traderCommerceId" from trader_storefronts
         where id = ${fixture.storefrontId}::uuid
      `.execute(transaction);
      expect(found.rows[0]?.traderCommerceId).toBe(fixture.commerceId);
    });
  });

  it("allows several Companies but only one enabled default", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await sql`insert into trader_delivery_company_relationships(
          trader_commerce_id, company_id, relationship_source, status,
          enabled_for_store_orders, is_default_for_store_orders)
        values(${fixture.commerceId}::uuid, ${fixture.thirdCompanyId}::uuid,
          'delivery_company_registered', 'active', true, false)`.execute(transaction);
      const count = await sql<{ total: string }>`
        select count(*)::text as total from trader_delivery_company_relationships
         where trader_commerce_id = ${fixture.commerceId}::uuid
      `.execute(transaction);
      expect(count.rows[0]?.total).toBe("2");

      await rejects(transaction, () =>
        sql`update trader_delivery_company_relationships
              set is_default_for_store_orders = true
            where trader_commerce_id = ${fixture.commerceId}::uuid
              and company_id = ${fixture.thirdCompanyId}::uuid`.execute(transaction),
      );
    });
  });

  it("clears the default when the service disables that relationship", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const delivery = buildDeliveryService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
      });
      const listed = await delivery.list(fixture.storefrontId);
      const relationship = listed.items[0]!;
      expect(relationship.isDefaultForStoreOrders).toBe(true);

      const updated = await delivery.update(
        fixture.storefrontId,
        relationship.id,
        { enabledForStoreOrders: false },
        randomUUID(),
      );
      const row = updated.items[0]!;
      // Disabled AND no longer default — a disabled default would be a route
      // that reads as configured and behaves as unconfigured.
      expect(row.enabledForStoreOrders).toBe(false);
      expect(row.isDefaultForStoreOrders).toBe(false);

      const storefront = await sql<{ status: string }>`
        select status from trader_storefronts where id = ${fixture.storefrontId}::uuid
      `.execute(transaction);
      expect(storefront.rows[0]?.status).toBe("published");
    });
  });

  it("moves the default to another relationship without ever having two", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await sql`insert into trader_delivery_company_relationships(
          trader_commerce_id, company_id, relationship_source, status,
          enabled_for_store_orders, is_default_for_store_orders)
        values(${fixture.commerceId}::uuid, ${fixture.thirdCompanyId}::uuid,
          'delivery_company_registered', 'active', true, false)`.execute(transaction);
      const delivery = buildDeliveryService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
      });
      const listed = await delivery.list(fixture.storefrontId);
      const target = listed.items.find((row) => !row.isDefaultForStoreOrders)!;
      const updated = await delivery.update(
        fixture.storefrontId,
        target.id,
        { isDefaultForStoreOrders: true },
        randomUUID(),
      );
      expect(updated.items.filter((row) => row.isDefaultForStoreOrders)).toHaveLength(1);
      expect(updated.items.find((row) => row.isDefaultForStoreOrders)?.id).toBe(target.id);
    });
  });
});

// ----------------------------------------------------------------- legacy pair

describe.skipIf(!runDatabaseTests)("Legacy Company compatibility columns", () => {
  it("still accepts a Store carrying a valid Company and Trader pair", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const found = await sql<{ companyId: string; traderId: string }>`
        select company_id as "companyId", trader_id as "traderId" from trader_storefronts
         where id = ${fixture.storefrontId}::uuid
      `.execute(transaction);
      expect(found.rows[0]).toStrictEqual({
        companyId: fixture.companyId,
        traderId: fixture.traderId,
      });
    });
  });

  it("rejects a mismatched Company and Trader pair when both are populated", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await rejects(transaction, () =>
        sql`insert into trader_storefronts(
            trader_commerce_id, company_id, trader_id, display_name, slug,
            business_template, theme)
          values(${fixture.commerceId}::uuid, ${fixture.companyId}::uuid,
            ${fixture.otherTraderId}::uuid, 'Mismatch', 'mismatch-store', 'general', 'modern')`.execute(
          transaction,
        ),
      );
    });
  });

  it("rejects a half-populated legacy pair", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      // MATCH SIMPLE would skip the foreign key entirely here; the CHECK is what
      // makes a Company without a Trader impossible.
      await rejects(transaction, () =>
        sql`insert into trader_storefronts(
            trader_commerce_id, company_id, display_name, slug, business_template, theme)
          values(${fixture.commerceId}::uuid, ${fixture.companyId}::uuid,
            'Half', 'half-store', 'general', 'modern')`.execute(transaction),
      );
    });
  });
});

// --------------------------------------------------------------- authorization

describe.skipIf(!runDatabaseTests)("Store authorization", () => {
  it("lets a Trader reach its own Store and not another Commerce Store", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildStorefrontService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        kind: "trader",
        traderProfileId: fixture.traderId,
      });
      expect((await service.detail(fixture.storefrontId)).id).toBe(fixture.storefrontId);
      await expect(service.detail(fixture.otherStorefrontId)).rejects.toThrow();
    });
  });

  it("lets a related Delivery Company user reach the Store", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildStorefrontService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
      });
      expect((await service.detail(fixture.storefrontId)).id).toBe(fixture.storefrontId);
    });
  });

  it("denies a Company whose relationship is inactive, suspended or terminated", async () => {
    for (const status of ["inactive", "suspended", "terminated"] as const) {
      await inRolledBackTransaction(async (transaction) => {
        const fixture = await seed(transaction);
        await sql`update trader_delivery_company_relationships set status = ${status}
          where trader_commerce_id = ${fixture.commerceId}::uuid`.execute(transaction);
        const service = buildStorefrontService(transaction, {
          actorId: fixture.actorId,
          companyId: fixture.companyId,
        });
        await expect(service.detail(fixture.storefrontId)).rejects.toThrow();
      });
    }
  });

  it("denies an unrelated Company that exists and has every Store permission", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildStorefrontService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.thirdCompanyId,
      });
      await expect(service.detail(fixture.storefrontId)).rejects.toThrow();
      const listed = await service.list({});
      expect(listed.items).toHaveLength(0);
    });
  });

  it("denies cross-Company access to the other shop", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildStorefrontService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
      });
      await expect(service.detail(fixture.otherStorefrontId)).rejects.toThrow();
    });
  });

  it("does not let users_roles.manage cross a relationship boundary", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      // Administrator of a Company that serves this shop: allowed.
      const related = buildStorefrontService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        permissions: ["users_roles.manage"],
      });
      expect((await related.detail(fixture.storefrontId)).id).toBe(fixture.storefrontId);

      // Same permission, Company with no relationship: denied. The escalation
      // decides which OPERATIONS are allowed, never which Stores exist.
      const unrelated = buildStorefrontService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.thirdCompanyId,
        permissions: ["users_roles.manage"],
      });
      await expect(unrelated.detail(fixture.storefrontId)).rejects.toThrow();
    });
  });
});

describe.skipIf(!runDatabaseTests)("Manipulated identifiers", () => {
  it("refuses a Storefront id belonging to another Commerce Store", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const products = buildProductService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
      });
      await expect(products.listCategories(fixture.otherStorefrontId)).rejects.toThrow();
    });
  });

  it("refuses a Product id under another Commerce Store", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const foreignProduct = randomUUID();
      await sql`insert into trader_storefront_products(
          id, storefront_id, name, slug, product_code, selling_price)
        values(${foreignProduct}::uuid, ${fixture.otherStorefrontId}::uuid,
          'Foreign', 'foreign-product', 'FOR-1', 10)`.execute(transaction);
      const products = buildProductService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
      });
      await expect(products.getProduct(foreignProduct)).rejects.toThrow();
    });
  });

  it("refuses a Category id under another Store", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const foreignCategory = randomUUID();
      await sql`insert into trader_storefront_categories(id, storefront_id, name_en, slug)
        values(${foreignCategory}::uuid, ${fixture.otherStorefrontId}::uuid, 'Foreign', 'foreign-cat')`.execute(
        transaction,
      );
      const products = buildProductService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
      });
      await expect(
        products.updateCategory(foreignCategory, { expectedVersion: 1, nameEn: "Hijack" }, randomUUID()),
      ).rejects.toThrow();
    });
  });

  it("refuses to re-point another Store's delivery relationships", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const delivery = buildDeliveryService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
      });
      await expect(delivery.list(fixture.otherStorefrontId)).rejects.toThrow();
    });
  });
});
