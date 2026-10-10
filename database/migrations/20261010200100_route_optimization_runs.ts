import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Driver route planning: persisted runs, their Area stops, an append-only
 * action log, and the per-Company daily engine-call counter.
 *
 * Nothing here writes to `orders`. A Defer is a route action and a change to
 * the run's own `deferred_order_ids`, never an Order status change.
 *
 * - One active run per Driver per business date, enforced by a partial unique
 *   index rather than by application checks alone.
 * - Plan is idempotent through `(company, driver, business date, key)`;
 *   every other action through `(company, run, key)`.
 * - `revision` increases on every recomputation or reorder so a client
 *   holding an older sequence gets the current run back instead of acting on
 *   a stale one.
 * - The usage counter is reserved with a single insert..on conflict..returning
 *   statement, so two concurrent Plan requests cannot both slip under the
 *   budget.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table if not exists company_route_optimization_usage (
      company_id uuid not null references companies(id) on delete restrict,
      business_date date not null,
      call_count integer not null default 0 check (call_count >= 0),
      success_count integer not null default 0 check (success_count >= 0),
      failure_count integer not null default 0 check (failure_count >= 0),
      fallback_count integer not null default 0 check (fallback_count >= 0),
      updated_at timestamptz not null default now(),
      primary key (company_id, business_date)
    )
  `.execute(database);

  await sql`
    create table if not exists driver_route_runs (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      driver_id uuid not null,
      business_date date not null,
      reference_number text not null,
      status text not null default 'active' check (status in ('active', 'closed')),
      revision integer not null default 1 check (revision > 0),
      provider text not null check (provider in ('google_routes', 'area_matrix', 'none')),
      route_source text not null check (route_source in ('gps', 'selected_area', 'fallback')),
      result_source text not null check (result_source in ('provider', 'fallback')),
      fallback_reason text check (fallback_reason in (
        'disabled', 'kill_switch', 'budget', 'unverified_coordinates', 'provider_error', 'provider_unavailable'
      )),
      partial_optimization boolean not null default false,
      direction text not null default 'recommended' check (direction in ('recommended', 'reversed')),
      start_area_id uuid,
      start_latitude numeric(9,6),
      start_longitude numeric(9,6),
      engine_response_id text,
      distance_meters integer check (distance_meters is null or distance_meters >= 0),
      duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
      deferred_order_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(deferred_order_ids) = 'array'),
      plan_idempotency_key text not null check (length(plan_idempotency_key) between 8 and 200),
      created_by_account_id uuid not null,
      computed_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      closed_at timestamptz,
      unique (id, company_id),
      unique (company_id, reference_number),
      unique (company_id, driver_id, business_date, plan_idempotency_key),
      foreign key (driver_id, company_id) references drivers(id, company_id) on delete restrict,
      foreign key (start_area_id, company_id) references areas(id, company_id) on delete restrict,
      foreign key (created_by_account_id, company_id) references accounts(id, company_id) on delete restrict,
      check ((result_source = 'provider' and fallback_reason is null)
          or (result_source = 'fallback' and fallback_reason is not null)),
      check ((start_latitude is null and start_longitude is null)
          or (start_latitude between -90 and 90 and start_longitude between -180 and 180)),
      check ((status = 'active' and closed_at is null) or (status = 'closed' and closed_at is not null))
    )
  `.execute(database);
  await sql`
    create unique index if not exists driver_route_runs_one_active_per_driver_day
      on driver_route_runs (company_id, driver_id, business_date)
      where status = 'active'
  `.execute(database);

  await sql`
    create table if not exists driver_route_stops (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      run_id uuid not null,
      area_id uuid not null,
      sequence_position integer not null check (sequence_position > 0),
      is_sequenced boolean not null,
      status text not null default 'pending' check (status in ('pending', 'in_progress', 'done', 'skipped')),
      entered_at timestamptz,
      left_at timestamptz,
      unique (id, company_id),
      unique (run_id, sequence_position),
      unique (run_id, area_id),
      foreign key (run_id, company_id) references driver_route_runs(id, company_id) on delete restrict,
      foreign key (area_id, company_id) references areas(id, company_id) on delete restrict
    )
  `.execute(database);

  await sql`
    create table if not exists driver_route_actions (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      run_id uuid not null,
      driver_id uuid not null,
      action text not null check (action in (
        'plan', 'replan', 'reverse', 'defer', 'manual_reorder', 'area_entered', 'area_left', 'stop_done'
      )),
      revision integer not null check (revision > 0),
      area_id uuid,
      order_id uuid,
      idempotency_key text check (idempotency_key is null or length(idempotency_key) between 8 and 200),
      details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
      created_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      foreign key (run_id, company_id) references driver_route_runs(id, company_id) on delete restrict,
      foreign key (driver_id, company_id) references drivers(id, company_id) on delete restrict,
      foreign key (area_id, company_id) references areas(id, company_id) on delete restrict,
      foreign key (order_id, company_id) references orders(id, company_id) on delete restrict,
      foreign key (created_by_account_id, company_id) references accounts(id, company_id) on delete restrict
    )
  `.execute(database);
  await sql`
    create unique index if not exists driver_route_actions_idempotency
      on driver_route_actions (company_id, run_id, idempotency_key)
      where idempotency_key is not null
  `.execute(database);
  await sql`
    create index if not exists driver_route_actions_run
      on driver_route_actions (company_id, run_id, created_at)
  `.execute(database);

  // Route runs are numbered like every other document (RUN-000001 per Company).
  // The allowed reference types are extended in place, keeping whatever values
  // the live constraint already holds rather than restating the list.
  await sql`
    do $$
    declare
      definition text;
    begin
      select pg_get_constraintdef(oid) into definition
        from pg_constraint
       where conrelid = 'company_reference_counters'::regclass
         and conname = 'company_reference_counters_type_check';
      if definition is null or position('route_run' in definition) > 0 then
        return;
      end if;
      if position('}''::text[]' in definition) = 0 then
        raise exception 'Unexpected company_reference_counters_type_check shape: %', definition;
      end if;
      execute 'alter table company_reference_counters drop constraint company_reference_counters_type_check';
      execute 'alter table company_reference_counters add constraint company_reference_counters_type_check '
        || replace(definition, '}''::text[]', ',route_run}''::text[]');
    end
    $$
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop table if exists driver_route_actions`.execute(database);
  await sql`drop table if exists driver_route_stops`.execute(database);
  await sql`drop table if exists driver_route_runs`.execute(database);
  await sql`drop table if exists company_route_optimization_usage`.execute(database);
}
