import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { type Kysely, type Transaction, sql } from "kysely";

import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";

type Executor = Kysely<DatabaseSchema> | Transaction<DatabaseSchema>;

export interface FileCreationInput {
  readonly classification?: "private" | "sensitive_identity" | "generated_document";
  readonly mediaType: string;
  readonly originalFilename: string;
  readonly scanStatus?: "pending" | "clean" | "rejected" | "failed";
  readonly sha256?: string | null;
  readonly sizeBytes: number;
  readonly storageKey: string;
  readonly storageProvider: string;
  readonly uploadedByAccountId?: string | null;
}

/**
 * The only sanctioned way to create a `file_object`, and the only place that
 * decides who owns one.
 *
 * ---------------------------------------------------------------------------
 * OWNERSHIP IS DERIVED, NEVER SUBMITTED
 * ---------------------------------------------------------------------------
 *
 * There is deliberately no `create(ownerType, companyId, traderCommerceId)`.
 * Two named entry points exist instead — `createCompanyFile` and
 * `createCommerceFile` — because the caller should not be choosing between them
 * at runtime from a value that arrived in a request body. An operational
 * attachment path knows it is Company-owned; a Store or Product media path
 * knows it is Commerce-owned and resolves WHICH Commerce identity from the
 * Storefront it already authorised. Neither ever reads an owner from the
 * client.
 *
 * The database enforces the same invariant independently
 * (`file_objects_owner_shape_check`), so a future caller that bypasses this
 * service still cannot write an ambiguously-owned row. This class exists to
 * make the correct thing convenient, not to be the only line of defence.
 *
 * ---------------------------------------------------------------------------
 * WHY assertCommerceFileOwned EXISTS
 * ---------------------------------------------------------------------------
 *
 * Store logo, Store cover, Category image and Product media all accept a
 * `fileId` in their request bodies. A foreign key proves such an id refers to
 * SOME file; it says nothing about whose. Before this service, attaching
 * another tenant's file to your own Product would have inserted cleanly.
 *
 * Every one of those paths now runs the supplied id through
 * `assertCommerceFileOwned`, which answers a single question: does this file
 * belong to the Commerce identity that owns the Store being edited? A file that
 * fails is reported as not-found rather than forbidden, because a 403 confirms
 * the file exists.
 */
@Injectable()
export class FileOwnershipService {
  public constructor(@Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>) {}

  /** A file owned by a Delivery Company — operational attachments, branding. */
  public async createCompanyFile(
    executor: Executor,
    companyId: string,
    input: FileCreationInput,
  ): Promise<string> {
    const inserted = await sql<{ id: string }>`
      insert into file_objects (
        owner_type, company_id, trader_commerce_id,
        storage_provider, storage_key, original_filename, media_type, size_bytes,
        sha256, classification, scan_status, uploaded_by_account_id
      ) values (
        'company', ${companyId}::uuid, null,
        ${input.storageProvider}, ${input.storageKey}, ${input.originalFilename},
        ${input.mediaType}, ${input.sizeBytes}, ${input.sha256 ?? null},
        ${input.classification ?? "private"}, ${input.scanStatus ?? "pending"},
        ${input.uploadedByAccountId ?? null}::uuid
      )
      returning id
    `.execute(executor);
    const row = inserted.rows[0];
    if (row === undefined) throw new Error("Company file insert returned no row");
    return row.id;
  }

  /**
   * A file owned by a Trader Commerce identity — Store and Product media.
   *
   * `company_id` is explicitly NULL. That is the whole point of 0B-2: a shop
   * with no Delivery Company must be able to own its own pictures, and a shop
   * that has three must not have its pictures owned by whichever one happens to
   * be default this week.
   */
  public async createCommerceFile(
    executor: Executor,
    traderCommerceId: string,
    input: FileCreationInput,
  ): Promise<string> {
    const inserted = await sql<{ id: string }>`
      insert into file_objects (
        owner_type, company_id, trader_commerce_id,
        storage_provider, storage_key, original_filename, media_type, size_bytes,
        sha256, classification, scan_status, uploaded_by_account_id
      ) values (
        'trader_commerce', null, ${traderCommerceId}::uuid,
        ${input.storageProvider}, ${input.storageKey}, ${input.originalFilename},
        ${input.mediaType}, ${input.sizeBytes}, ${input.sha256 ?? null},
        ${input.classification ?? "private"}, ${input.scanStatus ?? "pending"},
        ${input.uploadedByAccountId ?? null}::uuid
      )
      returning id
    `.execute(executor);
    const row = inserted.rows[0];
    if (row === undefined) throw new Error("Commerce file insert returned no row");
    return row.id;
  }

  /**
   * Rejects a file id that does not belong to this Commerce identity.
   *
   * Null and undefined pass through untouched so callers can hand over an
   * optional field directly — "no file" is not an ownership violation.
   */
  public async assertCommerceFileOwned(
    executor: Executor,
    traderCommerceId: string,
    fileId: string | null | undefined,
  ): Promise<void> {
    if (fileId === null || fileId === undefined) return;
    const found = await sql<{ id: string }>`
      select id from file_objects
       where id = ${fileId}::uuid
         and owner_type = 'trader_commerce'
         and trader_commerce_id = ${traderCommerceId}::uuid
         and deleted_at is null
    `.execute(executor);
    if (found.rows[0] === undefined) {
      throw new ApplicationException(
        "file_not_found",
        "File not found",
        HttpStatus.NOT_FOUND,
      );
    }
  }

  /**
   * The logical storage layout for NEW Commerce uploads.
   *
   * Existing objects keep whatever key they already have — moving historical
   * bytes so the paths look tidy would change URLs and risk losing files for a
   * purely cosmetic gain.
   */
  public static commerceStorageKey(input: {
    readonly kind: "branding" | "product";
    readonly productId?: string;
    readonly storefrontId: string;
    readonly suffix: string;
    readonly traderCommerceId: string;
  }): string {
    const base = `commerce/${input.traderCommerceId}/stores/${input.storefrontId}`;
    if (input.kind === "branding") return `${base}/branding/${input.suffix}`;
    return `${base}/products/${input.productId ?? "unassigned"}/${input.suffix}`;
  }
}
