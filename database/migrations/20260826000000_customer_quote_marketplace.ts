import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create sequence platform_customer_quote_reference_seq;
    create sequence platform_customer_offer_reference_seq;

    create table platform_customer_marketplace_settings (
      id boolean primary key default true check (id),
      enabled boolean not null default true,
      commission_rate numeric(7,6) not null default 0.150000 check (commission_rate between 0 and 1),
      quote_expiry_minutes integer not null default 30 check (quote_expiry_minutes between 1 and 1440),
      effective_from timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      updated_by_account_id uuid references accounts(id) on delete set null
    );
    insert into platform_customer_marketplace_settings(id) values(true);

    create table company_customer_quote_participation (
      company_id uuid primary key references companies(id) on delete restrict,
      participates boolean not null default false,
      accepts_instant boolean not null default false,
      accepts_custom boolean not null default false,
      marketplace_priority integer not null default 100 check (marketplace_priority between 1 and 1000),
      active_from date not null default current_date,
      active_until date,
      updated_at timestamptz not null default now(),
      updated_by_account_id uuid references accounts(id) on delete set null,
      check (active_until is null or active_until >= active_from),
      check (participates or (not accepts_instant and not accepts_custom))
    );

    create table company_customer_quote_pricing_profiles (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      name text not null check (char_length(name) between 2 and 160),
      status text not null default 'draft' check (status in ('draft','active','inactive','expired')),
      service_type text not null check (service_type in ('standard','same_day','express')),
      currency text not null default 'AED' check (currency='AED'),
      effective_from date not null,
      effective_to date,
      max_cod_amount numeric(12,2) check (max_cod_amount is null or max_cod_amount >= 0),
      max_weight_kg numeric(10,3) check (max_weight_kg is null or max_weight_kg > 0),
      max_length_cm numeric(10,2) check (max_length_cm is null or max_length_cm > 0),
      max_width_cm numeric(10,2) check (max_width_cm is null or max_width_cm > 0),
      max_height_cm numeric(10,2) check (max_height_cm is null or max_height_cm > 0),
      supported_package_types text[] not null default array['document','small_parcel','medium_parcel','large_parcel','box','fragile_item','food','electronics','clothing','other'],
      custom_quote_above_limits boolean not null default true,
      created_at timestamptz not null default now(),
      created_by_account_id uuid references accounts(id) on delete set null,
      updated_at timestamptz not null default now(),
      updated_by_account_id uuid references accounts(id) on delete set null,
      check (effective_to is null or effective_to >= effective_from),
      unique(company_id,name)
    );
    create index company_customer_quote_profiles_active_idx on company_customer_quote_pricing_profiles(company_id,status,effective_from,effective_to);

    create table company_customer_quote_pricing_rules (
      id uuid primary key default gen_random_uuid(),
      pricing_profile_id uuid not null references company_customer_quote_pricing_profiles(id) on delete restrict,
      pickup_emirate text not null,
      pickup_area text,
      delivery_emirate text not null,
      delivery_area text,
      base_price numeric(12,2) not null check (base_price > 0),
      included_weight_kg numeric(10,3) not null default 1 check (included_weight_kg >= 0),
      extra_weight_price numeric(12,2) check (extra_weight_price is null or extra_weight_price >= 0),
      cod_surcharge numeric(12,2) not null default 0 check (cod_surcharge >= 0),
      minimum_charge numeric(12,2) check (minimum_charge is null or minimum_charge > 0),
      maximum_standard_weight numeric(10,3) check (maximum_standard_weight is null or maximum_standard_weight > 0),
      active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(pricing_profile_id,pickup_emirate,pickup_area,delivery_emirate,delivery_area)
    );
    create index company_customer_quote_rules_match_idx on company_customer_quote_pricing_rules(pricing_profile_id,pickup_emirate,delivery_emirate,active);

    create table platform_customer_quote_requests (
      id uuid primary key default gen_random_uuid(),
      reference_number text not null unique,
      public_access_token_hash text not null unique,
      requester_name text not null, requester_mobile text not null, requester_email text,
      guest_customer boolean not null default true,
      pickup_emirate text not null, pickup_area text not null, pickup_address text not null,
      pickup_contact_name text not null, pickup_mobile text not null, pickup_building text, pickup_unit text,
      pickup_landmark text, pickup_maps_url text, pickup_instructions text,
      delivery_emirate text not null, delivery_area text not null, delivery_address text not null,
      recipient_name text not null, recipient_mobile text not null, delivery_building text, delivery_unit text,
      delivery_landmark text, delivery_maps_url text, delivery_instructions text,
      package_type text not null, description text not null, weight_kg numeric(10,3) not null check(weight_kg > 0),
      length_cm numeric(10,2), width_cm numeric(10,2), height_cm numeric(10,2), quantity integer not null default 1 check(quantity between 1 and 100),
      package_photo_storage_key text, package_photo_content_type text, package_photo_size_bytes integer,
      requested_service_type text not null check(requested_service_type in ('standard','same_day','express')),
      pickup_date date not null, pickup_time_window text,
      cod_required boolean not null default false, cod_amount numeric(12,2) not null default 0 check(cod_amount >= 0),
      special_handling_flags text[] not null default '{}', goods_confirmation boolean not null,
      quote_type text not null check(quote_type in ('instant','custom_required','unavailable')),
      status text not null check(status in ('submitted','quoted','custom_quote_required','customer_selected','booking_pending','booked','expired','cancelled','closed')),
      custom_quote_reason text, selected_offer_id uuid,
      payment_required boolean not null default false,
      payment_status text not null default 'not_required' check(payment_status in ('not_required','pending','paid','failed','refunded')),
      payment_provider text, payment_reference text,
      source text not null default 'public_website', landing_page text not null default '/send-a-package', referrer text,
      utm_source text, utm_medium text, utm_campaign text, utm_term text, utm_content text,
      submission_fingerprint text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
    );
    create index platform_customer_quotes_created_idx on platform_customer_quote_requests(created_at desc);
    create index platform_customer_quotes_filter_idx on platform_customer_quote_requests(status,quote_type,pickup_emirate,delivery_emirate);
    create index platform_customer_quotes_search_idx on platform_customer_quote_requests(requester_mobile,recipient_mobile);
    create unique index platform_customer_quotes_recent_fingerprint_idx on platform_customer_quote_requests(submission_fingerprint,created_at);

    create table platform_customer_quote_offers (
      id uuid primary key default gen_random_uuid(),
      public_offer_id text not null unique,
      quote_request_id uuid not null references platform_customer_quote_requests(id) on delete restrict,
      company_id uuid not null references companies(id) on delete restrict,
      pricing_profile_id uuid references company_customer_quote_pricing_profiles(id) on delete restrict,
      pricing_rule_id uuid references company_customer_quote_pricing_rules(id) on delete restrict,
      service_type text not null check(service_type in ('standard','same_day','express')),
      gross_customer_price numeric(12,2) not null check(gross_customer_price > 0),
      commission_rate numeric(7,6) not null check(commission_rate between 0 and 1),
      commission_amount numeric(12,2) not null check(commission_amount >= 0),
      company_net_amount numeric(12,2) not null check(company_net_amount >= 0),
      currency text not null default 'AED' check(currency='AED'),
      status text not null default 'available' check(status in ('available','selected','expired','withdrawn')),
      source text not null default 'instant' check(source in ('instant','manual_custom')),
      expires_at timestamptz not null, published_at timestamptz not null default now(),
      internal_notes text, created_at timestamptz not null default now(),
      check(gross_customer_price = commission_amount + company_net_amount)
    );
    alter table platform_customer_quote_requests add constraint platform_customer_quotes_selected_offer_fk foreign key(selected_offer_id) references platform_customer_quote_offers(id) on delete restrict;
    create index platform_customer_quote_offers_request_idx on platform_customer_quote_offers(quote_request_id,status,gross_customer_price);
    create index platform_customer_quote_offers_company_idx on platform_customer_quote_offers(company_id,created_at desc);

    create table platform_customer_quote_history (
      id uuid primary key default gen_random_uuid(), quote_request_id uuid not null references platform_customer_quote_requests(id) on delete restrict,
      event_type text not null, old_status text, new_status text, actor_account_id uuid references accounts(id) on delete set null,
      notes text, detail jsonb not null default '{}', created_at timestamptz not null default now()
    );
    create table platform_customer_quote_notes (
      id uuid primary key default gen_random_uuid(), quote_request_id uuid not null references platform_customer_quote_requests(id) on delete restrict,
      author_account_id uuid references accounts(id) on delete set null, note text not null check(char_length(note) between 1 and 4000), created_at timestamptz not null default now()
    );
    create function reject_customer_quote_append_only_mutation() returns trigger language plpgsql as $$ begin raise exception '% is append-only',tg_table_name using errcode='55000'; end; $$;
    create trigger customer_quote_history_append_only before update or delete on platform_customer_quote_history for each row execute function reject_customer_quote_append_only_mutation();
    create trigger customer_quote_notes_append_only before update or delete on platform_customer_quote_notes for each row execute function reject_customer_quote_append_only_mutation();

    insert into permissions(code,description) values
      ('customer_quotes.read','View Company customer quote opportunities'),
      ('customer_quote_pricing.manage','Manage Company customer quote participation and pricing'),
      ('platform.customer_quotes.read','View customer quote requests'),
      ('platform.customer_quotes.manage','Manage customer quote requests and manual offers'),
      ('platform.customer_marketplace.manage','Manage customer marketplace commission and expiry')
    on conflict(code) do update set description=excluded.description;
    insert into role_permissions(role_id,permission_code)
      select r.id,p.code from roles r cross join(values('platform.customer_quotes.read'),('platform.customer_quotes.manage'),('platform.customer_marketplace.manage'))p(code)
      where r.company_id is null and lower(r.code)='platform_super_admin' on conflict do nothing;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop table platform_customer_quote_notes; drop table platform_customer_quote_history; alter table platform_customer_quote_requests drop constraint platform_customer_quotes_selected_offer_fk; drop table platform_customer_quote_offers; drop table platform_customer_quote_requests; drop table company_customer_quote_pricing_rules; drop table company_customer_quote_pricing_profiles; drop table company_customer_quote_participation; drop table platform_customer_marketplace_settings; drop function reject_customer_quote_append_only_mutation(); drop sequence platform_customer_offer_reference_seq; drop sequence platform_customer_quote_reference_seq;`.execute(database);
}
