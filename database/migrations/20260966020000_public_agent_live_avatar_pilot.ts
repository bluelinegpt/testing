import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_agent_settings
      add column avatar_live_enabled boolean not null default false,
      add column avatar_live_provider text not null default 'heygen_live'
        check (avatar_live_provider in ('heygen_live','tavus_live','future_provider'));
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_agent_settings
      drop column avatar_live_provider,
      drop column avatar_live_enabled;
  `.execute(database);
}
