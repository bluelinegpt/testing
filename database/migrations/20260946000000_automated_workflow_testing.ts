import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table companies add column workflow_testing_enabled_at timestamptz;

    create table platform_workflow_test_runs(
      id uuid primary key,
      company_id uuid not null references companies(id) on delete restrict,
      mode text not null check(mode in('full','smoke')),
      status text not null default 'draft'
        check(status in('draft','scheduled','running','paused','stopping','completed','failed','cancelled','cleanup_pending','cleaned')),
      orders_per_day integer not null check(orders_per_day between 1 and 1000),
      duration_days integer not null check(duration_days between 1 and 30),
      concurrency integer not null check(concurrency between 1 and 10),
      planned_orders integer generated always as (orders_per_day*duration_days) stored,
      configuration jsonb not null default '{}'::jsonb,
      progress jsonb not null default '{}'::jsonb,
      side_effects_suppressed boolean not null,
      created_by_account_id uuid not null references accounts(id) on delete restrict,
      created_at timestamptz not null default now(),
      started_at timestamptz,
      paused_at timestamptz,
      completed_at timestamptz,
      cleanup_approved_at timestamptz,
      cleanup_approved_by_account_id uuid references accounts(id) on delete restrict,
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      check(mode='full' or planned_orders<=5),
      check(mode='smoke' or side_effects_suppressed)
    );
    create unique index platform_workflow_test_one_active_company
      on platform_workflow_test_runs(company_id)
      where status in('scheduled','running','paused','stopping');
    create index platform_workflow_test_runs_recent
      on platform_workflow_test_runs(created_at desc);

    create table platform_workflow_test_scenarios(
      id uuid primary key,
      run_id uuid not null references platform_workflow_test_runs(id) on delete cascade,
      company_id uuid not null references companies(id) on delete restrict,
      channel text not null,
      outcome text not null,
      language text not null check(language in('en','ar')),
      viewport text not null check(viewport in('desktop','tablet','mobile_web','native_mobile')),
      status text not null default 'queued' check(status in('queued','running','passed','failed','cancelled')),
      generated_order_id uuid references orders(id) on delete set null,
      safe_error text,
      correlation_id text,
      started_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz not null default now()
    );
    create index platform_workflow_test_scenarios_run_status
      on platform_workflow_test_scenarios(run_id,status,created_at);

    create table platform_workflow_test_steps(
      id uuid primary key,
      scenario_id uuid not null references platform_workflow_test_scenarios(id) on delete cascade,
      step_key text not null,
      status text not null check(status in('running','passed','failed','skipped')),
      safe_detail text,
      evidence_path text,
      started_at timestamptz not null default now(),
      completed_at timestamptz
    );

    insert into permissions(code,description) values
      ('platform.workflow_tests.read','View automated workflow tests and evidence'),
      ('platform.workflow_tests.manage','Configure and control automated workflow tests')
    on conflict(code) do update set description=excluded.description;
    insert into role_permissions(role_id,permission_code)
      select r.id,p.code from roles r cross join permissions p
       where r.company_id is null and lower(r.code)='platform_super_admin'
         and p.code in('platform.workflow_tests.read','platform.workflow_tests.manage')
    on conflict do nothing;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions where permission_code in('platform.workflow_tests.read','platform.workflow_tests.manage');
    delete from permissions where code in('platform.workflow_tests.read','platform.workflow_tests.manage');
    drop table if exists platform_workflow_test_steps;
    drop table if exists platform_workflow_test_scenarios;
    drop table if exists platform_workflow_test_runs;
    alter table companies drop column if exists workflow_testing_enabled_at;
  `.execute(database);
}
