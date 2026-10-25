import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Route planning: Google pin suggestions and Driver route feedback
 * (Aiman, 25 Oct 2026).
 *
 * Drivers saw the "unsequenced" Area list because no Area had a pin. Two
 * additive tables:
 *
 * - `area_coordinate_suggestions`: a position looked up from Google
 *   Geocoding for an Area that has no confirmed pin. A suggestion is never
 *   routed on: an administrator accepts it (which saves and confirms the
 *   Area's pin exactly as a hand-entered pin) or rejects it. Doubtful results
 *   carry a `flag` and are never accepted in bulk. At most one open
 *   suggestion per Area.
 *
 * - `driver_route_feedback`: the Driver's like / dislike of one run, with an
 *   optional reason, comment and -- for "wrong location" -- the Areas he
 *   means. One row per run; the Driver may change his mind (updated in
 *   place). The planned Area order at that moment is kept as a snapshot so
 *   the report compares it with the order he actually delivered in.
 *
 * Nothing here writes to `areas`, `orders` or any money table.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table if not exists area_coordinate_suggestions (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      area_id uuid not null,
      source text not null default 'google_geocoding' check (source in ('google_geocoding')),
      query text not null check (length(query) between 1 and 300),
      latitude numeric(9,6),
      longitude numeric(9,6),
      formatted_address text,
      result_types jsonb not null default '[]'::jsonb check (jsonb_typeof(result_types) = 'array'),
      flag text check (flag in ('not_found', 'outside_emirate', 'city_level', 'partial_match')),
      resolution text check (resolution in ('accepted', 'rejected')),
      resolved_at timestamptz,
      resolved_by_account_id uuid,
      created_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      foreign key (area_id, company_id) references areas(id, company_id) on delete restrict,
      foreign key (created_by_account_id, company_id) references accounts(id, company_id) on delete restrict,
      foreign key (resolved_by_account_id, company_id) references accounts(id, company_id) on delete restrict,
      check ((latitude is null) = (longitude is null)),
      check (latitude is null or (latitude between -90 and 90 and longitude between -180 and 180)),
      check ((flag = 'not_found') = (latitude is null)),
      check ((resolution is null and resolved_at is null and resolved_by_account_id is null)
          or (resolution is not null and resolved_at is not null and resolved_by_account_id is not null)),
      check (resolution is distinct from 'accepted' or flag is distinct from 'not_found')
    )
  `.execute(database);
  await sql`
    create unique index if not exists area_coordinate_suggestions_one_open
      on area_coordinate_suggestions (company_id, area_id)
      where resolution is null
  `.execute(database);
  await sql`
    comment on table area_coordinate_suggestions is
      'Google-suggested Area pins awaiting an administrator. Never routed on until accepted.'
  `.execute(database);

  await sql`
    create table if not exists driver_route_feedback (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      run_id uuid not null,
      driver_id uuid not null,
      rating text not null check (rating in ('like', 'dislike')),
      reason text check (reason in ('wrong_order', 'wrong_location', 'too_long', 'other')),
      comment text check (comment is null or length(comment) <= 500),
      area_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(area_ids) = 'array'),
      planned_area_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(planned_area_ids) = 'array'),
      direction text not null check (direction in ('recommended', 'reversed')),
      run_revision integer not null check (run_revision > 0),
      created_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (company_id, run_id),
      foreign key (run_id, company_id) references driver_route_runs(id, company_id) on delete restrict,
      foreign key (driver_id, company_id) references drivers(id, company_id) on delete restrict,
      foreign key (created_by_account_id, company_id) references accounts(id, company_id) on delete restrict,
      check (rating = 'dislike' or reason is null)
    )
  `.execute(database);
  await sql`
    create index if not exists driver_route_feedback_recent
      on driver_route_feedback (company_id, created_at desc)
  `.execute(database);
  await sql`
    comment on table driver_route_feedback is
      'Driver like / dislike of a planned route, one per run.'
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop table if exists driver_route_feedback`.execute(database);
  await sql`drop table if exists area_coordinate_suggestions`.execute(database);
}
