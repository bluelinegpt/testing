import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_website_media
      drop constraint platform_website_media_media_type_check,
      drop constraint platform_website_media_size_bytes_check,
      add constraint platform_website_media_media_type_check
        check (media_type in ('image/png','image/jpeg','image/webp','video/mp4')),
      add constraint platform_website_media_size_bytes_check
        check (size_bytes > 0 and size_bytes <= 20971520)
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from platform_website_media where media_type = 'video/mp4';

    alter table platform_website_media
      drop constraint platform_website_media_size_bytes_check,
      drop constraint platform_website_media_media_type_check,
      add constraint platform_website_media_size_bytes_check
        check (size_bytes > 0 and size_bytes <= 5242880),
      add constraint platform_website_media_media_type_check
        check (media_type in ('image/png','image/jpeg','image/webp'))
  `.execute(database);
}
