import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Orders AI per Company (Aiman, 11 Oct 2026): the Platform switches the
 * Orders AI tab (question box) on or off for each Company.
 *
 * - One row per Company; no row means OFF, so every existing Company and
 *   every Company created later starts with Orders AI off until the Platform
 *   switches it on.
 * - `version` is the optimistic-concurrency counter for two Platform
 *   administrators changing it at once.
 * - Pure configuration: classified PRESERVE for data resets and deleted with
 *   the Company (see `reset-company-test-data.manifest.ts`).
 *
 * Additive only; no existing row changes meaning.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table if not exists company_ai_settings (
      company_id uuid primary key references companies(id) on delete restrict,
      orders_ai_enabled boolean not null default false,
      version integer not null default 1,
      updated_by_account_id uuid references accounts(id) on delete restrict,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint company_ai_settings_version_check check (version >= 1)
    )
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop table if exists company_ai_settings`.execute(database);
}
