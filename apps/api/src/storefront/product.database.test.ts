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

/**
 * Product Catalogue persistence against the real schema.
 *
 * Everything runs inside ONE transaction that is always rolled back, so no row
 * created here outlives the test and no existing record is touched. The claims
 * under test are the ones that would be expensive to be wrong about: that a
 * Company cannot reach another Company's catalogue, that a public URL cannot be
 * claimed twice, that money and media limits hold under the database rather
 * than only in the service, and that a private Product is invisible to the
 * open web.
 */

const runDatabaseTests = process.env.RUN_STOREFRONT_PRODUCT_DATABASE === "true";

class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `pc_${++this.sequence}`;
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
  readonly companyId: string;
  readonly otherActorId: string;
  readonly otherCompanyId: string;
  readonly otherStorefrontId: string;
  readonly otherTraderId: string;
  readonly storefrontId: string;
  readonly traderId: string;
}

async function seed(
  transaction: Transaction<DatabaseSchema>,
  template = "fashion",
): Promise<Fixture> {
  const ids = {
    actorId: randomUUID(),
    companyId: randomUUID(),
    otherActorId: randomUUID(),
    otherCompanyId: randomUUID(),
    otherStorefrontId: randomUUID(),
    otherTraderId: randomUUID(),
    storefrontId: randomUUID(),
    traderId: randomUUID(),
  };
  const short = ids.companyId.slice(0, 8);
  const otherShort = ids.otherCompanyId.slice(0, 8);

  for (const [id, code, label] of [
    [ids.companyId, `PC-${short}`, `pc-${short}`],
    [ids.otherCompanyId, `PCB-${otherShort}`, `pcb-${otherShort}`],
  ] as const) {
    await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
      values(${id}::uuid,${code},${label},'Catalogue Test','active',now())`.execute(transaction);
  }
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash) values
    (${ids.actorId}::uuid,${ids.companyId}::uuid,'company_user',${`pc.a.${ids.actorId}`},'x'),
    (${ids.otherActorId}::uuid,${ids.otherCompanyId}::uuid,'company_user',${`pc.b.${ids.otherActorId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into traders(id,company_id,code,name_en,mobile_number) values
    (${ids.traderId}::uuid,${ids.companyId}::uuid,${`T-${short}`},'Catalogue Trader','971500000010'),
    (${ids.otherTraderId}::uuid,${ids.otherCompanyId}::uuid,${`T-${otherShort}`},'Other Trader','971500000011')`.execute(
    transaction,
  );
  // Each shop needs its own Trader Commerce identity: `trader_commerce_id` is
  // mandatory, and this seed writes Storefronts directly rather than through the
  // service that would otherwise resolve one.
  const commerceId = randomUUID();
  const otherCommerceId = randomUUID();
  await sql`insert into trader_commerce_profiles(id,public_name,registration_source,approval_status) values
    (${commerceId}::uuid,'Shop A','delivery_company_registered','approved'),
    (${otherCommerceId}::uuid,'Shop B','delivery_company_registered','approved')`.execute(
    transaction,
  );
  await sql`insert into trader_commerce_company_links(trader_commerce_id,company_id,trader_id,link_source) values
    (${commerceId}::uuid,${ids.companyId}::uuid,${ids.traderId}::uuid,'migration_backfill'),
    (${otherCommerceId}::uuid,${ids.otherCompanyId}::uuid,${ids.otherTraderId}::uuid,'migration_backfill')`.execute(
    transaction,
  );
  // Since 0B-1 a Delivery Company reaches a Store through an ACTIVE
  // relationship, not through `company_id`. Without these rows a Company user
  // sees nothing — which is the new rule working, not a broken fixture.
  await sql`insert into trader_delivery_company_relationships(
      trader_commerce_id, company_id, trader_id, relationship_source, status,
      enabled_for_store_orders, is_default_for_store_orders) values
    (${commerceId}::uuid,${ids.companyId}::uuid,${ids.traderId}::uuid,'delivery_company_registered','active',true,true),
    (${otherCommerceId}::uuid,${ids.otherCompanyId}::uuid,${ids.otherTraderId}::uuid,'delivery_company_registered','active',true,true)`.execute(
    transaction,
  );
  // Both Storefronts published, so public behaviour is decided by the PRODUCT
  // status rather than by the shop being closed.
  await sql`insert into trader_storefronts(
      id,company_id,trader_id,trader_commerce_id,display_name,slug,business_template,theme,status,published_at
    ) values
    (${ids.storefrontId}::uuid,${ids.companyId}::uuid,${ids.traderId}::uuid,${commerceId}::uuid,'Shop A',
     ${`shop-a-${short}`},${template},'modern','published',now()),
    (${ids.otherStorefrontId}::uuid,${ids.otherCompanyId}::uuid,${ids.otherTraderId}::uuid,
     ${otherCommerceId}::uuid,'Shop B',
     ${`shop-b-${otherShort}`},'general','modern','published',now())`.execute(transaction);
  return ids;
}

function buildService(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly actorId: string;
    readonly companyId: string;
    readonly kind?: IdentityKind;
    readonly permissions?: readonly string[];
    readonly traderProfileId?: string;
  },
): StorefrontProductService {
  const permissions = new Set(
    input.permissions ?? [
      "storefront_products.view",
      "storefront_products.manage",
      "storefront_products.publish",
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
  return new StorefrontProductService(
    transaction as unknown as Kysely<DatabaseSchema>,
    new SavepointTransactionManager(transaction) as unknown as KyselyTransactionManager,
    tenants,
    identities,
    new OperationsHistoryWriter(),
    new FileOwnershipService(transaction as unknown as Kysely<DatabaseSchema>),
  );
}

async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>) => Promise<void>,
): Promise<void> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const marker = new Error("rollback product catalogue test");
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

/** A category plus a draft Product, the starting point for most cases. */
async function draftProduct(
  service: StorefrontProductService,
  fixture: Fixture,
  overrides: { readonly productCode?: string; readonly slug?: string } = {},
) {
  const category = await service.createCategory(
    fixture.storefrontId,
    { nameEn: "Abayas" },
    randomUUID(),
  );
  const product = await service.createProduct(
    {
      categoryId: String(category.id),
      name: "Embroidered Abaya",
      productCode: overrides.productCode ?? "ABAYA-0001",
      sellingPrice: "249.00",
      slug: overrides.slug ?? "embroidered-abaya",
      storefrontId: fixture.storefrontId,
    },
    randomUUID(),
  );
  return { categoryId: String(category.id), product };
}

/** An image, so activation requirements can be satisfied. */
async function addImage(
  service: StorefrontProductService,
  productId: string,
  url = "https://cdn.example.test/a.jpg",
) {
  return service.addMedia(productId, { mediaType: "image", mediaUrl: url }, randomUUID());
}

describe.skipIf(!runDatabaseTests)("Product Catalogue persistence", () => {
  // ---------------------------------------------------- ownership/isolation

  it("creates a Category and Product owned by the Company and Trader", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      expect(product.slug).toBe("embroidered-abaya");
      expect(product.lifecycleStatus).toBe("draft");
      expect(product.availabilityStatus).toBe("available");
      expect(String(product.traderId)).toBe(fixture.traderId);
      expect(String(product.companyId)).toBe(fixture.companyId);
    });
  });

  it("denies one Company access to another Company's Product", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { product } = await draftProduct(buildService(transaction, fixture), fixture);
      const neighbour = buildService(transaction, {
        actorId: fixture.otherActorId,
        companyId: fixture.otherCompanyId,
      });
      // Not-found rather than forbidden: a 403 confirms the record exists.
      await expect(neighbour.getProduct(String(product.id))).rejects.toMatchObject({
        errorCode: "product_not_found",
      });
      await expect(
        neighbour.updateProduct(String(product.id), { expectedVersion: 1 }, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "product_not_found" });
    });
  });

  it("pins a Trader identity to its own catalogue", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const { product } = await draftProduct(buildService(transaction, fixture), fixture);
      const strangerTrader = randomUUID();
      await sql`insert into traders(id,company_id,code,name_en,mobile_number)
        values(${strangerTrader}::uuid,${fixture.companyId}::uuid,
               ${`T2-${fixture.companyId.slice(0, 8)}`},'Stranger','971500000012')`.execute(
        transaction,
      );
      const stranger = buildService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        kind: "trader",
        permissions: [],
        traderProfileId: strangerTrader,
      });
      await expect(stranger.getProduct(String(product.id))).rejects.toMatchObject({
        errorCode: "product_not_found",
      });
    });
  });

  it("refuses a Product on another Company's Storefront", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      await expect(
        service.createProduct(
          {
            name: "Cross tenant",
            productCode: "X-1",
            sellingPrice: "10.00",
            slug: "cross-tenant",
            storefrontId: fixture.otherStorefrontId,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "storefront_not_found" });
    });
  });

  it("refuses a Category belonging to another Storefront", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const neighbourCategory = await buildService(transaction, {
        actorId: fixture.otherActorId,
        companyId: fixture.otherCompanyId,
      }).createCategory(fixture.otherStorefrontId, { nameEn: "Theirs" }, randomUUID());
      const service = buildService(transaction, fixture);
      await expect(
        service.createProduct(
          {
            categoryId: String(neighbourCategory.id),
            name: "Wrong category",
            productCode: "WC-1",
            sellingPrice: "10.00",
            slug: "wrong-category",
            storefrontId: fixture.storefrontId,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "product_category_not_in_storefront" });
    });
  });

  // ------------------------------------------------------------- uniqueness

  it("enforces case-insensitive slug uniqueness within one Storefront", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const { categoryId } = await draftProduct(service, fixture);
      await expect(
        service.createProduct(
          {
            categoryId,
            name: "Duplicate",
            productCode: "OTHER-1",
            sellingPrice: "10.00",
            slug: "Embroidered-ABAYA",
            storefrontId: fixture.storefrontId,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "product_slug_taken" });
    });
  });

  it("allows the same Product slug in a different Storefront", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await draftProduct(buildService(transaction, fixture), fixture);
      // The Storefront slug is already globally unique, so the Product slug
      // only has to be unique within one shop.
      const neighbour = buildService(transaction, {
        actorId: fixture.otherActorId,
        companyId: fixture.otherCompanyId,
      });
      const created = await neighbour.createProduct(
        {
          name: "Embroidered Abaya",
          productCode: "ABAYA-0001",
          sellingPrice: "249.00",
          slug: "embroidered-abaya",
          storefrontId: fixture.otherStorefrontId,
        },
        randomUUID(),
      );
      expect(created.slug).toBe("embroidered-abaya");
    });
  });

  it("enforces case-insensitive Product-code uniqueness and preserves leading zeros", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const { categoryId } = await draftProduct(service, fixture, { productCode: "0001-ABAYA" });
      const stored = await sql<{ code: string }>`
        select product_code as code from trader_storefront_products
         where storefront_id = ${fixture.storefrontId}::uuid`.execute(transaction);
      // The code is printed on labels; normalising it would change identity.
      expect(stored.rows[0]!.code).toBe("0001-ABAYA");
      await expect(
        service.createProduct(
          {
            categoryId,
            name: "Same code",
            productCode: "0001-abaya",
            sellingPrice: "10.00",
            slug: "same-code",
            storefrontId: fixture.storefrontId,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "product_code_taken" });
    });
  });

  it("lets the unique index arbitrate a concurrent duplicate claim", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const { categoryId } = await draftProduct(service, fixture);
      // Another writer takes the slug between check and insert.
      await sql`insert into trader_storefront_products(
          company_id, storefront_id, trader_id, category_id, name, slug, product_code, selling_price
        ) values(${fixture.companyId}::uuid, ${fixture.storefrontId}::uuid,
                 ${fixture.traderId}::uuid, ${categoryId}::uuid, 'Rival', 'contested-slug',
                 'RIVAL-1', 10)`.execute(transaction);
      await expect(
        service.createProduct(
          {
            categoryId,
            name: "Loser",
            productCode: "LOSER-1",
            sellingPrice: "10.00",
            slug: "contested-slug",
            storefrontId: fixture.storefrontId,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "product_slug_taken" });
    });
  });

  // -------------------------------------------------------------- money

  it("refuses a zero or negative selling price", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const { categoryId } = await draftProduct(service, fixture);
      // The CHECK is the authority; a zero-price Product is not sellable and
      // inquiry-only is out of scope.
      await expect(
        sql`insert into trader_storefront_products(
            company_id, storefront_id, trader_id, category_id, name, slug, product_code, selling_price
          ) values(${fixture.companyId}::uuid, ${fixture.storefrontId}::uuid,
                   ${fixture.traderId}::uuid, ${categoryId}::uuid, 'Free', 'free-item', 'FREE-1', 0)`.execute(
          transaction,
        ),
      ).rejects.toMatchObject({ constraint: "trader_storefront_products_price_check" });
    });
  });

  it("refuses a comparison price that is not higher", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const { categoryId } = await draftProduct(service, fixture);
      await expect(
        service.createProduct(
          {
            categoryId,
            name: "Bad discount",
            previousPrice: "100.00",
            productCode: "BD-1",
            sellingPrice: "200.00",
            slug: "bad-discount",
            storefrontId: fixture.storefrontId,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "product_previous_price_invalid" });
    });
  });

  it("restricts the currency to AED", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      await expect(
        sql`update trader_storefront_products set currency='USD' where id=${String(product.id)}::uuid`.execute(
          transaction,
        ),
      ).rejects.toMatchObject({ constraint: "trader_storefront_products_currency_check" });
    });
  });

  it("refuses a maximum quantity below the minimum", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      await expect(
        service.updateProduct(
          String(product.id),
          { expectedVersion: Number(product.version), maximumQuantity: 2, minimumQuantity: 5 },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ constraint: "trader_storefront_products_quantity_check" });
    });
  });

  // ---------------------------------------------------------- lifecycle

  it("requires an image, a primary image and template attributes before activation", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "fashion");
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);

      // No image, no required attribute.
      await expect(
        service.activate(String(product.id), { expectedVersion: 1 }, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "product_incomplete_for_activation" });

      await addImage(service, String(product.id));
      // Still missing the Fashion template's required `material`.
      await expect(
        service.activate(String(product.id), { expectedVersion: 1 }, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "product_incomplete_for_activation" });

      const updated = await service.updateProduct(
        String(product.id),
        { expectedVersion: 1, templateAttributes: { material: "Cotton" } },
        randomUUID(),
      );
      const activated = await service.activate(
        String(product.id),
        { expectedVersion: Number(updated.version) },
        randomUUID(),
      );
      expect(activated.lifecycleStatus).toBe("active");
    });
  });

  it("walks active, inactive and back, then archives terminally", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      await addImage(service, String(product.id));
      let version = Number(product.version);
      version = Number(
        (await service.activate(String(product.id), { expectedVersion: version }, randomUUID()))
          .version,
      );
      version = Number(
        (await service.deactivate(String(product.id), { expectedVersion: version }, randomUUID()))
          .version,
      );
      version = Number(
        (await service.activate(String(product.id), { expectedVersion: version }, randomUUID()))
          .version,
      );
      const archived = await service.archive(
        String(product.id),
        { expectedVersion: version },
        randomUUID(),
      );
      expect(archived.lifecycleStatus).toBe("archived");
      expect(archived.archivedAt).not.toBeNull();
      // Terminal: nothing leaves archive.
      await expect(
        service.activate(
          String(product.id),
          { expectedVersion: Number(archived.version) },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "product_transition_invalid" });
    });
  });

  it("protects an archived Product from business edits", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      const archived = await service.archive(
        String(product.id),
        { expectedVersion: Number(product.version) },
        randomUUID(),
      );
      await expect(
        service.updateProduct(
          String(product.id),
          { expectedVersion: Number(archived.version), sellingPrice: "1.00" },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "product_archived_readonly" });
      // The trigger is the floor, independent of the service.
      await expect(
        sql`update trader_storefront_products set selling_price = 1
             where id = ${String(product.id)}::uuid`.execute(transaction),
      ).rejects.toMatchObject({ message: expect.stringContaining("archived Product") });
    });
  });

  it("changes availability without changing visibility", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      await addImage(service, String(product.id));
      const active = await service.activate(
        String(product.id),
        { expectedVersion: Number(product.version) },
        randomUUID(),
      );
      const unavailable = await service.setAvailability(
        String(product.id),
        { availabilityStatus: "unavailable", expectedVersion: Number(active.version) },
        randomUUID(),
      );
      expect(unavailable.availabilityStatus).toBe("unavailable");
      expect(unavailable.lifecycleStatus).toBe("active");
    });
  });

  // -------------------------------------------------------------- media

  it("caps active images at eight", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      for (let index = 0; index < 8; index += 1) {
        await addImage(service, String(product.id), `https://cdn.example.test/${index}.jpg`);
      }
      await expect(
        addImage(service, String(product.id), "https://cdn.example.test/9.jpg"),
      ).rejects.toMatchObject({ errorCode: "product_media_image_limit" });
    });
  });

  it("keeps exactly one primary image, enforced by the index", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      const first = await addImage(service, String(product.id), "https://cdn.example.test/1.jpg");
      const second = await addImage(service, String(product.id), "https://cdn.example.test/2.jpg");
      // The first image becomes primary automatically.
      expect(first.isPrimary).toBe(true);
      expect(second.isPrimary).toBe(false);

      await service.setPrimaryImage(String(second.id), randomUUID());
      const primaries = await sql<{ count: number }>`
        select count(*)::int as count from trader_storefront_product_media
         where product_id = ${String(product.id)}::uuid and is_primary and is_active`.execute(
        transaction,
      );
      expect(primaries.rows[0]!.count).toBe(1);

      // A second concurrent primary is refused by the partial unique index.
      await expect(
        sql`update trader_storefront_product_media set is_primary = true
             where id = ${String(first.id)}::uuid`.execute(transaction),
      ).rejects.toMatchObject({ constraint: "trader_storefront_product_media_primary_unique" });
    });
  });

  it("allows only one active video", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      await service.addMedia(
        String(product.id),
        { mediaType: "video", mediaUrl: "https://cdn.example.test/a.mp4" },
        randomUUID(),
      );
      await expect(
        service.addMedia(
          String(product.id),
          { mediaType: "video", mediaUrl: "https://cdn.example.test/b.mp4" },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "product_media_video_limit" });
    });
  });

  it("requires exactly one of a file reference or a URL", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      await expect(
        service.addMedia(String(product.id), { mediaType: "image" }, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "product_media_source_required" });
      await expect(
        service.addMedia(
          String(product.id),
          { fileId: randomUUID(), mediaType: "image", mediaUrl: "https://cdn.example.test/a.jpg" },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "product_media_source_required" });
    });
  });

  it("rejects an unsafe media URL in the service AND in the database", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      for (const unsafe of ["javascript:alert(1)", "http://cdn.example.test/a.jpg", "https://127.0.0.1/a.jpg"]) {
        await expect(
          service.addMedia(
            String(product.id),
            { mediaType: "image", mediaUrl: unsafe },
            randomUUID(),
          ),
        ).rejects.toMatchObject({ errorCode: expect.stringContaining("product_media_url") });
      }
      // The CHECK is the floor: a service bug cannot get past it either.
      await expect(
        sql`insert into trader_storefront_product_media(
            company_id, storefront_id, product_id, media_type, media_url
          ) values(${fixture.companyId}::uuid, ${fixture.storefrontId}::uuid,
                   ${String(product.id)}::uuid, 'image', 'javascript:alert(1)')`.execute(
          transaction,
        ),
      ).rejects.toMatchObject({ constraint: "trader_storefront_product_media_url_check" });
    });
  });

  it("refuses to remove the last image from an active Product", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      const image = await addImage(service, String(product.id));
      await service.activate(
        String(product.id),
        { expectedVersion: Number(product.version) },
        randomUUID(),
      );
      await expect(
        service.removeMedia(String(image.id), randomUUID()),
      ).rejects.toMatchObject({ errorCode: "product_media_last_image" });
    });
  });

  // ------------------------------------------------- options and attributes

  it("keeps option groups and values under their Product", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "fashion");
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      const group = await service.addOptionGroup(
        String(product.id),
        { name: "Size" },
        randomUUID(),
      );
      await service.addOptionValue(String(group.id), { value: "M" }, randomUUID());
      await expect(
        service.addOptionValue(String(group.id), { value: "m" }, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "product_option_value_exists" });

      const neighbour = buildService(transaction, {
        actorId: fixture.otherActorId,
        companyId: fixture.otherCompanyId,
      });
      await expect(
        neighbour.addOptionValue(String(group.id), { value: "L" }, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "product_option_group_not_found" });
    });
  });

  it("rejects an attribute the Storefront's template does not declare", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "jewelry");
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      await expect(
        service.updateProduct(
          String(product.id),
          { expectedVersion: 1, templateAttributes: { storage: "256GB" } },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "product_template_attributes_invalid" });
      // The template's own attribute is accepted.
      const updated = await service.updateProduct(
        String(product.id),
        { expectedVersion: 1, templateAttributes: { material: "18k gold", purity: "750" } },
        randomUUID(),
      );
      expect(updated.templateAttributes).toMatchObject({ material: "18k gold" });
    });
  });

  it.each(["fashion", "electronics", "jewelry"] as const)(
    "enforces the %s template's required activation attribute",
    async (template) => {
      await inRolledBackTransaction(async (transaction) => {
        const fixture = await seed(transaction, template);
        const service = buildService(transaction, fixture);
        const { product } = await draftProduct(service, fixture);
        await addImage(service, String(product.id));
        await expect(
          service.activate(String(product.id), { expectedVersion: 1 }, randomUUID()),
        ).rejects.toMatchObject({ errorCode: "product_incomplete_for_activation" });
      });
    },
  );

  it("requires no extra attribute for the general template", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      await addImage(service, String(product.id));
      const activated = await service.activate(
        String(product.id),
        { expectedVersion: Number(product.version) },
        randomUUID(),
      );
      expect(activated.lifecycleStatus).toBe("active");
    });
  });

  // ------------------------------------------------------------- public

  it("exposes only active Products, and only safe fields", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const slug = `shop-a-${fixture.companyId.slice(0, 8)}`;
      const { product } = await draftProduct(service, fixture);
      await addImage(service, String(product.id));

      // Draft: private.
      expect((await service.publicProducts(slug, {})).items).toHaveLength(0);
      await expect(service.publicProduct(slug, "embroidered-abaya")).rejects.toMatchObject({
        errorCode: "product_not_found",
      });

      const active = await service.activate(
        String(product.id),
        { expectedVersion: Number(product.version) },
        randomUUID(),
      );
      const listed = await service.publicProducts(slug, {});
      expect(listed.items).toHaveLength(1);
      const detail = await service.publicProduct(slug, "embroidered-abaya");
      for (const forbidden of ["id", "companyId", "storefrontId", "traderId", "version", "createdBy"]) {
        expect(Object.keys(detail)).not.toContain(forbidden);
        expect(Object.keys(listed.items[0]!)).not.toContain(forbidden);
      }

      // Inactive: private again.
      await service.deactivate(
        String(product.id),
        { expectedVersion: Number(active.version) },
        randomUUID(),
      );
      expect((await service.publicProducts(slug, {})).items).toHaveLength(0);
    });
  });

  it("lists an unavailable Product and labels it rather than hiding it", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const slug = `shop-a-${fixture.companyId.slice(0, 8)}`;
      const { product } = await draftProduct(service, fixture);
      await addImage(service, String(product.id));
      const active = await service.activate(
        String(product.id),
        { expectedVersion: Number(product.version) },
        randomUUID(),
      );
      await service.setAvailability(
        String(product.id),
        { availabilityStatus: "unavailable", expectedVersion: Number(active.version) },
        randomUUID(),
      );
      const listed = await service.publicProducts(slug, {});
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]!.availabilityStatus).toBe("unavailable");
    });
  });

  it("exposes no Products for a Storefront that is not public", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const slug = `shop-a-${fixture.companyId.slice(0, 8)}`;
      const { product } = await draftProduct(service, fixture);
      await addImage(service, String(product.id));
      await service.activate(
        String(product.id),
        { expectedVersion: Number(product.version) },
        randomUUID(),
      );
      await sql`update trader_storefronts set status='suspended', suspended_at=now()
                 where id=${fixture.storefrontId}::uuid`.execute(transaction);
      // The shop is gone as far as the public is concerned, Products included.
      await expect(service.publicProducts(slug, {})).rejects.toMatchObject({
        errorCode: "storefront_not_found",
      });
    });
  });

  it("hides a Product whose category has been deactivated", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const slug = `shop-a-${fixture.companyId.slice(0, 8)}`;
      const { categoryId, product } = await draftProduct(service, fixture);
      await addImage(service, String(product.id));
      await service.activate(
        String(product.id),
        { expectedVersion: Number(product.version) },
        randomUUID(),
      );
      // Deactivating a category with active Products is refused outright, so a
      // live Product can never be orphaned behind a hidden category.
      const category = await sql<{ version: string }>`
        select version::text as version from trader_storefront_categories
         where id = ${categoryId}::uuid`.execute(transaction);
      await expect(
        service.setCategoryActive(
          categoryId,
          { expectedVersion: Number(category.rows[0]!.version), isActive: false },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "product_category_has_active_products" });
      expect((await service.publicProducts(slug, {})).items).toHaveLength(1);
    });
  });

  // -------------------------------------------------------- audit/rollback

  it("records audit events for Category and Product changes", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      await addImage(service, String(product.id));
      await service.activate(
        String(product.id),
        { expectedVersion: Number(product.version) },
        randomUUID(),
      );
      // Scoped to THIS test's actor. The unscoped form also returned rows
      // committed by other work in the same database -- development Storefront
      // records, for one -- so the tenancy assertion below failed on somebody
      // else's perfectly correct audit row. Selecting by actor keeps the
      // company_id check meaningful: the actor is what is known, the company
      // stamp is what is under test.
      const events = await sql<{ action: string; companyId: string }>`
        select action, company_id as "companyId" from audit_events
         where subject_type = 'trader_storefront_product'
           and actor_account_id = ${fixture.actorId}::uuid`.execute(transaction);
      const actions = events.rows.map((row) => row.action);
      expect(actions).toContain("storefront_product.category_created");
      expect(actions).toContain("storefront_product.created");
      expect(actions).toContain("storefront_product.media_added");
      expect(actions).toContain("storefront_product.active");
      for (const row of events.rows) expect(row.companyId).toBe(fixture.companyId);
    });
  });

  it("leaves no partial Product behind when a write fails", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const { categoryId } = await draftProduct(service, fixture);
      const before = await sql<{ count: number }>`
        select count(*)::int as count from trader_storefront_products
         where storefront_id = ${fixture.storefrontId}::uuid`.execute(transaction);
      await expect(
        service.createProduct(
          {
            categoryId,
            name: "Doomed",
            productCode: "ABAYA-0001",
            sellingPrice: "10.00",
            slug: "doomed",
            storefrontId: fixture.storefrontId,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "product_code_taken" });
      const after = await sql<{ count: number }>`
        select count(*)::int as count from trader_storefront_products
         where storefront_id = ${fixture.storefrontId}::uuid`.execute(transaction);
      expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
    });
  });

  it("refuses a caller without Product permissions", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const limited = buildService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        permissions: ["storefront_products.view"],
      });
      await expect(
        limited.createProduct(
          {
            name: "Denied",
            productCode: "D-1",
            sellingPrice: "10.00",
            slug: "denied",
            storefrontId: fixture.storefrontId,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "storefront_product_permission_denied" });
    });
  });

  /* ---------------------------------------------------------------------
     The administrator escalation, matching `StorefrontService`.

     Browser validation found a Company administrator locked out of the
     catalogue while holding every other module. These tests pin the grant and
     the boundary it must never cross.
     --------------------------------------------------------------------- */

  it("accepts users_roles.manage in place of a Product permission", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const administrator = buildService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        // No storefront_products.* permission at all.
        permissions: ["users_roles.manage"],
      });
      const { product } = await draftProduct(administrator, fixture);
      expect(product.slug).toBe("embroidered-abaya");

      // Reads, media and the publication authority all follow.
      const fetched = await administrator.getProduct(String(product.id));
      expect(fetched.media).toHaveLength(0);
      expect((await administrator.listProducts({ storefrontId: fixture.storefrontId })).total).toBe(
        1,
      );
      await addImage(administrator, String(product.id));
      const marked = await administrator.setAvailability(
        String(product.id),
        { availabilityStatus: "unavailable", expectedVersion: Number(product.version) },
        randomUUID(),
      );
      expect(marked.availabilityStatus).toBe("unavailable");
    });
  });

  it("still refuses a caller holding neither a Product permission nor users_roles.manage", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const outsider = buildService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        // Storefront profile permissions do NOT imply catalogue permissions.
        permissions: ["storefront.manage", "orders.view"],
      });
      await expect(
        outsider.createProduct(
          {
            name: "Refused",
            productCode: "R-1",
            sellingPrice: "10.00",
            slug: "refused",
            storefrontId: fixture.storefrontId,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "storefront_product_permission_denied" });
      await expect(
        outsider.listProducts({ storefrontId: fixture.storefrontId }),
      ).rejects.toMatchObject({ errorCode: "storefront_product_permission_denied" });
    });
  });

  it("never lets users_roles.manage reach another Company's catalogue", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const { product, categoryId } = await draftProduct(
        buildService(transaction, fixture),
        fixture,
      );
      const neighbourAdministrator = buildService(transaction, {
        actorId: fixture.otherActorId,
        companyId: fixture.otherCompanyId,
        permissions: ["users_roles.manage"],
      });
      await expect(neighbourAdministrator.getProduct(String(product.id))).rejects.toMatchObject({
        errorCode: "product_not_found",
      });
      await expect(
        neighbourAdministrator.updateProduct(
          String(product.id),
          { expectedVersion: Number(product.version), name: "Seized" },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "product_not_found" });
      // Nor may it plant a Product on the neighbour's Storefront.
      await expect(
        neighbourAdministrator.createProduct(
          {
            categoryId,
            name: "Planted",
            productCode: "P-1",
            sellingPrice: "10.00",
            slug: "planted",
            storefrontId: fixture.storefrontId,
          },
          randomUUID(),
        ),
      ).rejects.toMatchObject({ errorCode: "storefront_not_found" });
      // Listing does not merely return an empty page: the Storefront itself is
      // reported as not found, so the neighbour learns nothing about it.
      await expect(
        neighbourAdministrator.listProducts({ storefrontId: fixture.storefrontId }),
      ).rejects.toMatchObject({ errorCode: "storefront_not_found" });
    });
  });

  // ------------------------------------------------------ required options

  it("blocks activation while a required option group has no active value", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      await addImage(service, String(product.id));
      await service.addOptionGroup(
        String(product.id),
        { isRequired: true, name: "Size" },
        randomUUID(),
      );
      // A required group with nothing to choose from would make the Product
      // impossible to order the moment checkout enforces the choice.
      await expect(
        service.activate(String(product.id), { expectedVersion: 1 }, randomUUID()),
      ).rejects.toMatchObject({ errorCode: "product_incomplete_for_activation" });
    });
  });

  it("allows activation once the required group offers a value", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      await addImage(service, String(product.id));
      const group = await service.addOptionGroup(
        String(product.id),
        { isRequired: true, name: "Size" },
        randomUUID(),
      );
      await service.addOptionValue(String(group.id), { value: "M" }, randomUUID());
      const activated = await service.activate(
        String(product.id),
        { expectedVersion: 1 },
        randomUUID(),
      );
      expect(activated.lifecycleStatus).toBe("active");
    });
  });

  it("ignores an OPTIONAL empty group at activation", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      await addImage(service, String(product.id));
      await service.addOptionGroup(String(product.id), { name: "Gift note" }, randomUUID());
      // Optional groups may legitimately be left unpopulated.
      const activated = await service.activate(
        String(product.id),
        { expectedVersion: 1 },
        randomUUID(),
      );
      expect(activated.lifecycleStatus).toBe("active");
    });
  });

  it("defaults a new option group to optional", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      const group = await service.addOptionGroup(
        String(product.id),
        { name: "Colour" },
        randomUUID(),
      );
      // Existing groups predate the concept; requiring them by default would
      // block Products that are live today.
      expect(group.isRequired).toBe(false);
    });
  });

  it("marks a group required through the update endpoint", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      const group = await service.addOptionGroup(
        String(product.id),
        { name: "Colour" },
        randomUUID(),
      );
      const updated = await service.updateOptionGroup(
        String(group.id),
        { isRequired: true },
        randomUUID(),
      );
      expect(updated.isRequired).toBe(true);
    });
  });

  it("publishes the required flag and the saved order to the public page", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const slug = `shop-a-${fixture.companyId.slice(0, 8)}`;
      const { product } = await draftProduct(service, fixture);
      await addImage(service, String(product.id));
      const size = await service.addOptionGroup(
        String(product.id),
        { displayOrder: 1, isRequired: true, name: "Size" },
        randomUUID(),
      );
      await service.addOptionValue(String(size.id), { value: "M" }, randomUUID());
      const colour = await service.addOptionGroup(
        String(product.id),
        { displayOrder: 0, name: "Colour" },
        randomUUID(),
      );
      await service.addOptionValue(String(colour.id), { value: "Black" }, randomUUID());
      await service.activate(String(product.id), { expectedVersion: 1 }, randomUUID());

      const detail = await service.publicProduct(slug, "embroidered-abaya");
      const options = detail.options as { isRequired: boolean; name: string }[];
      // Saved display order decides the sequence, not insertion order.
      expect(options.map((group) => group.name)).toEqual(["Colour", "Size"]);
      expect(options.find((group) => group.name === "Size")!.isRequired).toBe(true);
      expect(options.find((group) => group.name === "Colour")!.isRequired).toBe(false);
    });
  });

  it("reorders option groups and values through the API", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction, "general");
      const service = buildService(transaction, fixture);
      const { product } = await draftProduct(service, fixture);
      const group = await service.addOptionGroup(String(product.id), { name: "Size" }, randomUUID());
      const small = await service.addOptionValue(String(group.id), { value: "S" }, randomUUID());
      const large = await service.addOptionValue(String(group.id), { value: "L" }, randomUUID());
      await service.reorderOptionValues(
        String(group.id),
        {
          entries: [
            { displayOrder: 0, id: String(large.id) },
            { displayOrder: 1, id: String(small.id) },
          ],
        },
        randomUUID(),
      );
      const detail = await service.getProduct(String(product.id));
      const values = (detail.options as { values: { value: string }[] }[])[0]!.values;
      expect(values.map((entry) => entry.value)).toEqual(["L", "S"]);
    });
  });
});
