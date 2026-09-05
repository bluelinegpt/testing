import { sql, type Kysely } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_blog_articles
      add column social_image_alt text,
      add column social_image_width integer,
      add column social_image_height integer;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_blog_articles
      drop column social_image_height,
      drop column social_image_width,
      drop column social_image_alt;
  `.execute(database);
}
