import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Route planning engine decision (Aiman, 10 Oct 2026): the stored-pin Area
 * engine, with no per-run cost.
 *
 * - The default provider becomes `area_matrix`. It sequences Areas in our own
 *   code from the pins stored once per Area, so it makes no external call and
 *   needs no budget. `google_routes` stays an allowed value for a later,
 *   deliberate trial; nothing implements it yet.
 * - The Company's branch location, because a Driver usually ends the run back
 *   at the branch to hand over the cash. With no GPS and no chosen start, the
 *   run also starts there.
 * - `route_source = 'branch'` records a run that started from the branch.
 *
 * Additive only. No Company is enabled by this migration.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table company_route_optimization_settings
      alter column provider set default 'area_matrix',
      add column if not exists branch_latitude numeric(9,6),
      add column if not exists branch_longitude numeric(9,6)
  `.execute(database);
  await sql`
    alter table company_route_optimization_settings
      add constraint company_route_optimization_settings_branch_check check (
        (branch_latitude is null and branch_longitude is null)
        or (branch_latitude between -90 and 90 and branch_longitude between -180 and 180)
      )
  `.execute(database);
  await sql`
    update company_route_optimization_settings
       set provider = 'area_matrix', updated_at = now(), version = version + 1
     where provider = 'google_routes' and not is_enabled
  `.execute(database);

  await sql`
    alter table driver_route_runs
      drop constraint if exists driver_route_runs_route_source_check
  `.execute(database);
  await sql`
    alter table driver_route_runs
      add constraint driver_route_runs_route_source_check
      check (route_source in ('gps', 'selected_area', 'branch', 'fallback'))
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table driver_route_runs drop constraint if exists driver_route_runs_route_source_check
  `.execute(database);
  await sql`
    alter table driver_route_runs
      add constraint driver_route_runs_route_source_check
      check (route_source in ('gps', 'selected_area', 'fallback'))
  `.execute(database);
  await sql`
    alter table company_route_optimization_settings
      drop constraint if exists company_route_optimization_settings_branch_check,
      drop column if exists branch_longitude,
      drop column if exists branch_latitude,
      alter column provider set default 'google_routes'
  `.execute(database);
}
