import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Error Handler foundation -- lets a Platform Administrator see, understand,
 * and resolve crashes from any app (`web`, `api`, `platform-web`, `store`)
 * in one place, instead of a frontend crash vanishing into whichever
 * browser's console happened to be open, or a backend 500 living only in
 * Render's own log stream until its retention window rolls it off.
 *
 * ---------------------------------------------------------------------------
 * WHY `company_id` IS NULLABLE
 * ---------------------------------------------------------------------------
 *
 * Most crashes happen inside a signed-in Company session and are properly
 * scoped -- that's the "which Company did this happen to" the Platform needs.
 * But a crash can also happen with no Company context at all: the sign-in
 * screen itself failing, a Platform Administrator's own session in
 * `platform-web`, or an API request that fails before tenant resolution runs.
 * Forcing `company_id not null` would silently drop exactly the crashes that
 * are hardest to reproduce any other way.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A `deferrable`/audit-style immutable table
 * ---------------------------------------------------------------------------
 *
 * Unlike `order_status_history` or the platform audit trail, an error report
 * is meant to be worked: `severity`, `status`, `explanation`, and
 * `resolution_notes` are all editable by a Platform Administrator after the
 * fact. The one fact this table must never let drift is what actually
 * happened (`message`, `stack`, `correlation_id`, `path`, `app_commit`,
 * `occurred_at`) -- there is no UPDATE path for those columns in the service
 * layer, only for the triage fields.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    insert into permissions (code, description)
    values
      ('platform.errors.read', 'View captured application errors on the Platform'),
      ('platform.errors.manage', 'Triage and resolve captured application errors')
    on conflict (code) do update set description = excluded.description;

    insert into role_permissions (role_id, permission_code)
    select r.id, p.code
      from roles r
      cross join (values ('platform.errors.read'), ('platform.errors.manage')) as p(code)
     where r.company_id is null and lower(r.code) = 'platform_super_admin'
    on conflict do nothing;

    create table client_error_reports (
      id uuid primary key default gen_random_uuid(),
      company_id uuid references companies(id) on delete restrict,
      source_app text not null,
      severity text not null default 'high',
      status text not null default 'open',
      message text not null,
      stack text,
      correlation_id text,
      path text,
      account_id uuid,
      account_kind text,
      app_commit text,
      explanation text,
      resolution_notes text,
      resolved_by_account_id uuid references accounts(id) on delete restrict,
      resolved_at timestamptz,
      occurred_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      constraint client_error_reports_source_app_check
        check (source_app in ('web', 'api', 'platform-web', 'store', 'mobile')),
      constraint client_error_reports_severity_check
        check (severity in ('high', 'medium', 'low')),
      constraint client_error_reports_status_check
        check (status in ('open', 'resolved')),
      constraint client_error_reports_message_nonempty
        check (btrim(message) <> ''),
      -- Mirrors trader_settlements_confirmation_check's shape: a status and
      -- its supporting fields must move together, so a report can never be
      -- silently "resolved" with no record of who resolved it or when, nor
      -- carry a resolver on a report nobody has actually resolved.
      constraint client_error_reports_resolution_check
        check (
          (status = 'open' and resolved_by_account_id is null and resolved_at is null)
          or (status = 'resolved' and resolved_by_account_id is not null and resolved_at is not null)
        )
    );

    -- The Platform's own account table has no company_id at all
    -- (platform_administrator rows are company-less by design, see
    -- accounts_scope_check), so account_id is intentionally NOT a foreign
    -- key into a Company-scoped accounts row -- it must accept an account
    -- from any kind. Validated at the application layer instead.

    create index client_error_reports_open_index
      on client_error_reports (occurred_at desc)
      where status = 'open';

    create index client_error_reports_company_index
      on client_error_reports (company_id, occurred_at desc)
      where company_id is not null;

    create index client_error_reports_source_app_index
      on client_error_reports (source_app, occurred_at desc);
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop table if exists client_error_reports;

    delete from role_permissions
     where permission_code in ('platform.errors.read', 'platform.errors.manage');
    delete from permissions
     where code in ('platform.errors.read', 'platform.errors.manage');
  `.execute(database);
}
