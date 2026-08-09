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
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import type { IdentityContextAccessor, IdentityKind } from "../security/identity-context.js";
import type { TenantContextAccessor } from "../tenancy/tenant-context.js";

import { MarketplaceMappingService } from "./marketplace-mapping.service.js";
import { MarketplaceTaxonomyService } from "./marketplace-taxonomy.service.js";

/**
 * Platform Marketplace taxonomy.
 *
 * Everything runs inside ONE transaction that is always rolled back.
 *
 * The claim this file exists to defend is that the two category systems stay
 * apart. A Product carries a Trader Store Category AND a Platform Marketplace
 * Category, and changing either must leave the other exactly as it was — that
 * is asserted directly rather than assumed from the schema.
 *
 * The second claim is that "this Subcategory belongs to that Category" is
 * enforced by the DATABASE. The test writes a mismatched pair with raw SQL,
 * bypassing every service check, and expects PostgreSQL to refuse it.
 */

const runDatabaseTests = process.env.RUN_MARKETPLACE_DATABASE === "true";

class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `mk_${++this.sequence}`;
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
  readonly abayasId: string;
  readonly actorId: string;
  readonly commerceId: string;
  readonly companyId: string;
  readonly electronicsId: string;
  readonly fashionId: string;
  readonly mobileId: string;
  readonly otherStorefrontId: string;
  readonly productId: string;
  readonly storeCategoryId: string;
  readonly storefrontId: string;
  readonly traderId: string;
}

async function seed(transaction: Transaction<DatabaseSchema>): Promise<Fixture> {
  const ids = {
    abayasId: randomUUID(),
    actorId: randomUUID(),
    commerceId: randomUUID(),
    companyId: randomUUID(),
    electronicsId: randomUUID(),
    fashionId: randomUUID(),
    mobileId: randomUUID(),
    otherCommerceId: randomUUID(),
    otherStorefrontId: randomUUID(),
    productId: randomUUID(),
    storeCategoryId: randomUUID(),
    storefrontId: randomUUID(),
    traderId: randomUUID(),
  };
  const short = ids.companyId.slice(0, 8);
  const tag = ids.storefrontId.slice(0, 12);

  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${ids.companyId}::uuid,${`MK-${short}`},${`mk-${short}`},'Taxonomy Test','active',now())`.execute(
    transaction,
  );
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${ids.actorId}::uuid,${ids.companyId}::uuid,'company_user',${`mk.${ids.actorId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into traders(id,company_id,code,name_en,mobile_number)
    values(${ids.traderId}::uuid,${ids.companyId}::uuid,${`T-${short}`},'Taxonomy Trader','971500000010')`.execute(
    transaction,
  );
  await sql`insert into trader_commerce_profiles(id,public_name,registration_source,approval_status) values
    (${ids.commerceId}::uuid,'Taxonomy Shop','trader_self_registered','approved'),
    (${ids.otherCommerceId}::uuid,'Other Shop','trader_self_registered','approved')`.execute(
    transaction,
  );
  await sql`insert into trader_commerce_company_links(trader_commerce_id,company_id,trader_id,link_source)
    values(${ids.commerceId}::uuid,${ids.companyId}::uuid,${ids.traderId}::uuid,'migration_backfill')`.execute(
    transaction,
  );
  await sql`insert into trader_storefronts(
      id, trader_commerce_id, display_name, slug, business_template, theme, status, published_at)
    values(${ids.storefrontId}::uuid, ${ids.commerceId}::uuid, 'Taxonomy Shop',
      ${`tax-${tag}`}, 'fashion', 'modern', 'published', now())`.execute(transaction);
  await sql`insert into trader_storefronts(
      id, trader_commerce_id, display_name, slug, business_template, theme)
    values(${ids.otherStorefrontId}::uuid, ${ids.otherCommerceId}::uuid, 'Other Shop',
      ${`othertax-${tag}`}, 'general', 'modern')`.execute(transaction);

  // The Trader's OWN shelf label. Untouched by anything marketplace-related.
  await sql`insert into trader_storefront_categories(id, storefront_id, name_en, slug)
    values(${ids.storeCategoryId}::uuid, ${ids.storefrontId}::uuid, 'Eid Collection', 'eid-collection')`.execute(
    transaction,
  );
  await sql`insert into trader_storefront_products(
      id, storefront_id, category_id, name, slug, product_code, selling_price, lifecycle_status)
    values(${ids.productId}::uuid, ${ids.storefrontId}::uuid, ${ids.storeCategoryId}::uuid,
      'Taxonomy Product', 'taxonomy-product', 'TAX-1', 100, 'active')`.execute(transaction);

  // Platform vocabulary.
  await sql`insert into marketplace_categories(id,name_en,name_ar,slug,display_order) values
    (${ids.fashionId}::uuid,'Fashion','أزياء',${`fashion-${tag}`},1),
    (${ids.electronicsId}::uuid,'Electronics',null,${`electronics-${tag}`},2)`.execute(transaction);
  await sql`insert into marketplace_subcategories(
      id, marketplace_category_id, name_en, slug, display_order) values
    (${ids.abayasId}::uuid, ${ids.fashionId}::uuid, 'Abayas', 'abayas', 1),
    (${ids.mobileId}::uuid, ${ids.electronicsId}::uuid, 'Mobile Phones', 'mobile-phones', 1)`.execute(
    transaction,
  );
  return ids;
}

function buildMapping(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly actorId: string;
    readonly companyId: string;
    readonly kind?: IdentityKind;
    readonly traderProfileId?: string;
  },
): MarketplaceMappingService {
  const permissions = new Set(["storefront.manage", "storefront_products.manage"]);
  const tenants = {
    current: () => ({ companyId: input.companyId, identityId: input.actorId }),
  } as unknown as TenantContextAccessor;
  const identities = {
    current: () => ({
      companyId: input.companyId,
      forcePasswordChange: false,
      identityId: input.actorId,
      kind: input.kind ?? "trader",
      permissions,
      sessionId: randomUUID(),
      ...(input.traderProfileId === undefined ? {} : { profileId: input.traderProfileId }),
    }),
  } as unknown as IdentityContextAccessor;
  return new MarketplaceMappingService(
    transaction as unknown as Kysely<DatabaseSchema>,
    new SavepointTransactionManager(transaction) as unknown as KyselyTransactionManager,
    tenants,
    identities,
    new OperationsHistoryWriter(),
  );
}

function buildTaxonomy(transaction: Transaction<DatabaseSchema>): MarketplaceTaxonomyService {
  return new MarketplaceTaxonomyService(transaction as unknown as Kysely<DatabaseSchema>);
}

async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
): Promise<void> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const marker = new Error("rollback taxonomy test");
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
  const savepoint = `mkr_${randomUUID().replace(/-/g, "")}`;
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

// ------------------------------------------------------------------ taxonomy

describe.skipIf(!runDatabaseTests)("Marketplace taxonomy integrity", () => {
  it("refuses a duplicate Category slug case-insensitively", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const slug = await sql<{ slug: string }>`
        select slug from marketplace_categories where id = ${fixture.fashionId}::uuid
      `.execute(transaction);
      await rejects(transaction, () =>
        sql`insert into marketplace_categories(name_en, slug)
          values('Fashion Again', ${slug.rows[0]!.slug.toUpperCase()})`.execute(transaction),
      );
    });
  });

  it("refuses a Subcategory whose parent does not exist", async () => {
    await inRolledBackTransaction(async (transaction) => {
      await seed(transaction);
      await rejects(transaction, () =>
        sql`insert into marketplace_subcategories(marketplace_category_id, name_en, slug)
          values(${randomUUID()}::uuid, 'Orphan', 'orphan')`.execute(transaction),
      );
    });
  });

  it("refuses a duplicate Subcategory slug under the same parent", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await rejects(transaction, () =>
        sql`insert into marketplace_subcategories(marketplace_category_id, name_en, slug)
          values(${fixture.fashionId}::uuid, 'Abayas Again', 'ABAYAS')`.execute(transaction),
      );
    });
  });

  it("allows the same Subcategory slug under a different parent", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      // "Women" under Fashion and under Electronics are different things and
      // must be able to coexist — uniqueness is per parent, not global.
      await sql`insert into marketplace_subcategories(marketplace_category_id, name_en, slug) values
        (${fixture.fashionId}::uuid, 'Women', 'women'),
        (${fixture.electronicsId}::uuid, 'Women', 'women')`.execute(transaction);
      // Scoped to this fixture's two Categories: the development taxonomy seed
      // also contains a "women" Subcategory, and an unscoped count would be
      // measuring that instead.
      const found = await sql<{ total: string }>`
        select count(*)::text as total from marketplace_subcategories
         where slug = 'women'
           and marketplace_category_id in (${fixture.fashionId}::uuid, ${fixture.electronicsId}::uuid)
      `.execute(transaction);
      expect(found.rows[0]?.total).toBe("2");
    });
  });

  it("hides an inactive Category and its children from the public API", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const taxonomy = buildTaxonomy(transaction);
      await sql`update marketplace_categories set is_active = false
        where id = ${fixture.fashionId}::uuid`.execute(transaction);

      // By slug, not by name: the development seed also has a Category called
      // "Fashion", so a name check would pass for the wrong reason.
      const fixtureSlug = `fashion-${fixture.storefrontId.slice(0, 12)}`;
      const listed = await taxonomy.publicCategories();
      expect(listed.items.some((row) => row.slug === fixtureSlug)).toBe(false);
      await expect(taxonomy.publicCategory(`fashion-${fixture.storefrontId.slice(0, 12)}`))
        .rejects.toThrow();
      // The child is still individually active, but its parent is not, so it
      // must not resolve publicly either.
      await expect(
        taxonomy.publicSubcategory(`fashion-${fixture.storefrontId.slice(0, 12)}`, "abayas"),
      ).rejects.toThrow();
    });
  });

  it("keeps a deactivated parent's children rows untouched", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await sql`update marketplace_categories set is_active = false
        where id = ${fixture.fashionId}::uuid`.execute(transaction);
      const child = await sql<{ isActive: boolean }>`
        select is_active as "isActive" from marketplace_subcategories
         where id = ${fixture.abayasId}::uuid
      `.execute(transaction);
      // Reactivating the parent must restore the previous shape exactly, which
      // it cannot do if the children were flattened on the way down.
      expect(child.rows[0]?.isActive).toBe(true);
    });
  });
});

// -------------------------------------------------------- Product mapping

describe.skipIf(!runDatabaseTests)("Product marketplace classification", () => {
  it("accepts a Category with a Subcategory that belongs to it", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const mapping = buildMapping(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        traderProfileId: fixture.traderId,
      });
      const result = await mapping.setProductClassification(
        fixture.productId,
        {
          marketplaceCategoryId: fixture.fashionId,
          marketplaceSubcategoryId: fixture.abayasId,
        },
        randomUUID(),
      );
      expect(result).toStrictEqual({
        marketplaceCategoryId: fixture.fashionId,
        marketplaceSubcategoryId: fixture.abayasId,
      });
    });
  });

  it("refuses a Subcategory from a different Category — enforced by the database", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      // Raw SQL, bypassing every service check. PostgreSQL must still refuse
      // Electronics + Abayas, because the composite foreign key has no such
      // (subcategory, category) pair.
      await rejects(transaction, () =>
        sql`update trader_storefront_products
              set marketplace_category_id = ${fixture.electronicsId}::uuid,
                  marketplace_subcategory_id = ${fixture.abayasId}::uuid
            where id = ${fixture.productId}::uuid`.execute(transaction),
      );
    });
  });

  it("refuses a Subcategory with no Category", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await rejects(transaction, () =>
        sql`update trader_storefront_products
              set marketplace_subcategory_id = ${fixture.abayasId}::uuid
            where id = ${fixture.productId}::uuid`.execute(transaction),
      );
    });
  });

  it("leaves the Trader Store Category completely alone", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const mapping = buildMapping(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        traderProfileId: fixture.traderId,
      });
      await mapping.setProductClassification(
        fixture.productId,
        {
          marketplaceCategoryId: fixture.fashionId,
          marketplaceSubcategoryId: fixture.abayasId,
        },
        randomUUID(),
      );
      const product = await sql<{
        categoryId: string;
        marketplaceCategoryId: string;
      }>`
        select category_id as "categoryId",
               marketplace_category_id as "marketplaceCategoryId"
          from trader_storefront_products where id = ${fixture.productId}::uuid
      `.execute(transaction);
      // Both classifications coexist. "Eid Collection" did not move.
      expect(product.rows[0]).toStrictEqual({
        categoryId: fixture.storeCategoryId,
        marketplaceCategoryId: fixture.fashionId,
      });
    });
  });

  it("allows a Product to remain unclassified, and to be cleared again", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const before = await sql<{ categoryId: string | null }>`
        select marketplace_category_id as "categoryId" from trader_storefront_products
         where id = ${fixture.productId}::uuid
      `.execute(transaction);
      // The migration classified nothing; a Product starts unclassified.
      expect(before.rows[0]?.categoryId).toBeNull();

      const mapping = buildMapping(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        traderProfileId: fixture.traderId,
      });
      await mapping.setProductClassification(
        fixture.productId,
        { marketplaceCategoryId: fixture.fashionId, marketplaceSubcategoryId: null },
        randomUUID(),
      );
      const cleared = await mapping.setProductClassification(
        fixture.productId,
        { marketplaceCategoryId: null, marketplaceSubcategoryId: null },
        randomUUID(),
      );
      expect(cleared).toStrictEqual({
        marketplaceCategoryId: null,
        marketplaceSubcategoryId: null,
      });
    });
  });

  it("refuses an inactive Category at the service layer", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await sql`update marketplace_categories set is_active = false
        where id = ${fixture.fashionId}::uuid`.execute(transaction);
      const mapping = buildMapping(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        traderProfileId: fixture.traderId,
      });
      // A foreign key cannot test a column value, so this one is the service's
      // job — and it is the reason classification is validated before the write.
      await expect(
        mapping.setProductClassification(
          fixture.productId,
          { marketplaceCategoryId: fixture.fashionId, marketplaceSubcategoryId: null },
          randomUUID(),
        ),
      ).rejects.toThrow();
    });
  });
});

// ----------------------------------------------------------- Store mapping

describe.skipIf(!runDatabaseTests)("Store marketplace classification", () => {
  it("records a primary and additional Categories", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const mapping = buildMapping(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        traderProfileId: fixture.traderId,
      });
      const result = await mapping.setStoreCategories(
        fixture.storefrontId,
        {
          categoryIds: [fixture.fashionId, fixture.electronicsId],
          primaryCategoryId: fixture.fashionId,
        },
        randomUUID(),
      );
      expect(result.items).toHaveLength(2);
      expect(result.items.filter((row) => row.isPrimary)).toHaveLength(1);
      expect(result.items[0]?.marketplaceCategoryId).toBe(fixture.fashionId);
    });
  });

  it("refuses two primaries — enforced by the database", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await sql`insert into storefront_marketplace_categories(
          storefront_id, marketplace_category_id, is_primary)
        values(${fixture.storefrontId}::uuid, ${fixture.fashionId}::uuid, true)`.execute(
        transaction,
      );
      await rejects(transaction, () =>
        sql`insert into storefront_marketplace_categories(
            storefront_id, marketplace_category_id, is_primary)
          values(${fixture.storefrontId}::uuid, ${fixture.electronicsId}::uuid, true)`.execute(
          transaction,
        ),
      );
    });
  });

  it("refuses a duplicate mapping", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await sql`insert into storefront_marketplace_categories(
          storefront_id, marketplace_category_id)
        values(${fixture.storefrontId}::uuid, ${fixture.fashionId}::uuid)`.execute(transaction);
      await rejects(transaction, () =>
        sql`insert into storefront_marketplace_categories(
            storefront_id, marketplace_category_id)
          values(${fixture.storefrontId}::uuid, ${fixture.fashionId}::uuid)`.execute(transaction),
      );
    });
  });

  it("refuses a primary that is not among the selected Categories", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const mapping = buildMapping(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        traderProfileId: fixture.traderId,
      });
      await expect(
        mapping.setStoreCategories(
          fixture.storefrontId,
          { categoryIds: [fixture.fashionId], primaryCategoryId: fixture.electronicsId },
          randomUUID(),
        ),
      ).rejects.toThrow();
    });
  });

  it("denies mapping a Store the actor cannot reach", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const mapping = buildMapping(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        traderProfileId: fixture.traderId,
      });
      await expect(
        mapping.setStoreCategories(
          fixture.otherStorefrontId,
          { categoryIds: [fixture.fashionId], primaryCategoryId: fixture.fashionId },
          randomUUID(),
        ),
      ).rejects.toThrow();
    });
  });

  it("denies an unrelated Company user with Store permissions", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      // A Company user, and this shop has no relationship with any Company.
      const mapping = buildMapping(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        kind: "company_user",
      });
      await expect(
        mapping.setStoreCategories(
          fixture.storefrontId,
          { categoryIds: [fixture.fashionId], primaryCategoryId: fixture.fashionId },
          randomUUID(),
        ),
      ).rejects.toThrow();
    });
  });
});

// -------------------------------------------------------- public filtering

describe.skipIf(!runDatabaseTests)("Public category results", () => {
  it("returns only Products in the requested Subcategory", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const tag = fixture.storefrontId.slice(0, 12);
      const womenId = randomUUID();
      await sql`insert into marketplace_subcategories(
          id, marketplace_category_id, name_en, slug)
        values(${womenId}::uuid, ${fixture.fashionId}::uuid, 'Women', 'women')`.execute(
        transaction,
      );
      await sql`update trader_storefront_products
           set marketplace_category_id = ${fixture.fashionId}::uuid,
               marketplace_subcategory_id = ${fixture.abayasId}::uuid
         where id = ${fixture.productId}::uuid`.execute(transaction);

      const taxonomy = buildTaxonomy(transaction);
      const abayas = await taxonomy.publicProductsInCategory({
        categorySlug: `fashion-${tag}`,
        subcategorySlug: "abayas",
      });
      expect(abayas.total).toBe(1);
      // The sibling must be empty — not "also shows the Category's products".
      const women = await taxonomy.publicProductsInCategory({
        categorySlug: `fashion-${tag}`,
        subcategorySlug: "women",
      });
      expect(women.total).toBe(0);
      expect(women.items).toStrictEqual([]);
    });
  });

  it("excludes a Product whose Store is not publicly resolvable", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const tag = fixture.storefrontId.slice(0, 12);
      await sql`update trader_storefront_products
           set marketplace_category_id = ${fixture.fashionId}::uuid
         where id = ${fixture.productId}::uuid`.execute(transaction);
      await sql`update trader_storefronts set status = 'unpublished'
         where id = ${fixture.storefrontId}::uuid`.execute(transaction);

      const taxonomy = buildTaxonomy(transaction);
      const result = await taxonomy.publicProductsInCategory({ categorySlug: `fashion-${tag}` });
      // Classification does not make a private shop public.
      expect(result.total).toBe(0);
    });
  });

  it("excludes a draft Product even when it is classified", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const tag = fixture.storefrontId.slice(0, 12);
      await sql`update trader_storefront_products
           set marketplace_category_id = ${fixture.fashionId}::uuid,
               lifecycle_status = 'draft'
         where id = ${fixture.productId}::uuid`.execute(transaction);
      const taxonomy = buildTaxonomy(transaction);
      const result = await taxonomy.publicProductsInCategory({ categorySlug: `fashion-${tag}` });
      expect(result.total).toBe(0);
    });
  });

  it("pages server-side and reports a total", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const tag = fixture.storefrontId.slice(0, 12);
      await sql`update trader_storefront_products
           set marketplace_category_id = ${fixture.fashionId}::uuid
         where id = ${fixture.productId}::uuid`.execute(transaction);
      for (let index = 0; index < 3; index += 1) {
        // `trader_storefront_products_active_category_check` requires an ACTIVE
        // Product to sit in a Trader Store Category — a rule that predates
        // marketplace classification and is unrelated to it.
        await sql`insert into trader_storefront_products(
            storefront_id, category_id, name, slug, product_code, selling_price,
            lifecycle_status, marketplace_category_id)
          values(${fixture.storefrontId}::uuid, ${fixture.storeCategoryId}::uuid,
            ${`Extra ${index}`}, ${`extra-${index}`},
            ${`EX-${index}`}, 10, 'active', ${fixture.fashionId}::uuid)`.execute(transaction);
      }
      const taxonomy = buildTaxonomy(transaction);
      const firstPage = await taxonomy.publicProductsInCategory({
        categorySlug: `fashion-${tag}`,
        page: 1,
        pageSize: 2,
      });
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.total).toBe(4);
      const secondPage = await taxonomy.publicProductsInCategory({
        categorySlug: `fashion-${tag}`,
        page: 2,
        pageSize: 2,
      });
      expect(secondPage.items).toHaveLength(2);
      expect(secondPage.items[0]?.name).not.toBe(firstPage.items[0]?.name);
    });
  });

  it("excludes an unpublished Store from Category store results", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const tag = fixture.storefrontId.slice(0, 12);
      await sql`insert into storefront_marketplace_categories(
          storefront_id, marketplace_category_id, is_primary)
        values(${fixture.storefrontId}::uuid, ${fixture.fashionId}::uuid, true)`.execute(
        transaction,
      );
      const taxonomy = buildTaxonomy(transaction);
      expect((await taxonomy.publicStoresInCategory(`fashion-${tag}`)).items).toHaveLength(1);

      await sql`update trader_storefronts set status = 'suspended', suspended_at = now()
         where id = ${fixture.storefrontId}::uuid`.execute(transaction);
      expect((await taxonomy.publicStoresInCategory(`fashion-${tag}`)).items).toHaveLength(0);
    });
  });

  it("exposes no internal identifier on the public taxonomy surface", async () => {
    await inRolledBackTransaction(async (transaction) => {
      await seed(transaction);
      const taxonomy = buildTaxonomy(transaction);
      const listed = await taxonomy.publicCategories();
      for (const row of listed.items) {
        // An exact list, not a subset: a column added to the table later must
        // fail here rather than quietly reach the public surface.
        //
        // The `seo*` entries are Platform-authored override text plus one
        // boolean, all of which the Store server needs in order to build
        // crawler-visible metadata. None of them is an identifier, and the
        // point of this assertion -- no `id`, no `marketplaceCategoryId`, no
        // audit columns -- still holds.
        expect(Object.keys(row).sort()).toStrictEqual([
          "descriptionAr",
          "descriptionEn",
          "displayOrder",
          "nameAr",
          "nameEn",
          "seoDescriptionAr",
          "seoDescriptionEn",
          "seoIndexable",
          "seoTitleAr",
          "seoTitleEn",
          "slug",
          "subcategoryCount",
        ]);
      }
    });
  });
});
