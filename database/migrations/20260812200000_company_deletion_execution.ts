import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table platform_company_deletion_operations
      drop constraint platform_company_deletion_operations_state_check,
      add constraint platform_company_deletion_operations_state_check check (
        state in ('previewed','ready','blocked','deleting','completed','completed_cleanup_pending','failed','rolled_back')
      ),
      add column manifest_version text,
      add column manifest_hash text;

    alter table platform_company_deletion_previews
      add column manifest_hash text,
      add column closed_at_snapshot timestamptz,
      add column environment_snapshot text,
      add column module_counts jsonb not null default '{}'::jsonb,
      add column guarded_triggers jsonb not null default '[]'::jsonb;

    create table platform_company_deletion_cleanup_items (
      id uuid primary key default gen_random_uuid(),
      operation_id uuid not null references platform_company_deletion_operations(id) on delete restrict,
      object_reference text not null,
      storage_provider text not null,
      ownership_category text not null,
      status text not null check (status in ('pending','completed','failed')),
      attempts integer not null default 0,
      last_failure text,
      completed_at timestamptz,
      created_at timestamptz not null default now(),
      constraint platform_company_deletion_cleanup_object_unique unique (operation_id, object_reference)
    );
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop table if exists platform_company_deletion_cleanup_items;
    alter table platform_company_deletion_previews
      drop column if exists guarded_triggers,
      drop column if exists module_counts,
      drop column if exists environment_snapshot,
      drop column if exists closed_at_snapshot,
      drop column if exists manifest_hash;
    alter table platform_company_deletion_operations
      drop column if exists manifest_hash,
      drop column if exists manifest_version,
      drop constraint if exists platform_company_deletion_operations_state_check,
      add constraint platform_company_deletion_operations_state_check check (
        state in ('previewed','ready','blocked','deleting','completed','failed','rolled_back')
      );
  `.execute(database);
}
