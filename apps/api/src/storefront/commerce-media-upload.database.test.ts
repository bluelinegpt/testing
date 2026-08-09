import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";

import { configuration } from "../configuration/environment.js";
import {
  commerceStorageKey,
  sanitiseOriginalFilename,
  validateCommerceImage,
} from "../files/commerce-media.constants.js";
import { FileOwnershipService } from "../files/file-ownership.service.js";
import type { FileStoragePort, StoredFileReference } from "../files/file-storage.port.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type {
  KyselyTransactionManager,
  TransactionWork,
} from "../infrastructure/database/transaction-manager.js";
import type { IdentityContextAccessor, IdentityKind } from "../security/identity-context.js";
import type { TenantContextAccessor } from "../tenancy/tenant-context.js";

import { CommerceMediaService } from "./commerce-media.service.js";

/**
 * Commerce media upload transport.
 *
 * The headline case is the zero-Delivery-Company one. Before the ownership
 * phase a Store could not own a file at all without borrowing a Company, so
 * "upload a logo" and "invent a fake owner" were the same operation. These
 * tests assert the opposite: bytes land, a `file_object` is created as
 * `trader_commerce` with `company_id` NULL, and no Company or relationship row
 * comes into existence to make it work.
 *
 * Bytes are written to a real temporary directory rather than a stub, because
 * the parts most likely to be wrong — the storage key, the refusal to escape
 * the Commerce namespace, the `wx` no-overwrite flag — only exist at the
 * filesystem boundary.
 */

const runDatabaseTests = process.env.RUN_COMMERCE_UPLOAD_DATABASE === "true";

/** Smallest valid PNG signature plus filler; enough for signature validation. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 3)]);
const NOT_AN_IMAGE = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>");

class SavepointTransactionManager {
  private sequence = 0;
  public constructor(private readonly transaction: Transaction<DatabaseSchema>) {}
  public async execute<T>(work: TransactionWork<T>): Promise<T> {
    const savepoint = `up_${++this.sequence}`;
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

/** A real on-disk adapter rooted in a temp directory, cleaned up per test. */
class TempStorage implements FileStoragePort {
  public constructor(private readonly root: string) {}
  public async storeCommerce(storageKey: string, content: Uint8Array) {
    if (!storageKey.startsWith("commerce/")) throw new Error("non-Commerce key");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const absolute = join(this.root, storageKey);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, Buffer.from(content), { flag: "wx" });
    return { storageKey } satisfies StoredFileReference;
  }
  public async readCommerce(storageKey: string): Promise<Uint8Array> {
    if (!storageKey.startsWith("commerce/")) throw new Error("non-Commerce key");
    return readFile(join(this.root, storageKey));
  }
  public async deleteCommerce(storageKey: string): Promise<void> {
    await rm(join(this.root, storageKey), { force: true });
  }
  public storePrivate(): never {
    throw new Error("not used");
  }
  public readPrivate(): never {
    throw new Error("not used");
  }
  public deletePrivate(): never {
    throw new Error("not used");
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

/**
 * A shop with NO Delivery Company relationship and NO Company columns.
 *
 * The Trader identity link is kept because that is how a Trader actor is
 * resolved; the delivery relationship — the thing that would make this a
 * Company's shop — is deliberately absent.
 */
async function seedZeroCompany(transaction: Transaction<DatabaseSchema>): Promise<Fixture> {
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
    values(${ids.companyId}::uuid,${`UP-${short}`},${`up-${short}`},'Upload Test','active',now())`.execute(
    transaction,
  );
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash)
    values(${ids.actorId}::uuid,${ids.companyId}::uuid,'company_user',${`up.${ids.actorId}`},'x')`.execute(
    transaction,
  );
  await sql`insert into traders(id,company_id,code,name_en,mobile_number)
    values(${ids.traderId}::uuid,${ids.companyId}::uuid,${`T-${short}`},'Upload Trader','971500000010')`.execute(
    transaction,
  );
  await sql`insert into trader_commerce_profiles(id,public_name,registration_source,approval_status) values
    (${ids.commerceId}::uuid,'Upload Shop','trader_self_registered','approved'),
    (${ids.otherCommerceId}::uuid,'Other Shop','trader_self_registered','approved')`.execute(
    transaction,
  );
  await sql`insert into trader_commerce_company_links(trader_commerce_id,company_id,trader_id,link_source)
    values(${ids.commerceId}::uuid,${ids.companyId}::uuid,${ids.traderId}::uuid,'migration_backfill')`.execute(
    transaction,
  );
  await sql`insert into trader_storefronts(
      id, trader_commerce_id, display_name, slug, business_template, theme, status, published_at)
    values(${ids.storefrontId}::uuid, ${ids.commerceId}::uuid, 'Upload Shop',
      ${`upload-${ids.storefrontId.slice(0, 12)}`}, 'fashion', 'modern', 'published', now())`.execute(
    transaction,
  );
  await sql`insert into trader_storefronts(
      id, trader_commerce_id, display_name, slug, business_template, theme)
    values(${ids.otherStorefrontId}::uuid, ${ids.otherCommerceId}::uuid, 'Other Shop',
      ${`otherup-${ids.otherStorefrontId.slice(0, 12)}`}, 'general', 'modern')`.execute(transaction);
  await sql`insert into trader_storefront_products(
      id, storefront_id, name, slug, product_code, selling_price)
    values(${ids.productId}::uuid, ${ids.storefrontId}::uuid, 'Upload Product',
      'upload-product', 'UP-1', 100)`.execute(transaction);
  return ids;
}

function buildService(
  transaction: Transaction<DatabaseSchema>,
  storage: FileStoragePort,
  input: {
    readonly actorId: string;
    readonly companyId: string;
    readonly kind?: IdentityKind;
    readonly traderProfileId?: string;
  },
): CommerceMediaService {
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
  return new CommerceMediaService(
    transaction as unknown as Kysely<DatabaseSchema>,
    new SavepointTransactionManager(transaction) as unknown as KyselyTransactionManager,
    tenants,
    identities,
    new FileOwnershipService(transaction as unknown as Kysely<DatabaseSchema>),
    storage,
  );
}

async function inRolledBackTransaction(
  work: (transaction: Transaction<DatabaseSchema>, storage: TempStorage) => Promise<void>,
): Promise<void> {
  loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
  const root = await mkdtemp(join(tmpdir(), "blueline-commerce-"));
  const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
  const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
  const marker = new Error("rollback upload test");
  try {
    await expect(
      database.transaction().execute(async (transaction) => {
        await work(transaction, new TempStorage(root));
        throw marker;
      }),
    ).rejects.toBe(marker);
  } finally {
    await database.destroy();
    await rm(root, { force: true, recursive: true });
  }
}

// ------------------------------------------------------------ pure validation

describe("Commerce media validation", () => {
  it("accepts PNG, JPEG and WebP by signature", () => {
    expect(validateCommerceImage(PNG, "logo").ok).toBe(true);
    expect(validateCommerceImage(JPEG, "logo").ok).toBe(true);
    const webp = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.alloc(4, 1),
      Buffer.from("WEBP"),
      Buffer.alloc(32, 0),
    ]);
    expect(validateCommerceImage(webp, "logo").ok).toBe(true);
  });

  it("rejects SVG and anything else carrying markup or script", () => {
    const result = validateCommerceImage(NOT_AN_IMAGE, "logo");
    expect(result).toStrictEqual({ ok: false, reason: "markup_or_script_rejected" });
  });

  it("rejects a file whose declared type disagrees with its bytes", () => {
    // A JPEG announced as PNG is refused rather than silently corrected, so the
    // stored media type always matches the content a browser will receive.
    expect(validateCommerceImage(JPEG, "logo", "image/png")).toStrictEqual({
      ok: false,
      reason: "declared_media_type_mismatch",
    });
  });

  it("applies the stricter branding ceiling and the looser Product one", () => {
    const big = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024, 1)]);
    expect(validateCommerceImage(big, "logo")).toStrictEqual({
      ok: false,
      reason: "file_too_large",
    });
    expect(validateCommerceImage(big, "product_image").ok).toBe(true);
  });

  it("rejects an empty upload", () => {
    expect(validateCommerceImage(Buffer.alloc(0), "logo")).toStrictEqual({
      ok: false,
      reason: "empty_file",
    });
  });

  it("never lets a client filename reach a path", () => {
    expect(sanitiseOriginalFilename("../../../etc/passwd")).toBe("passwd");
    expect(sanitiseOriginalFilename("C:\\Windows\\system32\\evil.exe")).toBe("evil.exe");
    expect(sanitiseOriginalFilename("CON.png")).toBe("upload");
    expect(sanitiseOriginalFilename("..")).toBe("upload");
    expect(sanitiseOriginalFilename(undefined)).toBe("upload");
  });

  it("builds keys only from server-known identifiers", () => {
    const key = commerceStorageKey({
      extension: "png",
      productId: "prod-1",
      purpose: "product_image",
      storefrontId: "store-1",
      traderCommerceId: "commerce-1",
      unique: "uuid-1",
    });
    expect(key).toBe("commerce/commerce-1/stores/store-1/products/prod-1/images/uuid-1.png");
    expect(
      commerceStorageKey({
        extension: "jpg",
        purpose: "logo",
        storefrontId: "store-1",
        traderCommerceId: "commerce-1",
        unique: "uuid-2",
      }),
    ).toBe("commerce/commerce-1/stores/store-1/branding/logo/uuid-2.jpg");
  });
});

// --------------------------------------------------------- zero-Company upload

describe.skipIf(!runDatabaseTests)("Zero-Delivery-Company Commerce upload", () => {
  it("uploads a Store logo owned by Trader Commerce with no Company anywhere", async () => {
    await inRolledBackTransaction(async (transaction, storage) => {
      const fixture = await seedZeroCompany(transaction);
      const service = buildService(transaction, storage, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        traderProfileId: fixture.traderId,
      });

      const { fileId } = await service.uploadStoreBranding(fixture.storefrontId, "logo", {
        buffer: PNG,
        mimetype: "image/png",
        originalname: "../../logo.png",
      });

      const file = await sql<{
        companyId: string | null;
        mediaType: string;
        originalFilename: string;
        ownerType: string;
        storageKey: string;
        traderCommerceId: string;
      }>`
        select owner_type as "ownerType", company_id as "companyId",
               trader_commerce_id as "traderCommerceId", storage_key as "storageKey",
               media_type as "mediaType", original_filename as "originalFilename"
          from file_objects where id = ${fileId}::uuid
      `.execute(transaction);
      expect(file.rows[0]).toStrictEqual({
        companyId: null,
        mediaType: "image/png",
        // The traversal prefix was stripped before storage.
        originalFilename: "logo.png",
        ownerType: "trader_commerce",
        storageKey: expect.stringContaining(
          `commerce/${fixture.commerceId}/stores/${fixture.storefrontId}/branding/logo/`,
        ) as unknown as string,
        traderCommerceId: fixture.commerceId,
      });

      // The Storefront now points at it, and the bytes are really on disk.
      const store = await sql<{ logoFileId: string }>`
        select logo_file_id as "logoFileId" from trader_storefronts
         where id = ${fixture.storefrontId}::uuid
      `.execute(transaction);
      expect(store.rows[0]?.logoFileId).toBe(fileId);
      expect(Buffer.from(await service.readPublic(fileId).then((r) => r.bytes))).toStrictEqual(PNG);

      // And nothing was invented to make it possible.
      const invented = await sql<{ companyCols: string; relationships: string }>`
        select (select count(*)::text from trader_delivery_company_relationships
                 where trader_commerce_id = ${fixture.commerceId}::uuid) as relationships,
               (select count(*)::text from trader_storefronts
                 where id = ${fixture.storefrontId}::uuid and company_id is not null) as "companyCols"
      `.execute(transaction);
      expect(invented.rows[0]).toStrictEqual({ companyCols: "0", relationships: "0" });
    });
  });

  it("uploads a Product image owned by Trader Commerce", async () => {
    await inRolledBackTransaction(async (transaction, storage) => {
      const fixture = await seedZeroCompany(transaction);
      const service = buildService(transaction, storage, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        traderProfileId: fixture.traderId,
      });
      const { fileId } = await service.uploadProductImage(fixture.productId, {
        buffer: JPEG,
        mimetype: "image/jpeg",
        originalname: "photo.jpg",
      });
      const file = await sql<{
        companyId: string | null;
        ownerType: string;
        storageKey: string;
      }>`
        select owner_type as "ownerType", company_id as "companyId",
               storage_key as "storageKey"
          from file_objects where id = ${fileId}::uuid
      `.execute(transaction);
      expect(file.rows[0]?.ownerType).toBe("trader_commerce");
      expect(file.rows[0]?.companyId).toBeNull();
      expect(file.rows[0]?.storageKey).toContain(
        `/stores/${fixture.storefrontId}/products/${fixture.productId}/images/`,
      );
    });
  });

  it("replaces a logo and retires the previous file", async () => {
    await inRolledBackTransaction(async (transaction, storage) => {
      const fixture = await seedZeroCompany(transaction);
      const service = buildService(transaction, storage, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        traderProfileId: fixture.traderId,
      });
      const first = await service.uploadStoreBranding(fixture.storefrontId, "logo", {
        buffer: PNG,
        mimetype: "image/png",
      });
      const second = await service.uploadStoreBranding(fixture.storefrontId, "logo", {
        buffer: JPEG,
        mimetype: "image/jpeg",
      });
      expect(second.fileId).not.toBe(first.fileId);

      const rows = await sql<{ id: string; deletedAt: Date | null }>`
        select id, deleted_at as "deletedAt" from file_objects
         where id in (${first.fileId}::uuid, ${second.fileId}::uuid)
      `.execute(transaction);
      const previous = rows.rows.find((row) => row.id === first.fileId);
      const current = rows.rows.find((row) => row.id === second.fileId);
      // Retired, not hard-deleted; the new one is live.
      expect(previous?.deletedAt).not.toBeNull();
      expect(current?.deletedAt).toBeNull();
      // A retired file is no longer publicly readable.
      await expect(service.readPublic(first.fileId)).rejects.toThrow();
    });
  });

  it("removes a logo and clears the reference", async () => {
    await inRolledBackTransaction(async (transaction, storage) => {
      const fixture = await seedZeroCompany(transaction);
      const service = buildService(transaction, storage, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        traderProfileId: fixture.traderId,
      });
      const { fileId } = await service.uploadStoreBranding(fixture.storefrontId, "logo", {
        buffer: PNG,
        mimetype: "image/png",
      });
      await service.removeStoreBranding(fixture.storefrontId, "logo");
      const store = await sql<{ logoFileId: string | null }>`
        select logo_file_id as "logoFileId" from trader_storefronts
         where id = ${fixture.storefrontId}::uuid
      `.execute(transaction);
      expect(store.rows[0]?.logoFileId).toBeNull();
      await expect(service.readPublic(fileId)).rejects.toThrow();
    });
  });
});

// ----------------------------------------------------------------- rejections

describe.skipIf(!runDatabaseTests)("Commerce upload authorization", () => {
  it("writes nothing when the bytes are rejected", async () => {
    await inRolledBackTransaction(async (transaction, storage) => {
      const fixture = await seedZeroCompany(transaction);
      const service = buildService(transaction, storage, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        traderProfileId: fixture.traderId,
      });
      const before = await sql<{ total: string }>`
        select count(*)::text as total from file_objects
      `.execute(transaction);
      await expect(
        service.uploadStoreBranding(fixture.storefrontId, "logo", {
          buffer: NOT_AN_IMAGE,
          mimetype: "image/svg+xml",
        }),
      ).rejects.toThrow();
      const after = await sql<{ total: string }>`
        select count(*)::text as total from file_objects
      `.execute(transaction);
      // Validation happens before any write: no orphan row, no orphan object.
      expect(after.rows[0]?.total).toBe(before.rows[0]?.total);
    });
  });

  it("refuses to upload into another shop's Storefront", async () => {
    await inRolledBackTransaction(async (transaction, storage) => {
      const fixture = await seedZeroCompany(transaction);
      const service = buildService(transaction, storage, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        traderProfileId: fixture.traderId,
      });
      await expect(
        service.uploadStoreBranding(fixture.otherStorefrontId, "logo", {
          buffer: PNG,
          mimetype: "image/png",
        }),
      ).rejects.toThrow();
    });
  });

  it("refuses an unrelated Company user with every Store permission", async () => {
    await inRolledBackTransaction(async (transaction, storage) => {
      const fixture = await seedZeroCompany(transaction);
      // A Company user, not a Trader — and this shop has no relationship with
      // any Company, so there is nothing for the permission to apply to.
      const service = buildService(transaction, storage, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        kind: "company_user",
      });
      await expect(
        service.uploadStoreBranding(fixture.storefrontId, "logo", {
          buffer: PNG,
          mimetype: "image/png",
        }),
      ).rejects.toThrow();
    });
  });

  it("never serves a Company-owned operational file through the public media route", async () => {
    await inRolledBackTransaction(async (transaction, storage) => {
      const fixture = await seedZeroCompany(transaction);
      const ownership = new FileOwnershipService(transaction as unknown as Kysely<DatabaseSchema>);
      const operational = await ownership.createCompanyFile(transaction, fixture.companyId, {
        mediaType: "image/png",
        originalFilename: "invoice.png",
        scanStatus: "clean",
        sizeBytes: 10,
        storageKey: `logos/${fixture.companyId}/${randomUUID()}`,
        storageProvider: "local",
      });
      const service = buildService(transaction, storage, {
        actorId: fixture.actorId,
        companyId: fixture.companyId,
        traderProfileId: fixture.traderId,
      });
      // Correct id, real file, and still refused: the route serves Commerce
      // media only.
      await expect(service.readPublic(operational)).rejects.toThrow();
    });
  });
});
