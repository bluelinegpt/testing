import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create sequence platform_demo_request_reference_seq;

    create table platform_demo_requests (
      id uuid primary key default gen_random_uuid(),
      reference_number text not null unique,
      company_name text not null check (char_length(company_name) between 2 and 200),
      contact_person text not null check (char_length(contact_person) between 2 and 160),
      mobile_number text not null check (mobile_number ~ '^\\+971[0-9]{9}$'),
      email text not null check (char_length(email) <= 254),
      emirate text not null check (emirate in ('abu_dhabi','dubai','sharjah','ajman','umm_al_quwain','ras_al_khaimah','fujairah')),
      website text check (website is null or char_length(website) <= 300),
      approximate_driver_count integer check (approximate_driver_count is null or approximate_driver_count between 0 and 100000),
      approximate_monthly_orders integer check (approximate_monthly_orders is null or approximate_monthly_orders between 0 and 100000000),
      approximate_trader_count integer check (approximate_trader_count is null or approximate_trader_count between 0 and 1000000),
      current_system text check (current_system is null or char_length(current_system) <= 300),
      preferred_contact_method text not null check (preferred_contact_method in ('phone','whatsapp','email')),
      main_challenges text check (main_challenges is null or char_length(main_challenges) <= 3000),
      features_of_interest text[] not null default '{}',
      notes text check (notes is null or char_length(notes) <= 3000),
      source text not null default 'public_website' check (char_length(source) <= 80),
      landing_page text not null check (char_length(landing_page) <= 500),
      referrer text check (referrer is null or char_length(referrer) <= 1000),
      utm_source text check (utm_source is null or char_length(utm_source) <= 200),
      utm_medium text check (utm_medium is null or char_length(utm_medium) <= 200),
      utm_campaign text check (utm_campaign is null or char_length(utm_campaign) <= 200),
      utm_term text check (utm_term is null or char_length(utm_term) <= 200),
      utm_content text check (utm_content is null or char_length(utm_content) <= 200),
      submission_fingerprint text not null check (submission_fingerprint ~ '^[a-f0-9]{64}$'),
      status text not null default 'new' check (status in ('new','reviewing','contacted','qualified','demo_scheduled','converted','not_interested','rejected','closed')),
      assigned_to uuid references accounts(id) on delete set null,
      contacted_at timestamptz,
      qualified_at timestamptz,
      demo_scheduled_at timestamptz,
      converted_at timestamptz,
      converted_company_id uuid references companies(id) on delete set null,
      closed_at timestamptz,
      close_reason text check (close_reason is null or char_length(close_reason) <= 1000),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create index platform_demo_requests_created_idx on platform_demo_requests (created_at desc);
    create index platform_demo_requests_status_created_idx on platform_demo_requests (status, created_at desc);
    create index platform_demo_requests_emirate_created_idx on platform_demo_requests (emirate, created_at desc);
    create index platform_demo_requests_fingerprint_idx on platform_demo_requests (submission_fingerprint, created_at desc);

    create table platform_demo_request_history (
      id uuid primary key default gen_random_uuid(),
      demo_request_id uuid not null references platform_demo_requests(id) on delete restrict,
      from_status text,
      to_status text not null,
      actor_account_id uuid references accounts(id) on delete set null,
      detail jsonb not null default '{}',
      created_at timestamptz not null default now()
    );
    create index platform_demo_request_history_request_idx on platform_demo_request_history (demo_request_id, created_at);

    create table platform_demo_request_notes (
      id uuid primary key default gen_random_uuid(),
      demo_request_id uuid not null references platform_demo_requests(id) on delete restrict,
      author_account_id uuid references accounts(id) on delete set null,
      note_text text not null check (char_length(note_text) between 1 and 4000),
      created_at timestamptz not null default now()
    );
    create index platform_demo_request_notes_request_idx on platform_demo_request_notes (demo_request_id, created_at);

    create or replace function reject_platform_demo_request_append_only_mutation()
    returns trigger language plpgsql as $$
    begin
      raise exception '% is append-only', tg_table_name using errcode = '55000';
    end;
    $$;
    create trigger platform_demo_request_history_append_only before update or delete on platform_demo_request_history for each row execute function reject_platform_demo_request_append_only_mutation();
    create trigger platform_demo_request_notes_append_only before update or delete on platform_demo_request_notes for each row execute function reject_platform_demo_request_append_only_mutation();

    insert into permissions (code, description) values
      ('platform.leads.read', 'View public website demo requests'),
      ('platform.leads.manage', 'Manage public website demo request workflow')
    on conflict (code) do update set description = excluded.description;
    insert into role_permissions (role_id, permission_code)
    select r.id, p.code from roles r cross join (values ('platform.leads.read'), ('platform.leads.manage')) p(code)
    where r.company_id is null and lower(r.code) = 'platform_super_admin'
    on conflict do nothing;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions where permission_code in ('platform.leads.read','platform.leads.manage');
    delete from permissions where code in ('platform.leads.read','platform.leads.manage');
    drop table platform_demo_request_notes;
    drop table platform_demo_request_history;
    drop table platform_demo_requests;
    drop function reject_platform_demo_request_append_only_mutation();
    drop sequence platform_demo_request_reference_seq;
  `.execute(database);
}
