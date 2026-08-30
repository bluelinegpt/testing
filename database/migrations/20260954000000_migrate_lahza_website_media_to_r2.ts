import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

interface Branding {
  logoDataUrl?: string;
  bannerDataUrl?: string;
  bannerDataUrls?: string[];
  bannerDataUrlsAr?: string[];
  [key: string]: unknown;
}

interface Decoded {
  buffer: Buffer;
  ext: string;
  contentType: string;
}

function decodeInlineImage(value: string): Decoded | null {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  if (!match) return null;
  const [, format, base64] = match;
  return {
    buffer: Buffer.from(base64, "base64"),
    contentType: `image/${format}`,
    ext: format === "jpeg" ? "jpg" : format,
  };
}

/**
 * One-time backfill, not a schema change: `lahza`'s Website still has its
 * logo/banner saved as inline base64 from before branding media moved to R2
 * (see the same day's "store Website logo/banners in R2" commit) -- up to
 * ~10MB across draft_settings/published_settings, repeatedly served by the
 * public endpoint and a direct contributor to the API's out-of-memory
 * crashes. Disabling the Website (an earlier migration) stopped that
 * payload from being served, but the oversized data is still sitting in the
 * database; this actually moves it to R2 and shrinks the row, using the
 * exact same key shape and public URL format `uploadMedia`/`readMedia` in
 * CompanyWebsiteService use, so the existing read path serves it unchanged.
 *
 * Deliberately resilient rather than all-or-nothing: R2 config missing
 * (e.g. a local/dev database on the "local" storage provider), no `lahza`
 * row, or a single image's upload failing are all handled by leaving that
 * one value as base64 and continuing -- a transient R2 hiccup here must
 * not fail the whole deploy's migration step and block the app from
 * booting. Anything left un-migrated can be fixed later the normal way:
 * re-uploading through the Website editor.
 *
 * No audit_events row is written: that table requires a real
 * actor_account_id, and there is no authenticated actor for a migration --
 * this file, its commit message, and the deploy that ran it are the record.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucketName = process.env.R2_BUCKET_NAME;
  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) return;

  const client = new S3Client({
    credentials: { accessKeyId, secretAccessKey },
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    region: "auto",
  });

  const rows = await sql<{
    companyId: string;
    draftSettings: { branding?: Branding; [key: string]: unknown };
    publishedSettings: { branding?: Branding; [key: string]: unknown } | null;
  }>`
    select company_id as "companyId", draft_settings as "draftSettings", published_settings as "publishedSettings"
      from company_websites
     where slug = 'lahza'
  `.execute(database);
  const row = rows.rows[0];
  if (!row) return;

  let anyChanged = false;

  async function migrateOne(value: string | undefined): Promise<string | undefined> {
    if (value === undefined) return value;
    const decoded = decodeInlineImage(value);
    if (decoded === null) return value; // Already a URL (or unrecognized) -- leave as-is.
    const filename = `${randomUUID()}.${decoded.ext}`;
    const key = `website/company/${row.companyId}/${filename}`;
    try {
      await client.send(
        new PutObjectCommand({
          Body: decoded.buffer,
          Bucket: bucketName,
          ContentType: decoded.contentType,
          Key: key,
        }),
      );
    } catch (error) {
      console.error(`[migrate_lahza_website_media_to_r2] R2 upload failed for ${key}:`, error);
      return value;
    }
    anyChanged = true;
    return `/api/v1/public/company-website/media/${row.companyId}/${filename}`;
  }

  async function migrateSettings<T extends { branding?: Branding }>(settings: T): Promise<T> {
    if (!settings.branding) return settings;
    const branding = { ...settings.branding };
    branding.logoDataUrl = await migrateOne(branding.logoDataUrl);
    branding.bannerDataUrl = await migrateOne(branding.bannerDataUrl);
    if (branding.bannerDataUrls) {
      branding.bannerDataUrls = (await Promise.all(branding.bannerDataUrls.map(migrateOne))).filter(
        (value): value is string => value !== undefined,
      );
    }
    if (branding.bannerDataUrlsAr) {
      branding.bannerDataUrlsAr = (
        await Promise.all(branding.bannerDataUrlsAr.map(migrateOne))
      ).filter((value): value is string => value !== undefined);
    }
    return { ...settings, branding };
  }

  const draftSettings = await migrateSettings(row.draftSettings);
  const publishedSettings =
    row.publishedSettings === null ? null : await migrateSettings(row.publishedSettings);

  if (!anyChanged) return;

  await sql`
    update company_websites
       set draft_settings = ${JSON.stringify(draftSettings)}::jsonb,
           published_settings = ${
             publishedSettings === null ? sql`published_settings` : sql`${JSON.stringify(publishedSettings)}::jsonb`
           },
           updated_at = now(),
           version = version + 1
     where company_id = ${row.companyId}::uuid
  `.execute(database);
}

export async function down(): Promise<void> {
  // Deliberately a no-op -- see the comment above `up`.
}
