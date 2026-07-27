import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { type Kysely, sql } from "kysely";

import type { AppConfiguration } from "../configuration/environment.js";
import { FileStoragePort } from "../files/file-storage.port.js";
import { validateLogoImage } from "../files/image-signature.js";
import { DATABASE } from "../infrastructure/database/database.tokens.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import { ApplicationException } from "../presentation/errors/application.exception.js";
import { IdentityContextAccessor } from "../security/identity-context.js";
import { TenantContextAccessor } from "../tenancy/tenant-context.js";
import type { UpdateCompanyProfileDto } from "./company-profile.dto.js";

export interface CompanyLogoMetadata {
  readonly fileId: string;
  readonly mediaType: string;
  readonly originalFilename: string;
  readonly sizeBytes: number;
  readonly updatedAt: string;
}

export interface CompanyProfile {
  readonly logo: CompanyLogoMetadata | null;
  readonly nameAr: string | null;
  readonly nameEn: string;
  readonly subtitleAr: string | null;
  readonly subtitleEn: string | null;
  readonly telephone: string | null;
}

export interface CompanyBranding {
  readonly dataQuality: {
    readonly nameArMissing: boolean;
    readonly subtitleArMissing: boolean;
    readonly subtitleEnMissing: boolean;
  };
  readonly hasLogo: boolean;
  readonly logoFileId: string | null;
  readonly nameAr: string | null;
  readonly nameEn: string;
  readonly subtitleAr: string | null;
  readonly subtitleEn: string | null;
  readonly telephone: string | null;
}

export interface LogoContent {
  readonly bytes: Buffer;
  readonly fileName: string;
  readonly mediaType: string;
}

interface CompanyProfileRow {
  readonly logoFileId: string | null;
  readonly nameAr: string | null;
  readonly nameEn: string;
  readonly subtitleAr: string | null;
  readonly subtitleEn: string | null;
  readonly telephone: string | null;
}

interface LogoFileRow {
  readonly createdAt: string;
  readonly id: string;
  readonly mediaType: string;
  readonly originalFilename: string;
  readonly sizeBytes: string;
  readonly storageKey: string;
}

@Injectable()
export class CompanyProfileService {
  private readonly storageProvider: string;

  public constructor(
    @Inject(DATABASE) private readonly database: Kysely<DatabaseSchema>,
    @Inject(KyselyTransactionManager) private readonly transactions: KyselyTransactionManager,
    @Inject(TenantContextAccessor) private readonly tenants: TenantContextAccessor,
    @Inject(IdentityContextAccessor) private readonly identities: IdentityContextAccessor,
    @Inject(FileStoragePort) private readonly storage: FileStoragePort,
    @Inject(ConfigService) config: ConfigService<AppConfiguration, true>,
  ) {
    this.storageProvider = config.get("files.provider", { infer: true });
  }

  public async profile(): Promise<CompanyProfile> {
    const { companyId } = this.tenants.current();
    const row = await this.readProfileRow(this.database, companyId);
    const logo = row.logoFileId === null ? null : await this.readLogoMetadata(companyId);
    return {
      logo,
      nameAr: row.nameAr,
      nameEn: row.nameEn,
      subtitleAr: row.subtitleAr,
      subtitleEn: row.subtitleEn,
      telephone: row.telephone,
    };
  }

  public async branding(): Promise<CompanyBranding> {
    const { companyId } = this.tenants.current();
    const row = await this.readProfileRow(this.database, companyId);
    return {
      dataQuality: {
        nameArMissing: row.nameAr === null || row.nameAr.trim().length === 0,
        subtitleArMissing: row.subtitleEn !== null && row.subtitleAr === null,
        subtitleEnMissing: row.subtitleAr !== null && row.subtitleEn === null,
      },
      hasLogo: row.logoFileId !== null,
      logoFileId: row.logoFileId,
      nameAr: row.nameAr,
      nameEn: row.nameEn,
      subtitleAr: row.subtitleAr,
      subtitleEn: row.subtitleEn,
      telephone: row.telephone,
    };
  }

  public async updateProfile(
    input: UpdateCompanyProfileDto,
    correlationId: string,
  ): Promise<CompanyProfile> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const nameEn = input.nameEn.trim();
    const nameAr = input.nameAr.trim();
    const subtitleEn = input.subtitleEn?.trim() || null;
    const subtitleAr = input.subtitleAr?.trim() || null;
    const telephone = input.telephone.trim();
    await this.transactions.execute(async (transaction) => {
      const result = await sql<{ id: string }>`
        update companies
           set name_en = ${nameEn},
               name_ar = ${nameAr},
               subtitle_en = ${subtitleEn},
               subtitle_ar = ${subtitleAr},
               telephone = ${telephone},
               updated_at = now(),
               version = version + 1
         where id = ${companyId}::uuid
         returning id
      `.execute(transaction);
      if (result.rows[0] === undefined) {
        throw new ApplicationException("company_not_found", "Company not found", HttpStatus.NOT_FOUND);
      }
      await this.audit(transaction, {
        action: "company_profile.update",
        actorId: identity.identityId,
        after: { nameAr, nameEn, subtitleAr, subtitleEn, telephone },
        companyId,
        correlationId,
        subjectId: companyId,
        subjectType: "company_profile",
      });
    });
    return this.profile();
  }

  public async uploadLogo(
    file: { readonly buffer: Buffer; readonly mimetype?: string; readonly originalname?: string },
    correlationId: string,
  ): Promise<CompanyProfile> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    const bytes = file.buffer ?? Buffer.alloc(0);
    const validation = validateLogoImage(bytes, file.mimetype);
    if (!validation.ok) {
      throw new ApplicationException(
        "logo_invalid",
        `The uploaded logo was rejected (${validation.reason})`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const originalFilename = this.safeFilename(file.originalname, validation.type);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    // Persist the bytes first, then record metadata and re-point the Company in
    // a single transaction. If the transaction fails the freshly-stored bytes
    // are removed so no orphan is left behind.
    const stored = await this.storage.storePrivate(
      companyId,
      { contentType: validation.mediaType, fileName: originalFilename, sizeBytes: bytes.length },
      toAsyncIterable(bytes),
    );
    try {
      await this.transactions.execute(async (transaction) => {
        const previous = await this.currentLogo(transaction, companyId);
        const inserted = await sql<{ id: string }>`
          insert into file_objects (
            company_id, storage_provider, storage_key, original_filename, media_type,
            size_bytes, sha256, classification, scan_status, uploaded_by_account_id
          ) values (
            ${companyId}::uuid, ${this.storageProvider}, ${stored.storageKey}, ${originalFilename},
            ${validation.mediaType}, ${bytes.length}, ${sha256}, 'private', 'clean',
            ${identity.identityId}::uuid
          )
          returning id
        `.execute(transaction);
        const fileId = inserted.rows[0]?.id;
        if (fileId === undefined) throw new Error("Logo file insert did not return an id");
        await sql`
          update companies
             set logo_file_id = ${fileId}::uuid, updated_at = now(), version = version + 1
           where id = ${companyId}::uuid
        `.execute(transaction);
        if (previous !== undefined) {
          await this.retire(transaction, companyId, previous.id);
        }
        await this.audit(transaction, {
          action: "company_profile.logo_upload",
          actorId: identity.identityId,
          // Metadata only — never the file bytes.
          after: {
            fileId,
            mediaType: validation.mediaType,
            originalFilename,
            replacedFileId: previous?.id ?? null,
            sha256,
            sizeBytes: bytes.length,
          },
          companyId,
          correlationId,
          subjectId: companyId,
          subjectType: "company_profile",
        });
        // Best-effort byte cleanup of the retired asset, after the metadata is
        // safely committed within the transaction callback's returned promise.
        if (previous !== undefined) {
          await this.deleteBytes(companyId, previous.storageKey);
        }
      });
    } catch (error) {
      await this.deleteBytes(companyId, stored.storageKey);
      throw error;
    }
    return this.profile();
  }

  public async removeLogo(correlationId: string): Promise<CompanyProfile> {
    const { companyId } = this.tenants.current();
    const identity = this.identities.current();
    await this.transactions.execute(async (transaction) => {
      const previous = await this.currentLogo(transaction, companyId);
      if (previous === undefined) return;
      await sql`
        update companies
           set logo_file_id = null, updated_at = now(), version = version + 1
         where id = ${companyId}::uuid
      `.execute(transaction);
      await this.retire(transaction, companyId, previous.id);
      await this.audit(transaction, {
        action: "company_profile.logo_remove",
        actorId: identity.identityId,
        after: { removedFileId: previous.id },
        companyId,
        correlationId,
        subjectId: companyId,
        subjectType: "company_profile",
      });
      await this.deleteBytes(companyId, previous.storageKey);
    });
    return this.profile();
  }

  public async logoContent(): Promise<LogoContent> {
    const { companyId } = this.tenants.current();
    const meta = await this.readLogoFileRow(this.database, companyId);
    if (meta === undefined) {
      throw new ApplicationException("logo_not_found", "No Company logo is set", HttpStatus.NOT_FOUND);
    }
    const bytes = await this.storage.readPrivate(companyId, meta.storageKey);
    return { bytes: Buffer.from(bytes), fileName: meta.originalFilename, mediaType: meta.mediaType };
  }

  private async readProfileRow(
    database: Kysely<DatabaseSchema>,
    companyId: string,
  ): Promise<CompanyProfileRow> {
    const result = await sql<CompanyProfileRow>`
      select name_en as "nameEn",
             name_ar as "nameAr",
             subtitle_en as "subtitleEn",
             subtitle_ar as "subtitleAr",
             telephone,
             logo_file_id as "logoFileId"
      from companies
      where id = ${companyId}::uuid
    `.execute(database);
    const row = result.rows[0];
    if (row === undefined) {
      throw new ApplicationException("company_not_found", "Company not found", HttpStatus.NOT_FOUND);
    }
    return row;
  }

  private async readLogoMetadata(companyId: string): Promise<CompanyLogoMetadata | null> {
    const row = await this.readLogoFileRow(this.database, companyId);
    if (row === undefined) return null;
    return {
      fileId: row.id,
      mediaType: row.mediaType,
      originalFilename: row.originalFilename,
      sizeBytes: Number(row.sizeBytes),
      updatedAt: row.createdAt,
    };
  }

  private async readLogoFileRow(
    database: Kysely<DatabaseSchema>,
    companyId: string,
  ): Promise<LogoFileRow | undefined> {
    const result = await sql<LogoFileRow>`
      select f.id,
             f.storage_key as "storageKey",
             f.original_filename as "originalFilename",
             f.media_type as "mediaType",
             f.size_bytes::text as "sizeBytes",
             f.created_at as "createdAt"
      from companies c
      join file_objects f on f.id = c.logo_file_id and f.company_id = c.id
      where c.id = ${companyId}::uuid and f.deleted_at is null
    `.execute(database);
    return result.rows[0];
  }

  private async currentLogo(
    transaction: Kysely<DatabaseSchema>,
    companyId: string,
  ): Promise<{ id: string; storageKey: string } | undefined> {
    const result = await sql<{ id: string; storageKey: string }>`
      select f.id, f.storage_key as "storageKey"
      from companies c
      join file_objects f on f.id = c.logo_file_id and f.company_id = c.id
      where c.id = ${companyId}::uuid and f.deleted_at is null
      for update of f
    `.execute(transaction);
    return result.rows[0];
  }

  private async retire(
    transaction: Kysely<DatabaseSchema>,
    companyId: string,
    fileId: string,
  ): Promise<void> {
    await sql`
      update file_objects set deleted_at = now()
      where id = ${fileId}::uuid and company_id = ${companyId}::uuid
    `.execute(transaction);
  }

  private async deleteBytes(companyId: string, storageKey: string): Promise<void> {
    try {
      await this.storage.deletePrivate(companyId, storageKey);
    } catch {
      // Byte cleanup is best-effort: the metadata row is already soft-deleted,
      // so a leftover file is inert and never referenced. Never rethrow here.
    }
  }

  private safeFilename(original: string | undefined, type: "png" | "jpeg"): string {
    const fallback = type === "png" ? "logo.png" : "logo.jpg";
    if (original === undefined) return fallback;
    // Strip any directory component (defeats path traversal) and keep only a
    // conservative character set. The result is metadata only — it is never
    // used to build the storage path.
    const base = basename(original.replace(/\\/g, "/")).replace(/[^\w.\- ]+/g, "_").trim();
    if (base.length === 0 || base === "." || base === "..") return fallback;
    return base.slice(0, 200);
  }

  private async audit(
    database: Kysely<DatabaseSchema>,
    input: {
      action: string;
      actorId: string;
      after: object;
      companyId: string;
      correlationId: string;
      subjectId: string;
      subjectType: string;
    },
  ): Promise<void> {
    await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id,
        after_data, correlation_id
      ) values (
        ${input.companyId}::uuid, ${input.actorId}::uuid, ${input.action},
        ${input.subjectType}, ${input.subjectId}, ${JSON.stringify(input.after)}::jsonb,
        ${input.correlationId}
      )
    `.execute(database);
  }
}

async function* toAsyncIterable(buffer: Buffer): AsyncIterable<Uint8Array> {
  yield buffer;
}
