import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table companies (
      id uuid primary key default gen_random_uuid(),
      code text not null,
      subdomain text not null,
      name_en text not null,
      name_ar text,
      address_en text,
      address_ar text,
      telephone text,
      email text,
      logo_file_id uuid,
      trade_license_number text,
      trade_license_expiry_date date,
      tax_registration_number text,
      status text not null default 'disabled',
      activated_at timestamptz,
      disabled_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      constraint companies_code_nonempty check (btrim(code) <> ''),
      constraint companies_subdomain_format check (subdomain ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
      constraint companies_status_check check (status in ('active', 'disabled')),
      constraint companies_version_positive check (version > 0)
    );

    create unique index companies_code_unique on companies (lower(code));
    create unique index companies_subdomain_unique on companies (lower(subdomain));

    create table company_settings (
      company_id uuid primary key references companies(id) on delete restrict,
      base_currency char(3) not null default 'AED',
      default_language text not null default 'en',
      timezone text not null default 'Asia/Dubai',
      vat_enabled boolean not null default false,
      vat_rate numeric(7,4),
      vat_price_mode text,
      order_pending_alert_hours integer,
      document_expiry_alert_days integer,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      constraint company_settings_currency_aed check (base_currency = 'AED'),
      constraint company_settings_language_check check (default_language in ('en', 'ar')),
      constraint company_settings_vat_rate_check check (vat_rate is null or (vat_rate >= 0 and vat_rate <= 100)),
      constraint company_settings_vat_mode_check check (vat_price_mode is null or vat_price_mode in ('inclusive', 'exclusive')),
      constraint company_settings_vat_consistency check (
        (vat_enabled and vat_rate is not null and vat_price_mode is not null)
        or (not vat_enabled)
      ),
      constraint company_settings_order_alert_positive check (order_pending_alert_hours is null or order_pending_alert_hours > 0),
      constraint company_settings_document_alert_positive check (document_expiry_alert_days is null or document_expiry_alert_days > 0),
      constraint company_settings_version_positive check (version > 0)
    );

    create table company_bank_accounts (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      bank_name text not null,
      account_name text not null,
      account_number_masked text,
      iban text,
      swift_code text,
      currency char(3) not null default 'AED',
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      constraint company_bank_accounts_currency_aed check (currency = 'AED'),
      constraint company_bank_accounts_version_positive check (version > 0)
    );
    create unique index company_bank_accounts_iban_unique
      on company_bank_accounts (company_id, upper(iban)) where iban is not null;

    create table accounts (
      id uuid primary key default gen_random_uuid(),
      company_id uuid references companies(id) on delete restrict,
      account_kind text not null,
      username text not null,
      password_hash text not null,
      status text not null default 'active',
      preferred_language text not null default 'en',
      failed_login_attempts integer not null default 0,
      locked_until timestamptz,
      password_changed_at timestamptz,
      last_login_at timestamptz,
      deactivated_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique nulls not distinct (id, company_id),
      constraint accounts_kind_check check (account_kind in ('platform_administrator', 'company_user', 'trader', 'driver')),
      constraint accounts_scope_check check (
        (account_kind = 'platform_administrator' and company_id is null)
        or (account_kind <> 'platform_administrator' and company_id is not null)
      ),
      constraint accounts_status_check check (status in ('active', 'disabled', 'locked')),
      constraint accounts_language_check check (preferred_language in ('en', 'ar')),
      constraint accounts_failed_attempts_check check (failed_login_attempts >= 0 and failed_login_attempts <= 5),
      constraint accounts_username_nonempty check (btrim(username) <> ''),
      constraint accounts_password_hash_nonempty check (btrim(password_hash) <> ''),
      constraint accounts_version_positive check (version > 0)
    );
    create unique index accounts_company_username_unique
      on accounts (company_id, lower(username)) where company_id is not null;
    create unique index accounts_platform_username_unique
      on accounts (lower(username)) where company_id is null;
    create index accounts_company_status_index on accounts (company_id, status);

    create table permissions (
      code text primary key,
      description text not null,
      created_at timestamptz not null default now(),
      constraint permissions_code_format check (code ~ '^[a-z][a-z0-9_.]*$')
    );

    create table roles (
      id uuid primary key default gen_random_uuid(),
      company_id uuid references companies(id) on delete restrict,
      code text not null,
      name text not null,
      is_system boolean not null default false,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique nulls not distinct (id, company_id),
      constraint roles_code_format check (code ~ '^[a-z][a-z0-9_]*$'),
      constraint roles_version_positive check (version > 0)
    );
    create unique index roles_company_code_unique
      on roles (company_id, lower(code)) where company_id is not null;
    create unique index roles_platform_code_unique
      on roles (lower(code)) where company_id is null;

    create table role_permissions (
      role_id uuid not null references roles(id) on delete restrict,
      permission_code text not null references permissions(code) on delete restrict,
      created_at timestamptz not null default now(),
      primary key (role_id, permission_code)
    );

    create table account_roles (
      account_id uuid not null references accounts(id) on delete restrict,
      role_id uuid not null references roles(id) on delete restrict,
      company_id uuid,
      assigned_by_account_id uuid references accounts(id) on delete restrict,
      created_at timestamptz not null default now(),
      primary key (account_id, role_id),
      constraint account_roles_account_scope_fk foreign key (account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint account_roles_role_scope_fk foreign key (role_id, company_id)
        references roles(id, company_id) on delete restrict
    );

    create table company_users (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      account_id uuid not null,
      name_en text not null,
      name_ar text,
      email text,
      mobile_number text,
      notes text,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deactivated_at timestamptz,
      version bigint not null default 1,
      unique (id, company_id),
      unique (account_id),
      constraint company_users_account_fk foreign key (account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint company_users_version_positive check (version > 0)
    );
    create index company_users_company_active_index on company_users (company_id, is_active);

    create table employees (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      company_user_id uuid,
      employee_number text,
      name_en text not null,
      name_ar text,
      mobile_number text,
      address text,
      basic_salary numeric(18,2) not null default 0,
      is_active boolean not null default true,
      hired_on date,
      ended_on date,
      notes text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deactivated_at timestamptz,
      version bigint not null default 1,
      unique (id, company_id),
      constraint employees_company_user_fk foreign key (company_user_id, company_id)
        references company_users(id, company_id) on delete restrict,
      constraint employees_basic_salary_nonnegative check (basic_salary >= 0),
      constraint employees_dates_check check (ended_on is null or hired_on is null or ended_on >= hired_on),
      constraint employees_version_positive check (version > 0)
    );
    create unique index employees_number_unique
      on employees (company_id, lower(employee_number)) where employee_number is not null;

    create table file_objects (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      storage_provider text not null,
      storage_key text not null,
      original_filename text not null,
      media_type text not null,
      size_bytes bigint not null,
      sha256 text,
      classification text not null default 'private',
      scan_status text not null default 'pending',
      uploaded_by_account_id uuid,
      created_at timestamptz not null default now(),
      deleted_at timestamptz,
      unique (id, company_id),
      unique (storage_provider, storage_key),
      constraint file_objects_uploader_fk foreign key (uploaded_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint file_objects_size_check check (size_bytes >= 0 and size_bytes <= 10485760),
      constraint file_objects_classification_check check (classification in ('private', 'sensitive_identity', 'generated_document')),
      constraint file_objects_scan_status_check check (scan_status in ('pending', 'clean', 'rejected', 'failed')),
      constraint file_objects_sha256_check check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$')
    );
    create index file_objects_company_created_index on file_objects (company_id, created_at desc);

    alter table companies add constraint companies_logo_fk
      foreign key (logo_file_id, id) references file_objects(id, company_id) on delete restrict;

    create table company_reference_counters (
      company_id uuid not null references companies(id) on delete restrict,
      reference_type text not null,
      next_value bigint not null default 1,
      prefix text not null,
      updated_at timestamptz not null default now(),
      primary key (company_id, reference_type),
      constraint company_reference_counters_type_check check (
        reference_type in ('order', 'payment', 'reconciliation', 'settlement', 'journal', 'payroll', 'import')
      ),
      constraint company_reference_counters_value_positive check (next_value > 0),
      constraint company_reference_counters_prefix_format check (prefix ~ '^[A-Z0-9-]{1,12}$')
    );

    create table idempotency_records (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      operation text not null,
      idempotency_key text not null,
      request_hash text not null,
      response_status integer,
      resource_type text,
      resource_id uuid,
      completed_at timestamptz,
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      unique (company_id, operation, idempotency_key),
      constraint idempotency_records_status_check check (response_status is null or response_status between 100 and 599),
      constraint idempotency_records_expiry_check check (expires_at > created_at)
    );
    create index idempotency_records_expiry_index on idempotency_records (expires_at);

    create table audit_events (
      id uuid primary key default gen_random_uuid(),
      company_id uuid references companies(id) on delete restrict,
      actor_account_id uuid references accounts(id) on delete restrict,
      action text not null,
      subject_type text not null,
      subject_id text,
      reason text,
      before_data jsonb,
      after_data jsonb,
      correlation_id text not null,
      ip_address inet,
      user_agent text,
      occurred_at timestamptz not null default now(),
      constraint audit_events_action_nonempty check (btrim(action) <> ''),
      constraint audit_events_subject_nonempty check (btrim(subject_type) <> ''),
      constraint audit_events_correlation_nonempty check (btrim(correlation_id) <> '')
    );
    create index audit_events_company_time_index on audit_events (company_id, occurred_at desc);
    create index audit_events_subject_index on audit_events (company_id, subject_type, subject_id, occurred_at desc);
    create index audit_events_actor_index on audit_events (actor_account_id, occurred_at desc);

    create function reject_audit_mutation() returns trigger language plpgsql as $$
    begin
      raise exception 'audit events are append-only';
    end;
    $$;

    create trigger audit_events_immutable
      before update or delete on audit_events
      for each row execute function reject_audit_mutation();
  `.execute(database);
}
