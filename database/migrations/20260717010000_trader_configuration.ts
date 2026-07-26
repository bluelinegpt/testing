import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create extension if not exists btree_gist;

    alter table company_reference_counters
      drop constraint company_reference_counters_type_check;
    alter table company_reference_counters
      add constraint company_reference_counters_type_check check (
        reference_type in (
          'order', 'payment', 'reconciliation', 'settlement', 'journal', 'payroll', 'import',
          'trader', 'area'
        )
      );

    insert into company_reference_counters (company_id, reference_type, next_value, prefix)
    select c.id, 'trader',
           coalesce((select max(substring(t.code from '^TRD-([0-9]{6})$')::bigint) + 1
                     from traders t where t.company_id = c.id and t.code ~ '^TRD-[0-9]{6}$'), 1),
           'TRD'
      from companies c
    on conflict (company_id, reference_type) do nothing;

    insert into company_reference_counters (company_id, reference_type, next_value, prefix)
    select c.id, 'area',
           coalesce((select max(substring(a.code from '^AREA-([0-9]{6})$')::bigint) + 1
                     from areas a where a.company_id = c.id and a.code ~ '^AREA-[0-9]{6}$'), 1),
           'AREA'
      from companies c
    on conflict (company_id, reference_type) do nothing;

    alter table traders
      add column second_mobile_number text,
      add column commercial_number text,
      add column tax_registration_number text,
      add column pickup_area_id uuid,
      add column location_link text,
      add column latitude numeric(9,6),
      add column longitude numeric(9,6),
      add column created_by_account_id uuid;
    alter table traders add constraint traders_pickup_area_fk
      foreign key (pickup_area_id, company_id) references areas(id, company_id) on delete restrict;
    alter table traders add constraint traders_created_by_fk
      foreign key (created_by_account_id, company_id) references accounts(id, company_id) on delete restrict;
    alter table traders add constraint traders_coordinates_check check (
      (latitude is null and longitude is null)
      or (latitude between -90 and 90 and longitude between -180 and 180)
    );

    create function protect_generated_business_code() returns trigger language plpgsql as $$
    begin
      if new.code is distinct from old.code then
        raise exception using errcode = '23514', message = 'Generated business codes are immutable';
      end if;
      return new;
    end;
    $$;
    create trigger traders_code_immutable before update of code on traders
      for each row execute function protect_generated_business_code();
    create trigger areas_code_immutable before update of code on areas
      for each row execute function protect_generated_business_code();

    create function validate_trader_mobile_change() returns trigger language plpgsql as $$
    begin
      if tg_op = 'INSERT' or new.mobile_number is distinct from old.mobile_number then
        if new.mobile_number !~ '^9715[0-9]{8}$' then
          raise exception using errcode = '23514',
            message = 'Enter the mobile number in the format 9715XXXXXXXX.';
        end if;
      end if;
      if new.second_mobile_number is not null
         and (tg_op = 'INSERT' or new.second_mobile_number is distinct from old.second_mobile_number)
         and new.second_mobile_number !~ '^9715[0-9]{8}$' then
        raise exception using errcode = '23514',
          message = 'Enter the second mobile number in the format 9715XXXXXXXX.';
      end if;
      return new;
    end;
    $$;
    create trigger traders_mobile_format_guard
      before insert or update of mobile_number, second_mobile_number on traders
      for each row execute function validate_trader_mobile_change();

    drop index trader_pricing_active_unique;
    alter table trader_pricing
      add column updated_by_account_id uuid,
      add column change_reason text;
    alter table trader_pricing add constraint trader_pricing_updater_fk
      foreign key (updated_by_account_id, company_id) references accounts(id, company_id) on delete restrict;
    alter table trader_pricing add constraint trader_pricing_reason_nonempty
      check (change_reason is null or btrim(change_reason) <> '');
    alter table trader_pricing add constraint trader_pricing_period_no_overlap
      exclude using gist (
        company_id with =,
        trader_id with =,
        daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
      ) where (is_active);

    alter table trader_area_prices
      add column trader_id uuid,
      add column effective_from date,
      add column effective_to date,
      add column is_active boolean not null default true,
      add column created_by_account_id uuid,
      add column updated_by_account_id uuid,
      add column change_reason text;
    update trader_area_prices tap
       set trader_id = tp.trader_id,
           effective_from = tp.effective_from,
           effective_to = tp.effective_to,
           created_by_account_id = tp.created_by_account_id
      from trader_pricing tp
     where tp.id = tap.trader_pricing_id and tp.company_id = tap.company_id;
    alter table trader_area_prices
      alter column trader_id set not null,
      alter column effective_from set not null,
      alter column created_by_account_id set not null;
    alter table trader_area_prices add constraint trader_area_prices_trader_fk
      foreign key (trader_id, company_id) references traders(id, company_id) on delete restrict;
    alter table trader_area_prices add constraint trader_area_prices_creator_fk
      foreign key (created_by_account_id, company_id) references accounts(id, company_id) on delete restrict;
    alter table trader_area_prices add constraint trader_area_prices_updater_fk
      foreign key (updated_by_account_id, company_id) references accounts(id, company_id) on delete restrict;
    alter table trader_area_prices add constraint trader_area_prices_dates_check
      check (effective_to is null or effective_to >= effective_from);
    alter table trader_area_prices add constraint trader_area_prices_reason_nonempty
      check (change_reason is null or btrim(change_reason) <> '');
    alter table trader_area_prices add constraint trader_area_prices_period_no_overlap
      exclude using gist (
        company_id with =,
        trader_id with =,
        area_id with =,
        daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') with &&
      ) where (is_active);

    create function reject_pricing_delete() returns trigger language plpgsql as $$
    begin
      raise exception using errcode = '23514', message = 'Historical Trader pricing cannot be deleted';
    end;
    $$;
    create trigger trader_pricing_delete_guard before delete on trader_pricing
      for each row execute function reject_pricing_delete();
    create trigger trader_area_prices_delete_guard before delete on trader_area_prices
      for each row execute function reject_pricing_delete();

    alter table orders
      add column pricing_provenance_status text,
      add column trader_pricing_id uuid,
      add column trader_area_price_id uuid,
      add column pricing_type_snapshot text,
      add column configured_service_fee_snapshot numeric(18,2),
      add column final_service_fee_snapshot numeric(18,2);
    update orders
       set pricing_provenance_status = 'legacy_unattributed',
           final_service_fee_snapshot = service_fee;
    set constraints all immediate;
    alter table orders
      alter column pricing_provenance_status set default 'resolved',
      alter column pricing_provenance_status set not null,
      alter column final_service_fee_snapshot set not null;
    alter table orders add constraint orders_trader_pricing_fk
      foreign key (trader_pricing_id, company_id) references trader_pricing(id, company_id) on delete restrict;
    alter table orders add constraint orders_trader_area_price_fk
      foreign key (trader_area_price_id, company_id) references trader_area_prices(id, company_id) on delete restrict;
    alter table orders add constraint orders_pricing_provenance_check check (
      (
        pricing_provenance_status = 'legacy_unattributed'
        and trader_pricing_id is null
        and trader_area_price_id is null
        and pricing_type_snapshot is null
        and configured_service_fee_snapshot is null
      )
      or (
        pricing_provenance_status = 'resolved'
        and trader_pricing_id is not null
        and pricing_type_snapshot in ('flat', 'by_area')
        and configured_service_fee_snapshot is not null
        and configured_service_fee_snapshot >= 0
        and final_service_fee_snapshot >= 0
        and (
          (pricing_type_snapshot = 'flat' and trader_area_price_id is null)
          or (pricing_type_snapshot = 'by_area' and trader_area_price_id is not null)
        )
      )
    );

    create function protect_order_pricing_provenance() returns trigger language plpgsql as $$
    begin
      if new.pricing_provenance_status is distinct from old.pricing_provenance_status
         or new.trader_pricing_id is distinct from old.trader_pricing_id
         or new.trader_area_price_id is distinct from old.trader_area_price_id
         or new.pricing_type_snapshot is distinct from old.pricing_type_snapshot
         or new.configured_service_fee_snapshot is distinct from old.configured_service_fee_snapshot
         or new.final_service_fee_snapshot is distinct from old.final_service_fee_snapshot then
        raise exception using errcode = '23514', message = 'Order pricing provenance is immutable';
      end if;
      return new;
    end;
    $$;
    create trigger orders_pricing_provenance_immutable
      before update of pricing_provenance_status, trader_pricing_id, trader_area_price_id,
        pricing_type_snapshot, configured_service_fee_snapshot, final_service_fee_snapshot
      on orders for each row execute function protect_order_pricing_provenance();

    create table trader_bank_accounts (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      trader_id uuid not null,
      bank_name text not null,
      account_name text not null,
      account_number text not null,
      iban text not null,
      swift_code text,
      currency char(3) not null default 'AED',
      is_active boolean not null default true,
      is_default boolean not null default false,
      notes text,
      created_by_account_id uuid not null,
      updated_by_account_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      disabled_at timestamptz,
      version bigint not null default 1,
      unique (id, company_id),
      constraint trader_bank_accounts_trader_fk foreign key (trader_id, company_id)
        references traders(id, company_id) on delete restrict,
      constraint trader_bank_accounts_creator_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint trader_bank_accounts_updater_fk foreign key (updated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint trader_bank_accounts_currency_aed check (currency = 'AED'),
      constraint trader_bank_accounts_version_positive check (version > 0),
      constraint trader_bank_accounts_required_values check (
        btrim(bank_name) <> '' and btrim(account_name) <> '' and btrim(account_number) <> ''
        and btrim(iban) <> ''
      ),
      constraint trader_bank_accounts_default_active check (not is_default or is_active)
    );
    create unique index trader_bank_accounts_iban_unique
      on trader_bank_accounts (company_id, upper(iban));
    create unique index trader_bank_accounts_one_default
      on trader_bank_accounts (company_id, trader_id) where is_active and is_default;
    create index trader_bank_accounts_trader_index
      on trader_bank_accounts (company_id, trader_id, is_active desc, created_at desc);

    create function reject_trader_bank_delete() returns trigger language plpgsql as $$
    begin
      raise exception using errcode = '23514', message = 'Trader bank accounts cannot be deleted';
    end;
    $$;
    create trigger trader_bank_accounts_delete_guard before delete on trader_bank_accounts
      for each row execute function reject_trader_bank_delete();

    alter table trader_settlement_payments
      add column trader_bank_account_id uuid,
      add column trader_bank_account_snapshot jsonb;
    alter table trader_settlement_payments add constraint trader_settlement_payments_trader_bank_fk
      foreign key (trader_bank_account_id, company_id)
      references trader_bank_accounts(id, company_id) on delete restrict;

    create function enforce_settlement_recipient_bank() returns trigger language plpgsql as $$
    declare
      settlement_trader uuid;
      bank_trader uuid;
    begin
      if new.payment_method = 'cash' then
        if new.trader_bank_account_id is not null or new.trader_bank_account_snapshot is not null then
          raise exception using errcode = '23514', message = 'Cash settlements cannot include a beneficiary bank';
        end if;
        return new;
      end if;
      if new.trader_bank_account_id is null or new.trader_bank_account_snapshot is null then
        raise exception using errcode = '23514', message = 'Bank settlements require a Trader beneficiary account';
      end if;
      select trader_id into settlement_trader from trader_settlements
       where id = new.settlement_id and company_id = new.company_id;
      select trader_id into bank_trader from trader_bank_accounts
       where id = new.trader_bank_account_id and company_id = new.company_id and is_active;
      if settlement_trader is null or bank_trader is distinct from settlement_trader then
        raise exception using errcode = '23514', message = 'Beneficiary bank must belong to the settlement Trader';
      end if;
      return new;
    end;
    $$;
    create trigger trader_settlement_payments_recipient_bank_guard
      before insert or update of payment_method, trader_bank_account_id, trader_bank_account_snapshot,
        settlement_id, company_id on trader_settlement_payments
      for each row execute function enforce_settlement_recipient_bank();

    alter table audit_events
      add column actor_role text,
      add column source text;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists trader_settlement_payments_recipient_bank_guard on trader_settlement_payments;
    drop function if exists enforce_settlement_recipient_bank();
    alter table trader_settlement_payments
      drop column if exists trader_bank_account_snapshot,
      drop column if exists trader_bank_account_id;
    drop table if exists trader_bank_accounts;

    drop trigger if exists orders_pricing_provenance_immutable on orders;
    drop function if exists protect_order_pricing_provenance();
    alter table orders
      drop column if exists final_service_fee_snapshot,
      drop column if exists configured_service_fee_snapshot,
      drop column if exists pricing_type_snapshot,
      drop column if exists trader_area_price_id,
      drop column if exists trader_pricing_id,
      drop column if exists pricing_provenance_status;

    drop trigger if exists trader_area_prices_delete_guard on trader_area_prices;
    drop trigger if exists trader_pricing_delete_guard on trader_pricing;
    drop function if exists reject_pricing_delete();
    alter table trader_area_prices
      drop column if exists change_reason,
      drop column if exists updated_by_account_id,
      drop column if exists created_by_account_id,
      drop column if exists is_active,
      drop column if exists effective_to,
      drop column if exists effective_from,
      drop column if exists trader_id;
    alter table trader_pricing
      drop column if exists change_reason,
      drop column if exists updated_by_account_id;
    create unique index if not exists trader_pricing_active_unique
      on trader_pricing (company_id, trader_id) where is_active;

    drop trigger if exists traders_mobile_format_guard on traders;
    drop function if exists validate_trader_mobile_change();
    drop trigger if exists traders_code_immutable on traders;
    drop trigger if exists areas_code_immutable on areas;
    drop function if exists protect_generated_business_code();
    alter table traders
      drop column if exists created_by_account_id,
      drop column if exists longitude,
      drop column if exists latitude,
      drop column if exists location_link,
      drop column if exists pickup_area_id,
      drop column if exists tax_registration_number,
      drop column if exists commercial_number,
      drop column if exists second_mobile_number;

    alter table audit_events drop column if exists source, drop column if exists actor_role;
    delete from company_reference_counters where reference_type in ('trader', 'area');
    alter table company_reference_counters drop constraint company_reference_counters_type_check;
    alter table company_reference_counters add constraint company_reference_counters_type_check check (
      reference_type in ('order', 'payment', 'reconciliation', 'settlement', 'journal', 'payroll', 'import')
    );
  `.execute(database);
}
