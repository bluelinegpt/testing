import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { ConfigService } from "@nestjs/config";
import { config as loadEnvironment } from "dotenv";
import { Kysely, PostgresDialect, type Transaction, sql } from "kysely";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { type AppConfiguration, configuration } from "../configuration/environment.js";
import {
  type FileDescriptor,
  FileStoragePort,
  type StoredFileReference,
} from "../files/file-storage.port.js";
import type { DatabaseSchema } from "../infrastructure/database/database.types.js";
import type { KyselyTransactionManager } from "../infrastructure/database/transaction-manager.js";
import type { IdentityContext } from "../security/identity-context.js";
import type { IdentityContextAccessor } from "../security/identity-context.js";
import type { TenantContextAccessor } from "../tenancy/tenant-context.js";
import { AccountPreferencesService } from "./account-preferences.service.js";
import { CompanyProfileService } from "./company-profile.service.js";

const runDatabaseTests = process.env.RUN_COMPANY_PROFILE_DATABASE === "true";
const rollbackMarker = Symbol("rollback company profile test");

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0x11),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x22)]);

class MemoryStorage extends FileStoragePort {
  public readonly files = new Map<string, Buffer>();
  private sequence = 0;

  public async storePrivate(
    companyId: string,
    _descriptor: FileDescriptor,
    content: AsyncIterable<Uint8Array>,
  ): Promise<StoredFileReference> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of content) chunks.push(chunk);
    const storageKey = `logos/${companyId}/${(this.sequence += 1)}`;
    this.files.set(storageKey, Buffer.concat(chunks));
    return { storageKey };
  }

  public async readPrivate(_companyId: string, storageKey: string): Promise<Uint8Array> {
    const bytes = this.files.get(storageKey);
    if (bytes === undefined) throw new Error("missing");
    return bytes;
  }

  public async deletePrivate(_companyId: string, storageKey: string): Promise<void> {
    this.files.delete(storageKey);
  }
}

function fixedTenant(companyId: string, identityId: string): TenantContextAccessor {
  return { current: () => ({ companyId, identityId }) } as unknown as TenantContextAccessor;
}

function fixedIdentity(companyId: string, identityId: string): IdentityContextAccessor {
  const identity: IdentityContext = {
    companyId,
    forcePasswordChange: false,
    identityId,
    kind: "company_user",
    permissions: new Set(["company_profile.manage"]),
    sessionId: randomUUID(),
  };
  return { current: () => identity } as unknown as IdentityContextAccessor;
}

function servicesFor(
  trx: Transaction<DatabaseSchema>,
  storage: MemoryStorage,
  companyId: string,
  identityId: string,
): { preferences: AccountPreferencesService; profile: CompanyProfileService } {
  const transactions = {
    execute: <T>(work: (t: Transaction<DatabaseSchema>) => Promise<T>): Promise<T> => work(trx),
  } as unknown as KyselyTransactionManager;
  const config = {
    get: (key: string) => {
      if (key === "files.provider") return "local";
      throw new Error(`unexpected config key ${key}`);
    },
  } as unknown as ConfigService<AppConfiguration, true>;
  const profile = new CompanyProfileService(
    trx as unknown as Kysely<DatabaseSchema>,
    transactions,
    fixedTenant(companyId, identityId),
    fixedIdentity(companyId, identityId),
    storage,
    config,
  );
  const preferences = new AccountPreferencesService(
    trx as unknown as Kysely<DatabaseSchema>,
    transactions,
    fixedIdentity(companyId, identityId),
  );
  return { preferences, profile };
}

async function seedCompany(
  trx: Transaction<DatabaseSchema>,
  label: string,
  nameEn: string,
): Promise<{ admin: string; company: string; second: string }> {
  const company = randomUUID();
  const admin = randomUUID();
  const second = randomUUID();
  const short = company.slice(0, 8);
  await sql`insert into companies(id,code,subdomain,name_en,status,activated_at)
    values(${company}::uuid,${`${label}-${short}`},${`${label.toLowerCase()}-${short}`},${nameEn},'active',now())`.execute(
    trx,
  );
  await sql`insert into accounts(id,company_id,account_kind,username,password_hash) values
    (${admin}::uuid,${company}::uuid,'company_user',${`${label}.a.${admin.slice(0, 8)}`},'x'),
    (${second}::uuid,${company}::uuid,'company_user',${`${label}.b.${second.slice(0, 8)}`},'x')`.execute(
    trx,
  );
  return { admin, company, second };
}

describe.skipIf(!runDatabaseTests)("Company Profile (Phase A)", () => {
  it("seeds and backfills the company_profile.manage permission", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    try {
      const exists = await sql<{ code: string }>`
        select code from permissions where code = 'company_profile.manage'
      `.execute(database);
      expect(exists.rows).toHaveLength(1);

      // Every role that holds users_roles.manage must also hold the new
      // permission, so no existing administrator lost access.
      const gap = await sql<{ count: string }>`
        select count(*)::text as count
        from role_permissions ur
        where ur.permission_code = 'users_roles.manage'
          and not exists (
            select 1 from role_permissions cp
            where cp.role_id = ur.role_id and cp.permission_code = 'company_profile.manage'
          )
      `.execute(database);
      expect(gap.rows[0]?.count).toBe("0");
    } finally {
      await database.destroy();
    }
  });

  it("saves the profile, preserves telephone, isolates companies and audits", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    try {
      await expect(
        database.transaction().execute(async (trx) => {
          const storage = new MemoryStorage();
          const a = await seedCompany(trx, "CPA", "Seed A EN");
          const b = await seedCompany(trx, "CPB", "Seed B EN");
          const serviceA = servicesFor(trx, storage, a.company, a.admin);
          const serviceB = servicesFor(trx, storage, b.company, b.admin);

          // Names, subtitles and a formatted telephone are stored verbatim.
          const telephone = "+971 4 012 3456";
          const saved = await serviceA.profile.updateProfile(
            {
              nameAr: "  اسم عربي  ",
              nameEn: "  Acme Logistics  ",
              subtitleAr: "خدمات التوصيل",
              subtitleEn: "Delivery Services",
              telephone: ` ${telephone} `,
            },
            "corr-a",
          );
          expect(saved).toMatchObject({
            nameAr: "اسم عربي",
            nameEn: "Acme Logistics",
            subtitleAr: "خدمات التوصيل",
            subtitleEn: "Delivery Services",
            telephone,
          });

          // Whitespace-only subtitles collapse to null.
          const blanked = await serviceA.profile.updateProfile(
            { nameAr: "اسم", nameEn: "Acme", subtitleAr: "   ", subtitleEn: "  ", telephone: "04-1234567" },
            "corr-a2",
          );
          expect(blanked.subtitleAr).toBeNull();
          expect(blanked.subtitleEn).toBeNull();
          expect(blanked.telephone).toBe("04-1234567");

          // Company B is unaffected by A's writes.
          const brandingB = await serviceB.profile.branding();
          expect(brandingB.nameEn).toBe("Seed B EN");
          expect(brandingB.hasLogo).toBe(false);

          // Logo upload creates a validated, clean file_objects row and links it.
          const afterUpload = await serviceA.profile.uploadLogo(
            { buffer: PNG, mimetype: "image/png", originalname: "../../brand.png" },
            "corr-a3",
          );
          expect(afterUpload.logo).toMatchObject({ mediaType: "image/png" });
          const fileRow = await sql<{
            classification: string;
            deletedAt: string | null;
            provider: string;
            scanStatus: string;
            sha256: string | null;
          }>`
            select storage_provider as "provider", scan_status as "scanStatus",
                   classification, sha256, deleted_at as "deletedAt"
            from file_objects
            where company_id = ${a.company}::uuid and id = ${afterUpload.logo?.fileId}::uuid
          `.execute(trx);
          expect(fileRow.rows[0]).toMatchObject({
            classification: "private",
            deletedAt: null,
            provider: "local",
            scanStatus: "clean",
          });
          expect(fileRow.rows[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
          expect(storage.files.size).toBe(1);

          // Replacing the logo retires the previous asset (soft-delete + byte removal).
          const firstFileId = afterUpload.logo?.fileId;
          await serviceA.profile.uploadLogo(
            { buffer: JPEG, mimetype: "image/jpeg", originalname: "new.jpg" },
            "corr-a4",
          );
          const retired = await sql<{ deletedAt: string | null }>`
            select deleted_at as "deletedAt" from file_objects where id = ${firstFileId}::uuid
          `.execute(trx);
          expect(retired.rows[0]?.deletedAt).not.toBeNull();
          expect(storage.files.size).toBe(1);

          // Removing the logo clears the link.
          const afterRemove = await serviceA.profile.removeLogo("corr-a5");
          expect(afterRemove.logo).toBeNull();
          expect(storage.files.size).toBe(0);

          // Oversized and non-image uploads are rejected by content, not extension.
          await expect(
            serviceA.profile.uploadLogo(
              { buffer: Buffer.alloc(2 * 1024 * 1024 + 1, 0x11), mimetype: "image/png" },
              "corr-a6",
            ),
          ).rejects.toMatchObject({ errorCode: "logo_invalid" });
          await expect(
            serviceA.profile.uploadLogo(
              { buffer: Buffer.from("<svg/>", "utf8"), mimetype: "image/png", originalname: "x.png" },
              "corr-a7",
            ),
          ).rejects.toMatchObject({ errorCode: "logo_invalid" });

          // Audit rows exist for the profile actions and carry no binary payload.
          const audits = await sql<{ action: string; after: string }>`
            select action, after_data::text as after
            from audit_events
            where company_id = ${a.company}::uuid and subject_type = 'company_profile'
            order by occurred_at
          `.execute(trx);
          const actions = audits.rows.map((row) => row.action);
          expect(actions).toContain("company_profile.update");
          expect(actions).toContain("company_profile.logo_upload");
          expect(actions).toContain("company_profile.logo_remove");
          for (const row of audits.rows) {
            expect(row.after).not.toMatch(/buffer|base64|\\x89PNG/i);
            expect(row.after.length).toBeLessThan(600);
          }

          throw rollbackMarker;
        }),
      ).rejects.toBe(rollbackMarker);
    } finally {
      await database.destroy();
    }
  });

  it("stores per-user Text Language independently and persists it", async () => {
    loadEnvironment({ path: resolve(process.cwd(), "../../.env") });
    const pool = new Pool({ connectionString: configuration().database.url, max: 1 });
    const database = new Kysely<DatabaseSchema>({ dialect: new PostgresDialect({ pool }) });
    try {
      await expect(
        database.transaction().execute(async (trx) => {
          const storage = new MemoryStorage();
          const a = await seedCompany(trx, "CPL", "Seed L EN");
          const first = servicesFor(trx, storage, a.company, a.admin);
          const second = servicesFor(trx, storage, a.company, a.second);

          // Default is 'en' until changed.
          expect((await first.preferences.myPreferences()).textLanguage).toBe("en");

          await first.preferences.updateTextLanguage("ar", "corr-l1");
          await second.preferences.updateTextLanguage("en", "corr-l2");

          // One user's choice does not affect another.
          expect((await first.preferences.myPreferences()).textLanguage).toBe("ar");
          expect((await second.preferences.myPreferences()).textLanguage).toBe("en");

          // The change is persisted on the account row.
          const stored = await sql<{ language: string }>`
            select preferred_language as language from accounts where id = ${a.admin}::uuid
          `.execute(trx);
          expect(stored.rows[0]?.language).toBe("ar");

          throw rollbackMarker;
        }),
      ).rejects.toBe(rollbackMarker);
    } finally {
      await database.destroy();
    }
  });
});
