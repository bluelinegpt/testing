import { randomUUID } from "node:crypto";

import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { type Kysely, sql } from "kysely";

import type { AppConfiguration } from "../configuration/environment.js";
import {
  commerceStorageKey,
  extensionFor,
  sanitiseOriginalFilename,
  validateCommerceImage,
  type CommerceMediaPurpose,
} from "../files/commerce-media.constants.js";
import { FileOwnershipService } from "../files/file-ownership.service.js";
import { FileStoragePort } from "../files/file-storage.port.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";

import { accessibleStorefrontIds } from "./storefront-access.js";

export interface UploadedBytes {
  readonly buffer: Buffer;
  readonly mimetype?: string;
  readonly originalname?: string;
}

/**
 * Commerce media upload transport.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER OF OPERATIONS IS THE SECURITY MODEL
 * ---------------------------------------------------------------------------
 *
 *     authorise the Storefront  ->  read its trader_commerce_id
 *  ->  validate the bytes       ->  generate a server-side key
 *  ->  write the object         ->  create the file_object as trader_commerce
 *  ->  attach it to the resource
 *
 * Ownership is read from the Storefront the actor was already proven to reach.
 * The request never supplies `owner_type`, `company_id` or `trader_commerce_id`
 * — there is no parameter for any of them — so a caller cannot upload into
 * another shop's namespace by naming it.
 *
 * Bytes are validated BEFORE anything is written. A rejected upload leaves no
 * object on disk and no row in the database.
 *
 * ---------------------------------------------------------------------------
 * A REPLACED FILE IS RETIRED, NOT DELETED
 * ---------------------------------------------------------------------------
 *
 * Replacing a logo clears the reference and soft-deletes the old row
 * (`deleted_at`), matching what the Company logo flow already does. The bytes
 * are removed only once nothing references them. Hard-deleting a file the
 * instant its reference changes is how a shared object becomes a broken image
 * somewhere else in the system.
 */
@Injectable()
export class CommerceMediaService {
  private readonly storageProvider: string;

  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(FileOwnershipService) private readonly ownership: FileOwnershipService,
    @Inject(FileStoragePort) private readonly storage: FileStoragePort,
    @Inject(ConfigService) config: ConfigService<AppConfiguration, true>,
  ) {
    this.storageProvider = config.get("files.provider", { infer: true });
  }

  /** Store logo or cover. Returns the new file id. */
  public async uploadStoreBranding(
    storefrontId: string,
    purpose: "cover" | "logo",
    file: UploadedBytes,
  ): Promise<{ fileId: string }> {
    this.assertManage();
    const scope = await this.authorisedStorefront(storefrontId);
    const stored = await this.storeBytes(file, purpose, {
      storefrontId: scope.id,
      traderCommerceId: scope.traderCommerceId,
    });

    return this.transactions.execute(async (transaction) => {
      const column = purpose === "logo" ? sql`logo_file_id` : sql`cover_file_id`;
      const previous = await sql<{ fileId: string | null }>`
        select ${purpose === "logo" ? sql`logo_file_id` : sql`cover_file_id`} as "fileId"
          from trader_storefronts where id = ${scope.id}::uuid for update
      `.execute(transaction);
      const fileId = await this.ownership.createCommerceFile(
        transaction,
        scope.traderCommerceId,
        stored.record,
      );
      await sql`
        update trader_storefronts set ${column} = ${fileId}::uuid, updated_at = now()
         where id = ${scope.id}::uuid
      `.execute(transaction);
      await this.retire(transaction, previous.rows[0]?.fileId ?? null);
      return { fileId };
    });
  }

  public async removeStoreBranding(
    storefrontId: string,
    purpose: "cover" | "logo",
  ): Promise<void> {
    this.assertManage();
    const scope = await this.authorisedStorefront(storefrontId);
    await this.transactions.execute(async (transaction) => {
      const column = purpose === "logo" ? sql`logo_file_id` : sql`cover_file_id`;
      const previous = await sql<{ fileId: string | null }>`
        select ${purpose === "logo" ? sql`logo_file_id` : sql`cover_file_id`} as "fileId"
          from trader_storefronts where id = ${scope.id}::uuid for update
      `.execute(transaction);
      await sql`
        update trader_storefronts set ${column} = null, updated_at = now()
         where id = ${scope.id}::uuid
      `.execute(transaction);
      await this.retire(transaction, previous.rows[0]?.fileId ?? null);
    });
  }

  /**
   * A Product image.
   *
   * Only the FILE is created here. Attaching it to the Product — the eight-image
   * cap, the primary-image rule, the display order — stays in
   * `StorefrontProductService.addMedia`, which already owns those invariants and
   * enforces them under a row lock. Duplicating that logic here is how the two
   * copies eventually disagree.
   */
  public async uploadProductImage(
    productId: string,
    file: UploadedBytes,
  ): Promise<{ fileId: string }> {
    this.assertManage();
    const product = await sql<{ storefrontId: string }>`
      select storefront_id as "storefrontId" from trader_storefront_products
       where id = ${productId}::uuid
         and storefront_id in (${this.accessibleStorefronts()})
    `.execute(this.database);
    const row = product.rows[0];
    if (row === undefined) throw this.notFound("product_not_found", "Product not found");

    const scope = await this.authorisedStorefront(row.storefrontId);
    const stored = await this.storeBytes(file, "product_image", {
      productId,
      storefrontId: scope.id,
      traderCommerceId: scope.traderCommerceId,
    });
    const fileId = await this.ownership.createCommerceFile(
      this.database,
      scope.traderCommerceId,
      stored.record,
    );
    return { fileId };
  }

  /** Bytes for a Commerce file, for the public media route. */
  public async readPublic(fileId: string): Promise<{
    bytes: Uint8Array;
    mediaType: string;
  }> {
    const found = await sql<{ mediaType: string; scanStatus: string; storageKey: string }>`
      select storage_key as "storageKey", media_type as "mediaType",
             scan_status as "scanStatus"
        from file_objects
       where id = ${fileId}::uuid
         and owner_type = 'trader_commerce'
         and deleted_at is null
    `.execute(this.database);
    const row = found.rows[0];
    if (row === undefined) throw this.notFound("file_not_found", "File not found");
    // Only files the established status rules allow may be served publicly. A
    // pending or rejected file is treated as absent rather than as an error, so
    // the response does not reveal that it exists and is quarantined.
    if (row.scanStatus !== "clean") throw this.notFound("file_not_found", "File not found");
    return { bytes: await this.storage.readCommerce(row.storageKey), mediaType: row.mediaType };
  }

  // ------------------------------------------------------------- internals

  private async storeBytes(
    file: UploadedBytes,
    purpose: CommerceMediaPurpose,
    target: {
      readonly categoryId?: string;
      readonly productId?: string;
      readonly storefrontId: string;
      readonly traderCommerceId: string;
    },
  ) {
    const bytes = file.buffer ?? Buffer.alloc(0);
    const validation = validateCommerceImage(bytes, purpose, file.mimetype);
    if (!validation.ok) {
      throw new ApplicationException(
        "commerce_media_invalid",
        `The uploaded file was rejected (${validation.reason})`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const storageKey = commerceStorageKey({
      ...(target.categoryId === undefined ? {} : { categoryId: target.categoryId }),
      extension: extensionFor(validation.type),
      ...(target.productId === undefined ? {} : { productId: target.productId }),
      purpose,
      storefrontId: target.storefrontId,
      traderCommerceId: target.traderCommerceId,
      unique: randomUUID(),
    });
    await this.storage.storeCommerce(storageKey, bytes);
    return {
      record: {
        // 'clean' matches what the Company logo flow records for a
        // signature-validated image. No antivirus runs here; the status
        // reflects the validation that actually happened, not a scan that did
        // not.
        classification: "private" as const,
        mediaType: validation.mediaType,
        originalFilename: sanitiseOriginalFilename(file.originalname),
        scanStatus: "clean" as const,
        sizeBytes: bytes.length,
        storageKey,
        storageProvider: this.storageProvider,
        uploadedByAccountId: this.tenants.current().identityId,
      },
    };
  }

  /** Soft-delete a file that nothing references any more. */
  private async retire(
    transaction: Kysely<DatabaseSchema>,
    fileId: string | null,
  ): Promise<void> {
    if (fileId === null) return;
    const referenced = await sql<{ total: string }>`
      select (
        (select count(*) from trader_storefronts
          where logo_file_id = ${fileId}::uuid or cover_file_id = ${fileId}::uuid)
        + (select count(*) from trader_storefront_categories where image_file_id = ${fileId}::uuid)
        + (select count(*) from trader_storefront_product_media
            where file_id = ${fileId}::uuid or poster_file_id = ${fileId}::uuid)
      )::text as total
    `.execute(transaction);
    if (referenced.rows[0]?.total !== "0") return;
    await sql`
      update file_objects set deleted_at = now() where id = ${fileId}::uuid
    `.execute(transaction);
  }

  private async authorisedStorefront(storefrontId: string) {
    const found = await sql<{ id: string; traderCommerceId: string }>`
      select id, trader_commerce_id as "traderCommerceId" from trader_storefronts
       where id = ${storefrontId}::uuid
         and id in (${this.accessibleStorefronts()})
    `.execute(this.database);
    const row = found.rows[0];
    if (row === undefined) throw this.notFound("storefront_not_found", "Storefront not found");
    return row;
  }

  private accessibleStorefronts() {
    return accessibleStorefrontIds({
      callerTraderId: this.callerTraderId(),
      companyId: this.tenants.current().companyId,
    });
  }

  private callerTraderId(): string | null {
    const identity = this.identities.current();
    if (identity.kind !== "trader") return null;
    return identity.profileId ?? identity.profileLinkId ?? null;
  }

  private assertManage(): void {
    if (this.callerTraderId() !== null) return;
    const held = this.identities.current().permissions;
    if (held.has("storefront.manage") || held.has("storefront_products.manage")) return;
    if (held.has("users_roles.manage")) return;
    throw new ApplicationException(
      "storefront_permission_denied",
      "This account cannot perform that Storefront operation",
      HttpStatus.FORBIDDEN,
    );
  }

  private notFound(code: string, message: string): ApplicationException {
    return new ApplicationException(code, message, HttpStatus.NOT_FOUND);
  }
}
