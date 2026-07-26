import { type Kysely, sql } from "kysely";

/**
 * Trader pricing, redesigned as a flat Emirate + Area hierarchy.
 *
 * Replaces the effective-dated, dual-headed `trader_pricing` + `trader_area_prices`
 * model with a single `trader_service_prices` table. Each row is one price:
 *
 *   emirate_id  area_id   meaning
 *   ----------  --------  ---------------------------------------------
 *   set         set       a specific Area
 *   set         null      all Areas in that Emirate
 *   null        null      all Emirates and Areas (one global/flat price)
 *
 * Resolution walks most-specific to least-specific: exact Area, then the
 * Emirate default, then the global row. "Flat pricing" is simply the global
 * row, so there is no separate flat/by-area mode and no effective dates.
 *
 * Safe to drop the old tables and repoint the orders snapshot because this runs
 * against an empty operational database (0 pricing rows, 0 orders); the
 * migration aborts if that assumption is violated.
 */
export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    do $$
    declare pricing_rows bigint; order_rows bigint;
    begin
      select count(*) into pricing_rows from trader_pricing;
      select count(*) into order_rows from orders;
      if pricing_rows > 0 or order_rows > 0 then
        raise exception
          'Refusing to redesign pricing: % pricing row(s) and % order(s) exist. A data migration is required first.',
          pricing_rows, order_rows
          using errcode = 'data_exception';
      end if;
    end $$;
  `.execute(database);

  await sql`
    create table trader_service_prices (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      trader_id uuid not null,
      emirate_id uuid references emirates(id) on delete restrict,
      area_id uuid,
      service_fee numeric(18,2) not null,
      reason text,
      created_by_account_id uuid not null,
      updated_by_account_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      constraint trader_service_prices_trader_fk
        foreign key (trader_id, company_id) references traders (id, company_id) on delete restrict,
      constraint trader_service_prices_area_fk
        foreign key (area_id, company_id) references areas (id, company_id) on delete restrict,
      constraint trader_service_prices_creator_fk
        foreign key (created_by_account_id, company_id) references accounts (id, company_id),
      constraint trader_service_prices_updater_fk
        foreign key (updated_by_account_id, company_id) references accounts (id, company_id),
      constraint trader_service_prices_fee_nonnegative check (service_fee >= 0),
      -- An Area cannot be named without its Emirate; the global row has neither.
      constraint trader_service_prices_area_needs_emirate
        check (area_id is null or emirate_id is not null),
      constraint trader_service_prices_reason_nonempty
        check (reason is null or btrim(reason) <> ''),
      constraint trader_service_prices_version_positive check (version > 0)
    );
  `.execute(database);

  // At most one price per (trader, Emirate scope, Area scope). NULLS NOT
  // DISTINCT makes two global rows, or two Emirate-defaults, collide.
  await sql`
    create unique index trader_service_prices_scope_unique
      on trader_service_prices (company_id, trader_id, emirate_id, area_id)
      nulls not distinct;
    create index trader_service_prices_lookup
      on trader_service_prices (company_id, trader_id);
  `.execute(database);

  // A named Area must belong to the named Emirate, so a price can never point
  // at an Area in the wrong Emirate.
  await sql`
    create or replace function enforce_trader_price_area_emirate() returns trigger as $$
    declare area_emirate uuid;
    begin
      if new.area_id is null then
        return new;
      end if;
      select emirate_id into area_emirate from areas where id = new.area_id;
      if area_emirate is distinct from new.emirate_id then
        raise exception 'Area does not belong to the selected Emirate'
          using errcode = 'check_violation';
      end if;
      return new;
    end;
    $$ language plpgsql;

    create trigger trader_service_prices_area_emirate_guard
      before insert or update on trader_service_prices
      for each row execute function enforce_trader_price_area_emirate();
  `.execute(database);

  // Prices are history: they are edited and disabled, never hard-deleted, so an
  // order's fee snapshot always resolves back to a real row.
  await sql`
    create or replace function reject_trader_service_price_delete() returns trigger as $$
    begin
      raise exception 'Trader pricing cannot be deleted' using errcode = 'restrict_violation';
    end;
    $$ language plpgsql;

    create trigger trader_service_prices_delete_guard
      before delete on trader_service_prices
      for each row execute function reject_trader_service_price_delete();
  `.execute(database);

  // --- Repoint the orders pricing snapshot at the new single table ----------
  await sql`
    drop trigger if exists orders_pricing_provenance_immutable on orders;
    alter table orders drop constraint if exists orders_pricing_provenance_check;
    alter table orders drop constraint if exists orders_trader_pricing_fk;
    alter table orders drop constraint if exists orders_trader_area_price_fk;
    alter table orders drop column if exists trader_pricing_id;
    alter table orders drop column if exists trader_area_price_id;
    alter table orders drop column if exists pricing_type_snapshot;
  `.execute(database);

  await sql`
    alter table orders
      add column trader_service_price_id uuid,
      add constraint orders_trader_service_price_fk
        foreign key (trader_service_price_id, company_id)
        references trader_service_prices (id, company_id) on delete restrict;
  `.execute(database);

  /*
   * provenance status:
   *   resolved            - matched a configured price (trader_service_price_id set)
   *   manual              - operator entered a fee because no price was configured
   *   legacy_unattributed - pre-existing rows (none today; kept for symmetry)
   */
  await sql`
    alter table orders add constraint orders_pricing_provenance_check check (
      (
        pricing_provenance_status = 'legacy_unattributed'
        and trader_service_price_id is null
        and configured_service_fee_snapshot is null
      )
      or (
        pricing_provenance_status = 'resolved'
        and trader_service_price_id is not null
        and configured_service_fee_snapshot is not null
        and configured_service_fee_snapshot >= 0
        and final_service_fee_snapshot >= 0
      )
      or (
        pricing_provenance_status = 'manual'
        and trader_service_price_id is null
        and configured_service_fee_snapshot is not null
        and configured_service_fee_snapshot >= 0
        and final_service_fee_snapshot >= 0
      )
    );
  `.execute(database);

  await sql`
    create or replace function protect_order_pricing_provenance() returns trigger as $$
    begin
      if new.pricing_provenance_status is distinct from old.pricing_provenance_status
         or new.trader_service_price_id is distinct from old.trader_service_price_id
         or new.configured_service_fee_snapshot is distinct from old.configured_service_fee_snapshot then
        raise exception 'Order pricing provenance is immutable' using errcode = 'restrict_violation';
      end if;
      return new;
    end;
    $$ language plpgsql;

    create trigger orders_pricing_provenance_immutable
      before update of pricing_provenance_status, trader_service_price_id, configured_service_fee_snapshot
      on orders
      for each row execute function protect_order_pricing_provenance();
  `.execute(database);

  // --- Remove the superseded pricing tables ---------------------------------
  await sql`
    drop trigger if exists trader_area_prices_delete_guard on trader_area_prices;
    drop trigger if exists trader_pricing_delete_guard on trader_pricing;
    drop table if exists trader_area_prices;
    drop table if exists trader_pricing;
    drop function if exists reject_pricing_delete();
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  // Recreate the previous tables in their post-20260717010000 shape.
  await sql`
    create table trader_pricing (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      trader_id uuid not null,
      pricing_method text not null,
      flat_service_fee numeric(18,2),
      effective_from date not null,
      effective_to date,
      is_active boolean not null default true,
      created_by_account_id uuid not null,
      updated_by_account_id uuid,
      change_reason text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      constraint trader_pricing_trader_fk
        foreign key (trader_id, company_id) references traders (id, company_id) on delete restrict,
      constraint trader_pricing_creator_fk
        foreign key (created_by_account_id, company_id) references accounts (id, company_id),
      constraint trader_pricing_updater_fk
        foreign key (updated_by_account_id, company_id) references accounts (id, company_id),
      constraint trader_pricing_method_check check (pricing_method in ('flat', 'by_area')),
      constraint trader_pricing_dates_check check (effective_to is null or effective_to >= effective_from),
      constraint trader_pricing_version_positive check (version > 0)
    );
    create table trader_area_prices (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      trader_pricing_id uuid not null,
      trader_id uuid,
      area_id uuid not null,
      service_fee numeric(18,2) not null,
      effective_from date,
      effective_to date,
      is_active boolean not null default true,
      created_by_account_id uuid,
      updated_by_account_id uuid,
      change_reason text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      unique (company_id, trader_pricing_id, area_id),
      constraint trader_area_prices_pricing_fk
        foreign key (trader_pricing_id, company_id) references trader_pricing (id, company_id),
      constraint trader_area_prices_area_fk
        foreign key (area_id, company_id) references areas (id, company_id),
      constraint trader_area_prices_fee_nonnegative check (service_fee >= 0),
      constraint trader_area_prices_version_positive check (version > 0)
    );
  `.execute(database);

  await sql`
    drop trigger if exists orders_pricing_provenance_immutable on orders;
    alter table orders drop constraint if exists orders_pricing_provenance_check;
    alter table orders drop constraint if exists orders_trader_service_price_fk;
    alter table orders drop column if exists trader_service_price_id;
    alter table orders
      add column trader_pricing_id uuid,
      add column trader_area_price_id uuid,
      add column pricing_type_snapshot text;
  `.execute(database);

  await sql`
    drop trigger if exists trader_service_prices_area_emirate_guard on trader_service_prices;
    drop trigger if exists trader_service_prices_delete_guard on trader_service_prices;
    drop function if exists enforce_trader_price_area_emirate();
    drop function if exists reject_trader_service_price_delete();
    drop table if exists trader_service_prices;
  `.execute(database);
}
