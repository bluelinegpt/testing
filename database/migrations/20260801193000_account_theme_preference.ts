import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table accounts
      add column if not exists preferred_theme text not null default 'system';

    alter table accounts
      drop constraint if exists accounts_preferred_theme_check;

    alter table accounts
      add constraint accounts_preferred_theme_check
        check (preferred_theme in ('light', 'dark', 'system'));
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table accounts
      drop constraint if exists accounts_preferred_theme_check;

    alter table accounts
      drop column if exists preferred_theme;
  `.execute(database);
}
