import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_agent_settings
      add column avatar_home_operations_image_url_en text,
      add column avatar_home_operations_image_url_ar text
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_agent_settings
      drop column avatar_home_operations_image_url_ar,
      drop column avatar_home_operations_image_url_en
  `.execute(database);
}
