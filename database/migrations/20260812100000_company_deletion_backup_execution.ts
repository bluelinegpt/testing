import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_company_deletion_backups
      add column size_bytes bigint,
      add column verified_at timestamptz;

    create unique index platform_company_deletion_one_verified_backup
      on platform_company_deletion_backups (operation_id)
      where status = 'verified';
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists platform_company_deletion_one_verified_backup;
    alter table platform_company_deletion_backups
      drop column if exists verified_at,
      drop column if exists size_bytes;
  `.execute(database);
}
