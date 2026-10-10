import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Driver route planning, foundation. Additive only, and OFF everywhere.
 *
 * - Area centroids (nullable). An Area is only ever sequenced once an
 *   administrator has confirmed its pin (`coordinates_verified_at`); until
 *   then it is listed unsequenced, so the rollout can start with the busiest
 *   Areas instead of all of them.
 * - A Platform-wide kill switch as a durable row (`platform_feature_flags`),
 *   so it survives restarts and redeploys. It wins over every Company flag.
 * - Per-Company settings, default disabled for every Company, including
 *   Companies created later (no row = disabled).
 *
 * No existing row changes meaning; nothing reads these until route planning
 * is switched on.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table areas
      add column if not exists latitude numeric(9,6),
      add column if not exists longitude numeric(9,6),
      add column if not exists coordinates_verified_at timestamptz,
      add column if not exists coordinates_verified_by_account_id uuid references accounts(id) on delete restrict
  `.execute(database);
  await sql`
    alter table areas
      add constraint areas_coordinates_range_check check (
        (latitude is null and longitude is null)
        or (latitude between -90 and 90 and longitude between -180 and 180)
      ),
      add constraint areas_coordinates_verified_shape_check check (
        coordinates_verified_at is null
        or (latitude is not null and longitude is not null and coordinates_verified_by_account_id is not null)
      )
  `.execute(database);

  await sql`
    create table if not exists platform_feature_flags (
      code text primary key check (code ~ '^[a-z][a-z0-9_]{2,63}$'),
      is_enabled boolean not null,
      note text,
      updated_by_account_id uuid references accounts(id) on delete restrict,
      updated_at timestamptz not null default now()
    )
  `.execute(database);
  await sql`
    insert into platform_feature_flags (code, is_enabled, note)
    values ('route_optimization_enabled', false, 'Platform-wide kill switch for Driver route optimization')
    on conflict (code) do nothing
  `.execute(database);

  await sql`
    create table if not exists company_route_optimization_settings (
      company_id uuid primary key references companies(id) on delete restrict,
      is_enabled boolean not null default false,
      provider text not null default 'google_routes'
        check (provider in ('google_routes', 'area_matrix')),
      daily_call_budget integer not null default 200 check (daily_call_budget between 1 and 100000),
      updated_by_account_id uuid references accounts(id) on delete restrict,
      updated_at timestamptz not null default now(),
      version bigint not null default 1 check (version > 0)
    )
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop table if exists company_route_optimization_settings`.execute(database);
  await sql`delete from platform_feature_flags where code = 'route_optimization_enabled'`.execute(
    database,
  );
  await sql`
    alter table areas
      drop constraint if exists areas_coordinates_verified_shape_check,
      drop constraint if exists areas_coordinates_range_check,
      drop column if exists coordinates_verified_by_account_id,
      drop column if exists coordinates_verified_at,
      drop column if exists longitude,
      drop column if exists latitude
  `.execute(database);
}
