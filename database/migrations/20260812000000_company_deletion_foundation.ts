import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/** Additive foundation only. Nothing in this migration deletes Company data. */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table companies add column closed_at timestamptz;
    alter table companies drop constraint companies_status_check;
    alter table companies add constraint companies_status_check check (
      status in ('draft', 'active', 'suspended', 'disabled', 'closed')
    );
    alter table companies add constraint companies_closed_at_check check (
      (status = 'closed' and closed_at is not null)
      or (status <> 'closed' and closed_at is null)
    );

    insert into permissions (code, description)
    values ('platform.companies.delete', 'Preview and permanently delete eligible Companies')
    on conflict (code) do update set description = excluded.description;

    insert into role_permissions (role_id, permission_code)
    select r.id, 'platform.companies.delete' from roles r
     where r.company_id is null and lower(r.code) = 'platform_super_admin'
    on conflict do nothing;

    create table platform_company_deletion_operations (
      id uuid primary key default gen_random_uuid(),
      company_id_snapshot uuid not null,
      company_code_snapshot text not null,
      company_name_snapshot text not null,
      environment text not null,
      closed_at timestamptz not null,
      eligible_at timestamptz not null,
      requested_by_account_id uuid not null references accounts(id) on delete restrict,
      requested_at timestamptz not null default now(),
      state text not null check (state in ('previewed','ready','blocked','deleting','completed','failed','rolled_back')),
      preview_id uuid,
      backup_reference text,
      started_at timestamptz,
      completed_at timestamptz,
      result jsonb,
      failure_reason text,
      correlation_id text not null,
      idempotency_key text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint platform_company_deletion_operations_idempotency_unique unique (idempotency_key)
    );
    create unique index platform_company_deletion_one_active
      on platform_company_deletion_operations (company_id_snapshot)
      where state in ('previewed','ready','deleting');

    create table platform_company_deletion_previews (
      id uuid primary key default gen_random_uuid(),
      operation_id uuid not null references platform_company_deletion_operations(id) on delete restrict,
      company_id_snapshot uuid not null,
      manifest_version text not null,
      generated_at timestamptz not null default now(),
      row_counts jsonb not null,
      blockers jsonb not null,
      unknown_references jsonb not null,
      fk_cycles jsonb not null,
      external_files jsonb not null,
      global_preserved jsonb not null,
      total_company_rows bigint not null,
      ready_for_delete boolean not null
    );
    alter table platform_company_deletion_operations
      add constraint platform_company_deletion_operation_preview_fk
      foreign key (preview_id) references platform_company_deletion_previews(id) on delete restrict;

    create table platform_company_deletion_backups (
      id uuid primary key default gen_random_uuid(),
      operation_id uuid not null references platform_company_deletion_operations(id) on delete restrict,
      company_id_snapshot uuid not null,
      backup_type text not null check (backup_type in ('full_database','company_logical')),
      status text not null check (status in ('requested','running','verified','failed')),
      storage_reference text,
      checksum_sha256 text,
      failure_reason text,
      created_at timestamptz not null default now(),
      completed_at timestamptz,
      created_by_account_id uuid not null references accounts(id) on delete restrict
    );
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop table if exists platform_company_deletion_backups;
    alter table platform_company_deletion_operations drop constraint if exists platform_company_deletion_operation_preview_fk;
    drop table if exists platform_company_deletion_previews;
    drop table if exists platform_company_deletion_operations;
    delete from role_permissions where permission_code = 'platform.companies.delete';
    delete from permissions where code = 'platform.companies.delete';
    alter table companies drop constraint if exists companies_closed_at_check;
    update companies set status = 'disabled', closed_at = null where status = 'closed';
    alter table companies drop constraint if exists companies_status_check;
    alter table companies add constraint companies_status_check check (
      status in ('draft', 'active', 'suspended', 'disabled')
    );
    alter table companies drop column if exists closed_at;
  `.execute(database);
}
