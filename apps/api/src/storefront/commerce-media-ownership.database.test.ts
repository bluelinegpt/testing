import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import { FileOwnershipService } from "../files/file-ownership.service.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type {
  KyselyTransactionManager,
  TransactionWork,
} from "../infrastructure/database/transaction-manager.js";
import { OperationsHistoryWriter } from "../operations/operations-history.writer.js";
import type { IdentityContextAccessor, IdentityKind } from "../security/identity-context.js";
import type { TenantContextAccessor } from "../tenancy/tenant-context.js";

import { StorefrontProductService } from "./product.service.js";
import { StorefrontService } from "./storefront.service.js";

/**
 * Commerce media ownership (0B-2).
 *
 * Everything runs inside ONE transaction that is always rolled back.
 *
 * Two things are being proved here, and they pull in opposite directions.
 *
 * First, that a shop with NO Delivery Company can own its own pictures. Before
 * this migration `file_objects.company_id` was NOT NULL, so a Commerce file
 * could not exist without borrowing somebody's Company — the exact fake-owner
 * outcome the whole ownership phase exists to avoid.
 *
 * Second, that opening that door did not open a wider one. A file id in a
 * request body proves nothing about who owns the file, so every path that
 * accepts one is tested against a file belonging to a different Commerce
 * identity.
 */

const runDatabaseTests = process.env.RUN_COMMERCE_MEDIA_DATABASE === "true";

class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `cm_${++this.sequence}`;
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
  readonly otherCommerceId: string;
  readonly otherStorefrontId: string;
  readonly productId: string;
  readonly storefrontId: string;
  readonly traderId: string;
}

async function seed(transaction: Transaction<DatabaseSchema>): Promise<Fixture> {
  const ids = {
    actorId: randomUUID(),
    commerceId: randomUUID(),
    companyId: randomUUID(),
    otherCommerceId: randomUUID(),
    otherStorefrontId: randomUUID(),
    productId: randomUUID(),
    storefrontId: randomUUID(),
    traderId: randomUUID(),
  };
  const short = ids.companyId.slice(0, 8);
  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${ids.companyId}::uuid,${`CM-${short}`},${`cm-${short}`},'Media Test','active',now())`.execute(
    transaction,
  );
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${ids.actorId}::uuid,${ids.companyId}::uuid,'company_user',${`cm.${ids.actorId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into traders(id,company_id,code,name_en,mobile_number)
    values(${ids.traderId}::uuid,${ids.companyId}::uuid,${`T-${short}`},'Media Trader','971500000010')`.execute(
    transaction,
  );
  await sql`insert into trader_commerce_profiles(id,public_name,registration_source,approval_status) values
    (${ids.commerceId}::uuid,'Media Shop','delivery_company_registered','approved'),
    (${ids.otherCommerceId}::uuid,'Other Shop','trader_self_registered','approved')`.execute(
    transaction,
  );
  await sql`insert into trader_commerce_company_links(trader_commerce_id,company_id,trader_id,link_source)
    values(${ids.commerceId}::uuid,${ids.companyId}::uuid,${ids.traderId}::uuid,'migration_backfill')`.execute(
    transaction,
  );
  await sql`insert into trader_delivery_company_relationships(
      trader_commerce_id, company_id, trader_id, relationship_source, status,
      enabled_for_store_orders, is_default_for_store_orders)
    values(${ids.commerceId}::uuid,${ids.companyId}::uuid,${ids.traderId}::uuid,
      'delivery_company_registered','active',true,true)`.execute(transaction);
  await sql`insert into trader_storefronts(
      id, trader_commerce_id, company_id, trader_id, display_name, slug,
      business_template, theme, status, published_at)
    values(${ids.storefrontId}::uuid, ${ids.commerceId}::uuid, ${ids.companyId}::uuid,
      ${ids.traderId}::uuid, 'Media Shop', ${`media-${ids.storefrontId.slice(0, 12)}`},
      'fashion', 'modern', 'published', now())`.execute(transaction);
  // A second shop with NO Company at all — the cross-tenant counterparty.
  await sql`insert into trader_storefronts(
      id, trader_commerce_id, display_name, slug, business_template, theme)
    values(${ids.otherStorefrontId}::uuid, ${ids.otherCommerceId}::uuid, 'Other Shop',
      ${`other-${ids.otherStorefrontId.slice(0, 12)}`}, 'general', 'modern')`.execute(transaction);
  await sql`insert into trader_storefront_products(
      id, storefront_id, name, slug, product_code, selling_price)
    values(${ids.productId}::uuid, ${ids.storefrontId}::uuid, 'Media Product',
      'media-product', 'MED-1', 100)`.execute(transaction);
  return ids;
}

async function commerceFile(
  transaction: Transaction<DatabaseSchema>,
  traderCommerceId: string,
): Promise<string> {
  const ownership = new FileOwnershipService(transaction as unknown as Kysely<DatabaseSchema>);
  return ownership.createCommerceFile(transaction, traderCommerceId, {
    mediaType: "image/png",
    originalFilename: "image.png",
    scanStatus: "clean",
    sizeBytes: 1024,
    storageKey: `commerce/${traderCommerceId}/${randomUUID()}`,
    storageProvider: "local",
  });
}

function buildStorefrontService(
  transaction: Transaction<DatabaseSchema>,
  input: {
    readonly actorId: string;
    readonly companyId: string;
    readonly kind?: IdentityKind;
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

function contexts(input: {
  readonly actorId: string;
  readonly companyId: string;
  readonly kind?: IdentityKind;
  readonly traderProfileId?: string;
}): [TenantContextAccessor, IdentityContextAccessor] {
  const permissions = new Set([
    "storefront.view",
    "storefront.manage",
    "storefront.publish",
    "storefront_products.view",
    "storefront_products.manage",
  ]);
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
  const marker = new Error("rollback media test");
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
  const savepoint = `cmr_${randomUUID().replace(/-/g, "")}`;
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

// -------------------------------------------------------- ownership invariants

describe.skipIf(!runDatabaseTests)("file ownership invariants", () => {
  it("accepts a Company-owned file and a Commerce-owned file", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const ownership = new FileOwnershipService(transaction as unknown as Kysely<DatabaseSchema>);
      const companyFile = await ownership.createCompanyFile(transaction, fixture.companyId, {
        mediaType: "image/png",
        originalFilename: "company.png",
        sizeBytes: 10,
        storageKey: `logos/${fixture.companyId}/${randomUUID()}`,
        storageProvider: "local",
      });
      const shopFile = await commerceFile(transaction, fixture.commerceId);
      const rows = await sql<{
        companyId: string | null;
        id: string;
        ownerType: string;
        traderCommerceId: string | null;
      }>`
        select id, owner_type as "ownerType", company_id as "companyId",
               trader_commerce_id as "traderCommerceId"
          from file_objects where id in (${companyFile}::uuid, ${shopFile}::uuid)
         order by owner_type
      `.execute(transaction);
      expect(rows.rows).toStrictEqual([
        {
          companyId: fixture.companyId,
          id: companyFile,
          ownerType: "company",
          traderCommerceId: null,
        },
        {
          companyId: null,
          id: shopFile,
          ownerType: "trader_commerce",
          traderCommerceId: fixture.commerceId,
        },
      ]);
    });
  });

  it("rejects a file claiming both owners", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await rejects(transaction, () =>
        sql`insert into file_objects(owner_type, company_id, trader_commerce_id,
            storage_provider, storage_key, original_filename, media_type, size_bytes)
          values('company', ${fixture.companyId}::uuid, ${fixture.commerceId}::uuid,
            'local', ${`both/${randomUUID()}`}, 'x.png', 'image/png', 1)`.execute(transaction),
      );
    });
  });

  it("rejects a file with no owner at all", async () => {
    await inRolledBackTransaction(async (transaction) => {
      await seed(transaction);
      await rejects(transaction, () =>
        sql`insert into file_objects(owner_type, storage_provider, storage_key,
            original_filename, media_type, size_bytes)
          values('company', 'local', ${`none/${randomUUID()}`}, 'x.png', 'image/png', 1)`.execute(
          transaction,
        ),
      );
    });
  });

  it("rejects a Commerce owner_type carrying a Company", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await rejects(transaction, () =>
        sql`insert into file_objects(owner_type, company_id, storage_provider, storage_key,
            original_filename, media_type, size_bytes)
          values('trader_commerce', ${fixture.companyId}::uuid, 'local',
            ${`wrong/${randomUUID()}`}, 'x.png', 'image/png', 1)`.execute(transaction),
      );
    });
  });

  it("rejects an unknown owner type", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      await rejects(transaction, () =>
        sql`insert into file_objects(owner_type, company_id, storage_provider, storage_key,
            original_filename, media_type, size_bytes)
          values('customer', ${fixture.companyId}::uuid, 'local',
            ${`unknown/${randomUUID()}`}, 'x.png', 'image/png', 1)`.execute(transaction),
      );
    });
  });

  it("rejects a Commerce owner that does not exist", async () => {
    await inRolledBackTransaction(async (transaction) => {
      await seed(transaction);
      await rejects(transaction, () =>
        sql`insert into file_objects(owner_type, trader_commerce_id, storage_provider,
            storage_key, original_filename, media_type, size_bytes)
          values('trader_commerce', ${randomUUID()}::uuid, 'local',
            ${`ghost/${randomUUID()}`}, 'x.png', 'image/png', 1)`.execute(transaction),
      );
    });
  });

  it("keeps the legacy Company insert path working through the column default", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      // Exactly what the four operational services still write: no owner_type.
      const inserted = await sql<{ ownerType: string }>`
        insert into file_objects(company_id, storage_provider, storage_key,
          original_filename, media_type, size_bytes)
        values(${fixture.companyId}::uuid, 'local', ${`legacy/${randomUUID()}`},
          'x.png', 'image/png', 1)
        returning owner_type as "ownerType"
      `.execute(transaction);
      expect(inserted.rows[0]?.ownerType).toBe("company");
    });
  });
});

// ------------------------------------------------------------- zero Company

describe.skipIf(!runDatabaseTests)("zero Delivery Company Commerce media", () => {
  it("creates Store and Product media with no Company anywhere", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const commerceId = randomUUID();
      await sql`insert into trader_commerce_profiles(id,public_name,registration_source,approval_status)
        values(${commerceId}::uuid,'Solo Media Shop','trader_self_registered','approved')`.execute(
        transaction,
      );
      const storefrontId = randomUUID();
      await sql`insert into trader_storefronts(
          id, trader_commerce_id, display_name, slug, business_template, theme)
        values(${storefrontId}::uuid, ${commerceId}::uuid, 'Solo Media Shop',
          ${`solo-media-${storefrontId.slice(0, 12)}`}, 'general', 'modern')`.execute(transaction);
      const productId = randomUUID();
      await sql`insert into trader_storefront_products(
          id, storefront_id, name, slug, product_code, selling_price)
        values(${productId}::uuid, ${storefrontId}::uuid, 'Solo', 'solo', 'SOLO-1', 10)`.execute(
        transaction,
      );

      const logoId = await commerceFile(transaction, commerceId);
      const imageId = await commerceFile(transaction, commerceId);
      await sql`update trader_storefronts set logo_file_id = ${logoId}::uuid
        where id = ${storefrontId}::uuid`.execute(transaction);
      await sql`insert into trader_storefront_product_media(
          storefront_id, product_id, media_type, file_id, is_primary, is_active, display_order)
        values(${storefrontId}::uuid, ${productId}::uuid, 'image', ${imageId}::uuid, true, true, 0)`.execute(
        transaction,
      );

      const files = await sql<{
        companyId: string | null;
        ownerType: string;
        traderCommerceId: string;
      }>`
        select owner_type as "ownerType", company_id as "companyId",
               trader_commerce_id as "traderCommerceId"
          from file_objects where id in (${logoId}::uuid, ${imageId}::uuid)
      `.execute(transaction);
      expect(files.rows).toHaveLength(2);
      for (const row of files.rows) {
        expect(row).toStrictEqual({
          companyId: null,
          ownerType: "trader_commerce",
          traderCommerceId: commerceId,
        });
      }

      // And no Company or relationship was conjured to make it work.
      const invented = await sql<{ relationships: string; storeCompany: string | null }>`
        select (select count(*)::text from trader_delivery_company_relationships
                 where trader_commerce_id = ${commerceId}::uuid) as relationships,
               (select company_id::text from trader_storefronts
                 where id = ${storefrontId}::uuid) as "storeCompany"
      `.execute(transaction);
      expect(invented.rows[0]).toStrictEqual({ relationships: "0", storeCompany: null });
    });
  });
});

// ------------------------------------------- relationship independence

describe.skipIf(!runDatabaseTests)("Delivery relationships do not own media", () => {
  it("keeps media Commerce-owned for a shop that has a Delivery Company", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const fileId = await commerceFile(transaction, fixture.commerceId);
      const found = await sql<{ companyId: string | null; traderCommerceId: string }>`
        select company_id as "companyId", trader_commerce_id as "traderCommerceId"
          from file_objects where id = ${fileId}::uuid
      `.execute(transaction);
      // Owned by the shop, not by Dana.
      expect(found.rows[0]).toStrictEqual({
        companyId: null,
        traderCommerceId: fixture.commerceId,
      });
    });
  });

  it("does not touch media when the default Delivery Company changes", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const fileId = await commerceFile(transaction, fixture.commerceId);
      const before = await sql<{ storageKey: string; traderCommerceId: string }>`
        select storage_key as "storageKey", trader_commerce_id as "traderCommerceId"
          from file_objects where id = ${fileId}::uuid
      `.execute(transaction);

      const second = randomUUID();
      const shortId = second.slice(0, 8);
      await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
        values(${second}::uuid,${`CM2-${shortId}`},${`cm2-${shortId}`},'Second','active',now())`.execute(
        transaction,
      );
      await sql`update trader_delivery_company_relationships
        set is_default_for_store_orders = false
        where trader_commerce_id = ${fixture.commerceId}::uuid`.execute(transaction);
      await sql`insert into trader_delivery_company_relationships(
          trader_commerce_id, company_id, relationship_source, status,
          enabled_for_store_orders, is_default_for_store_orders)
        values(${fixture.commerceId}::uuid, ${second}::uuid, 'delivery_company_registered',
          'active', true, true)`.execute(transaction);

      const after = await sql<{ storageKey: string; traderCommerceId: string }>`
        select storage_key as "storageKey", trader_commerce_id as "traderCommerceId"
          from file_objects where id = ${fileId}::uuid
      `.execute(transaction);
      expect(after.rows[0]).toStrictEqual(before.rows[0]);
    });
  });

  it("keeps media when the last relationship is removed", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const fileId = await commerceFile(transaction, fixture.commerceId);
      await sql`delete from trader_delivery_company_relationships
        where trader_commerce_id = ${fixture.commerceId}::uuid`.execute(transaction);
      const found = await sql<{ id: string; traderCommerceId: string }>`
        select id, trader_commerce_id as "traderCommerceId"
          from file_objects where id = ${fileId}::uuid
      `.execute(transaction);
      expect(found.rows[0]).toStrictEqual({
        id: fileId,
        traderCommerceId: fixture.commerceId,
      });
    });
  });
});

// ------------------------------------------------------ cross-tenant denial

describe.skipIf(!runDatabaseTests)("Commerce media authorization", () => {
  it("refuses to attach another shop's file to a Product", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const foreignFile = await commerceFile(transaction, fixture.otherCommerceId);
      const products = buildProductService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
      });
      await expect(
        products.addMedia(
          fixture.productId,
          { fileId: foreignFile, mediaType: "image" },
          randomUUID(),
        ),
      ).rejects.toThrow();
    });
  });

  it("refuses to attach a Company-owned operational file to a Product", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const ownership = new FileOwnershipService(transaction as unknown as Kysely<DatabaseSchema>);
      const operational = await ownership.createCompanyFile(transaction, fixture.companyId, {
        mediaType: "image/png",
        originalFilename: "invoice.png",
        sizeBytes: 10,
        storageKey: `ops/${randomUUID()}`,
        storageProvider: "local",
      });
      const products = buildProductService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
      });
      // The actor legitimately belongs to this Company and the file is real —
      // it is simply not Commerce media, so it cannot become a Product image.
      await expect(
        products.addMedia(
          fixture.productId,
          { fileId: operational, mediaType: "image" },
          randomUUID(),
        ),
      ).rejects.toThrow();
    });
  });

  it("accepts the shop's own file", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const own = await commerceFile(transaction, fixture.commerceId);
      const products = buildProductService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
      });
      const added = await products.addMedia(
        fixture.productId,
        { fileId: own, mediaType: "image" },
        randomUUID(),
      );
      expect(added.mediaType).toBe("image");
    });
  });

  it("refuses another shop's file as a Store logo", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const foreignFile = await commerceFile(transaction, fixture.otherCommerceId);
      const storefronts = buildStorefrontService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
      });
      const current = await storefronts.detail(fixture.storefrontId);
      await expect(
        storefronts.update(
          fixture.storefrontId,
          { expectedVersion: current.version, logoFileId: foreignFile },
          randomUUID(),
        ),
      ).rejects.toThrow();
    });
  });

  it("accepts the shop's own file as a Store logo", async () => {
    await inRolledBackTransaction(async (transaction) => {
      const fixture = await seed(transaction);
      const own = await commerceFile(transaction, fixture.commerceId);
      const storefronts = buildStorefrontService(transaction, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
      });
      const current = await storefronts.detail(fixture.storefrontId);
      const updated = await storefronts.update(
        fixture.storefrontId,
        { expectedVersion: current.version, logoFileId: own },
        randomUUID(),
      );
      expect(updated.logoUrl).toBe(`/api/v1/public/commerce-media/${own}`);
    });
  });
});
