import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Shared Commerce Foundation Prompt 3A: the marketplace Customer identity and
 * authentication foundation.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS WIDENS `accounts_scope_check` RATHER THAN ADDING A SECOND TABLE
 * ---------------------------------------------------------------------------
 *
 * `accounts_scope_check` (added in `20260713230000_core_tenancy_security.ts`)
 * currently allows `company_id IS NULL` for exactly one kind:
 * `platform_administrator`. Every other kind -- `company_user`, `trader`,
 * `driver` -- is REQUIRED to have a Company. A marketplace Customer has no
 * Company at all, by design (§4 of the prompt), so it needs the same
 * Company-less shape Platform Administrators already have -- not a
 * duplicate `accounts`-like table.
 *
 * This is a NARROW widening, not a relaxation: `company_id` stays mandatory
 * for `company_user`/`trader`/`driver` exactly as before. Only
 * `platform_administrator` and now `customer` may have `company_id IS NULL`.
 * §59's database tests exist specifically to prove this narrowness.
 *
 * ---------------------------------------------------------------------------
 * WHY `commerce_customers`/`commerce_customer_addresses` ARE SEPARATE FROM
 * THE EXISTING `customers`/`customer_addresses` TABLES
 * ---------------------------------------------------------------------------
 *
 * `customers`/`customer_addresses` are Delivery-domain, Company-owned
 * recipient records created by Company staff -- operational data, not login
 * accounts (§3). Neither table is touched by this migration: no column
 * added, no constraint changed, `company_id` stays NOT NULL on both. A
 * marketplace Customer is a completely different identity -- the account
 * that logs into `store.bluelinegpt.com` -- and gets its own tables so the
 * two concepts can never be confused or accidentally merged.
 *
 * `commerce_customers`/`commerce_customer_addresses` mirror the existing
 * account→profile shape used by Trader/Driver (`accounts` for login,
 * a separate domain table for the business profile), just Company-less.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table accounts drop constraint accounts_kind_check;
    alter table accounts add constraint accounts_kind_check
      check (account_kind in ('platform_administrator', 'company_user', 'trader', 'driver', 'customer'));

    alter table accounts drop constraint accounts_scope_check;
    alter table accounts add constraint accounts_scope_check check (
      (account_kind in ('platform_administrator', 'customer') and company_id is null)
      or (account_kind not in ('platform_administrator', 'customer') and company_id is not null)
    );

    -- Defence in depth: a Customer account with no mobile number is not a
    -- state the registration flow should ever produce (§18: mobile is
    -- required), so this is enforced at the schema level too, the same way
    -- accounts_mobile_format already enforces UAE mobile shape generically.
    alter table accounts add constraint accounts_customer_mobile_required
      check (account_kind <> 'customer' or mobile_number is not null);

    -- Global (Company-less) uniqueness for the Customer identifier space.
    -- The existing partial unique indexes for company_id IS NULL accounts
    -- (accounts_platform_normalized_username_unique) already cover
    -- username uniqueness across Platform Administrators AND Customers
    -- together, which is a strictly SAFE (stricter) outcome -- so no new
    -- username index is needed. Mobile/email have no company_id-IS-NULL
    -- index at all today (Platform Administrators never set them), so
    -- Customer-only partial indexes are added here rather than reusing or
    -- widening the Company-scoped ones.
    create unique index accounts_customer_normalized_mobile_unique
      on accounts (normalized_mobile_number)
      where company_id is null and account_kind = 'customer' and normalized_mobile_number is not null;

    create unique index accounts_customer_normalized_email_unique
      on accounts (normalized_email)
      where company_id is null and account_kind = 'customer' and normalized_email is not null;

    create table commerce_customers (
      id uuid primary key default gen_random_uuid(),
      account_id uuid not null,
      name text not null,
      mobile_number text not null,
      email text,
      preferred_language text not null default 'en',
      status text not null default 'active',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      constraint commerce_customers_account_fk
        foreign key (account_id) references accounts (id) on delete restrict,
      -- One Account -> at most one Commerce Customer.
      constraint commerce_customers_account_unique unique (account_id),
      constraint commerce_customers_status_check check (status in ('active', 'disabled')),
      constraint commerce_customers_language_check check (preferred_language in ('en', 'ar')),
      constraint commerce_customers_name_nonempty check (btrim(name) <> ''),
      constraint commerce_customers_mobile_format check (mobile_number ~ '^9715[0-9]{8}$'),
      constraint commerce_customers_version_positive check (version > 0)
    );

    -- Enforces §11's DB-level half: the linked Account must actually be a
    -- Company-less Customer account, not any other kind. Mirrors the
    -- enforce_account_security_scope() pattern already used by
    -- password_reset_tokens_scope_guard -- a small trigger checking the
    -- linked Account's shape rather than duplicating it into a CHECK that
    -- cannot reference another table.
    create function enforce_commerce_customer_account_scope()
      returns trigger language plpgsql as $$
      declare linked_kind text; linked_company uuid;
      begin
        select account_kind, company_id into linked_kind, linked_company
          from accounts where id = new.account_id;
        if linked_kind is distinct from 'customer' or linked_company is not null then
          raise exception 'commerce_customers.account_id must reference a Company-less customer account';
        end if;
        return new;
      end;
      $$;
    create trigger commerce_customers_account_scope_guard
      before insert or update of account_id on commerce_customers
      for each row execute function enforce_commerce_customer_account_scope();

    create table commerce_customer_addresses (
      id uuid primary key default gen_random_uuid(),
      commerce_customer_id uuid not null,
      label text,
      recipient_name text not null,
      mobile_number text not null,
      emirate text not null,
      area text,
      address text not null,
      location_link text,
      delivery_instructions text,
      is_default boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      constraint commerce_customer_addresses_customer_fk
        foreign key (commerce_customer_id) references commerce_customers (id) on delete cascade,
      constraint commerce_customer_addresses_mobile_format check (mobile_number ~ '^9715[0-9]{8}$'),
      constraint commerce_customer_addresses_recipient_nonempty check (btrim(recipient_name) <> ''),
      constraint commerce_customer_addresses_address_nonempty check (btrim(address) <> ''),
      constraint commerce_customer_addresses_version_positive check (version > 0)
    );

    -- At most one default Address per Customer (§16).
    create unique index commerce_customer_addresses_one_default
      on commerce_customer_addresses (commerce_customer_id)
      where is_default;

    create index commerce_customer_addresses_customer_index
      on commerce_customer_addresses (commerce_customer_id);
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop table if exists commerce_customer_addresses;
    drop trigger if exists commerce_customers_account_scope_guard on commerce_customers;
    drop function if exists enforce_commerce_customer_account_scope();
    drop table if exists commerce_customers;

    drop index if exists accounts_customer_normalized_email_unique;
    drop index if exists accounts_customer_normalized_mobile_unique;

    alter table accounts drop constraint if exists accounts_customer_mobile_required;

    alter table accounts drop constraint accounts_scope_check;
    alter table accounts add constraint accounts_scope_check check (
      (account_kind = 'platform_administrator' and company_id is null)
      or (account_kind <> 'platform_administrator' and company_id is not null)
    );

    alter table accounts drop constraint accounts_kind_check;
    alter table accounts add constraint accounts_kind_check
      check (account_kind in ('platform_administrator', 'company_user', 'trader', 'driver'));
  `.execute(database);
}
