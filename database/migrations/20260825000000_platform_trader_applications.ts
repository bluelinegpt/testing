import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create sequence platform_trader_application_reference_seq;
    create table platform_trader_applications (
      id uuid primary key default gen_random_uuid(), reference_number text not null unique,
      store_name text not null check (char_length(store_name) between 2 and 200), legal_company_name text,
      contact_person text not null check (char_length(contact_person) between 2 and 160), mobile_number text not null check (mobile_number ~ '^\\+971[0-9]{9}$'),
      email text not null check (char_length(email)<=254), trade_license_number text, trade_license_expiry_date date, website text, business_description text,
      primary_category text not null, additional_categories text[] not null default '{}', other_category text,
      pickup_emirate text not null check (pickup_emirate in ('abu_dhabi','dubai','sharjah','ajman','umm_al_quwain','ras_al_khaimah','fujairah')),
      pickup_area text not null check (char_length(pickup_area) between 2 and 160), monthly_order_range text not null,
      delivery_emirates text[] not null, payment_mix text not null check(payment_mix in ('mostly_cod','mostly_prepaid','mixed','not_sure')),
      cod_percentage integer check(cod_percentage is null or cod_percentage between 0 and 100), average_package_size text, average_package_weight numeric(10,2),
      fragile_products boolean not null default false, temperature_controlled boolean not null default false, special_handling_notes text,
      has_existing_delivery_company boolean not null, requires_delivery_company boolean not null,
      existing_delivery_company_name text, existing_delivery_company_contact text, existing_delivery_company_mobile text, existing_delivery_company_email text,
      existing_delivery_company_reference text, existing_delivery_company_notes text,
      resolved_company_id uuid references companies(id) on delete set null, resolved_by_account_id uuid references accounts(id) on delete set null, resolved_at timestamptz,
      status text not null default 'pending_verification' check(status in ('pending_verification','reviewing','contacted','information_required','verified','approved','rejected','withdrawn')),
      delivery_relationship_status text not null default 'unresolved' check(delivery_relationship_status in ('unresolved','matching_required','relationship_verified','delivery_company_not_onboarded','connected')),
      assigned_to uuid references accounts(id) on delete set null, verified_at timestamptz, approved_at timestamptz, rejected_at timestamptz, rejection_reason text,
      converted_trader_id uuid references trader_commerce_profiles(id) on delete set null,
      source text not null default 'public_website', landing_page text not null, referrer text, utm_source text, utm_medium text, utm_campaign text, utm_term text, utm_content text,
      submission_fingerprint text not null check(submission_fingerprint ~ '^[a-f0-9]{64}$'), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
      check(requires_delivery_company = not has_existing_delivery_company),
      check((has_existing_delivery_company and existing_delivery_company_name is not null) or (not has_existing_delivery_company and existing_delivery_company_name is null))
    );
    create index platform_trader_applications_created_idx on platform_trader_applications(created_at desc);
    create index platform_trader_applications_status_idx on platform_trader_applications(status,created_at desc);
    create index platform_trader_applications_matching_idx on platform_trader_applications(requires_delivery_company,status);
    create index platform_trader_applications_fingerprint_idx on platform_trader_applications(submission_fingerprint,created_at desc);

    create table platform_trader_application_channels (
      id uuid primary key default gen_random_uuid(), application_id uuid not null references platform_trader_applications(id) on delete restrict,
      channel_type text not null check(channel_type in ('salla','shopify','woocommerce','website','instagram','facebook','tiktok','whatsapp','physical_store','other','none')),
      external_url text, handle text, created_at timestamptz not null default now(), unique(application_id,channel_type)
    );
    create index platform_trader_application_channels_app_idx on platform_trader_application_channels(application_id);
    create table platform_trader_application_history (
      id uuid primary key default gen_random_uuid(), application_id uuid not null references platform_trader_applications(id) on delete restrict,
      event_type text not null, old_status text, new_status text, actor_account_id uuid references accounts(id) on delete set null,
      notes text, detail jsonb not null default '{}', created_at timestamptz not null default now()
    );
    create index platform_trader_application_history_app_idx on platform_trader_application_history(application_id,created_at);
    create table platform_trader_application_notes (
      id uuid primary key default gen_random_uuid(), application_id uuid not null references platform_trader_applications(id) on delete restrict,
      author_account_id uuid references accounts(id) on delete set null, note text not null check(char_length(note) between 1 and 4000), created_at timestamptz not null default now()
    );
    create index platform_trader_application_notes_app_idx on platform_trader_application_notes(application_id,created_at);
    create function reject_platform_trader_application_append_only_mutation() returns trigger language plpgsql as $$ begin raise exception '% is append-only',tg_table_name using errcode='55000'; end; $$;
    create trigger platform_trader_application_history_append_only before update or delete on platform_trader_application_history for each row execute function reject_platform_trader_application_append_only_mutation();
    create trigger platform_trader_application_notes_append_only before update or delete on platform_trader_application_notes for each row execute function reject_platform_trader_application_append_only_mutation();
    insert into permissions(code,description) values
      ('platform.trader_applications.read','View Trader self-registration applications'),
      ('platform.trader_applications.manage','Manage Trader self-registration applications') on conflict(code) do update set description=excluded.description;
    insert into role_permissions(role_id,permission_code) select r.id,p.code from roles r cross join(values('platform.trader_applications.read'),('platform.trader_applications.manage'))p(code)
      where r.company_id is null and lower(r.code)='platform_super_admin' on conflict do nothing;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`delete from role_permissions where permission_code in ('platform.trader_applications.read','platform.trader_applications.manage'); delete from permissions where code in ('platform.trader_applications.read','platform.trader_applications.manage'); drop table platform_trader_application_notes; drop table platform_trader_application_history; drop table platform_trader_application_channels; drop table platform_trader_applications; drop function reject_platform_trader_application_append_only_mutation(); drop sequence platform_trader_application_reference_seq;`.execute(database);
}
