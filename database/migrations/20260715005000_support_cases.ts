import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table support_cases (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      case_number text not null,
      title text not null,
      description text not null,
      priority text not null default 'normal',
      status text not null default 'open',
      created_by_account_id uuid not null,
      assigned_to_account_id uuid,
      resolution_notes text,
      resolved_at timestamptz,
      closed_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      unique (company_id, case_number),
      constraint support_cases_creator_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint support_cases_assignee_fk foreign key (assigned_to_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint support_cases_priority_check check (priority in ('low', 'normal', 'high', 'urgent')),
      constraint support_cases_status_check check (status in ('open', 'in_progress', 'resolved', 'closed')),
      constraint support_cases_title_nonempty check (btrim(title) <> ''),
      constraint support_cases_description_nonempty check (btrim(description) <> ''),
      constraint support_cases_resolution_check check (
        (status in ('open', 'in_progress') and resolved_at is null and closed_at is null)
        or (status = 'resolved' and resolved_at is not null and closed_at is null)
        or (status = 'closed' and resolved_at is not null and closed_at is not null)
      ),
      constraint support_cases_version_positive check (version > 0)
    );
    create index support_cases_company_status_index on support_cases (company_id, status, updated_at desc);
    create index support_cases_company_created_index on support_cases (company_id, created_at desc);
  `.execute(database);
}
