import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Payroll Prompt 1C: dedicated Driver-specific fixed-fee versions and a
 * per-Order accrual ledger. Legacy commission calculations remain untouched
 * and are not automatically converted.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table outsourced_driver_fee_versions (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      driver_id uuid not null,
      effective_from date not null,
      effective_to date,
      fee_per_order numeric(18,2) not null,
      status text not null default 'draft',
      notes text,
      created_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      updated_by_account_id uuid,
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      constraint outsourced_driver_fee_versions_driver_fk foreign key (driver_id, company_id)
        references drivers(id, company_id) on delete restrict,
      constraint outsourced_driver_fee_versions_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint outsourced_driver_fee_versions_updater_fk
        foreign key (updated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint outsourced_driver_fee_versions_status_check check (
        status in ('draft','active','superseded','inactive')
      ),
      constraint outsourced_driver_fee_versions_amount_nonnegative check (fee_per_order >= 0),
      constraint outsourced_driver_fee_versions_dates_check check (
        effective_to is null or effective_to >= effective_from
      ),
      constraint outsourced_driver_fee_versions_version_positive check (version > 0)
    );
    create index outsourced_driver_fee_versions_effective_index
      on outsourced_driver_fee_versions (company_id, driver_id, effective_from desc);

    create function validate_outsourced_driver_fee_version() returns trigger language plpgsql as $$
    begin
      if not exists (
        select 1 from drivers d where d.id = new.driver_id and d.company_id = new.company_id
          and d.driver_type = 'outsourced'
      ) then
        raise exception 'Outsourced Driver fee rates require an Outsourced Driver in the same Company';
      end if;
      if new.status = 'active' and exists (
        select 1 from outsourced_driver_fee_versions v
         where v.company_id = new.company_id and v.driver_id = new.driver_id
           and v.id <> new.id and v.status = 'active'
           and daterange(v.effective_from, coalesce(v.effective_to + 1, 'infinity'::date), '[)')
             && daterange(new.effective_from, coalesce(new.effective_to + 1, 'infinity'::date), '[)')
      ) then
        raise exception 'Active Outsourced Driver fee-rate periods cannot overlap';
      end if;
      return new;
    end;
    $$;
    create trigger outsourced_driver_fee_versions_guard
      before insert or update on outsourced_driver_fee_versions
      for each row execute function validate_outsourced_driver_fee_version();

    create table outsourced_driver_fee_accruals (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      driver_id uuid not null,
      order_id uuid not null,
      delivery_date timestamptz not null,
      accrual_business_date date not null,
      fee_rate_version_id uuid not null,
      fee_rate_snapshot numeric(18,2) not null,
      earned_amount numeric(18,2) not null,
      paid_amount numeric(18,2) not null default 0,
      outstanding_amount numeric(18,2) not null,
      status text not null default 'accrued',
      accrual_source text not null,
      source_reference text,
      created_by_account_id uuid,
      created_at timestamptz not null default now(),
      reversed_by_account_id uuid,
      reversed_at timestamptz,
      reversal_reason text,
      recovery_amount numeric(18,2) not null default 0,
      version bigint not null default 1,
      updated_at timestamptz not null default now(),
      unique (id, company_id),
      constraint outsourced_driver_fee_accruals_driver_fk foreign key (driver_id, company_id)
        references drivers(id, company_id) on delete restrict,
      constraint outsourced_driver_fee_accruals_order_fk foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict,
      constraint outsourced_driver_fee_accruals_rate_fk
        foreign key (fee_rate_version_id, company_id)
        references outsourced_driver_fee_versions(id, company_id) on delete restrict,
      constraint outsourced_driver_fee_accruals_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint outsourced_driver_fee_accruals_reverser_fk
        foreign key (reversed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint outsourced_driver_fee_accruals_status_check check (
        status in ('accrued','partially_paid','paid','reversed','recovery_required')
      ),
      constraint outsourced_driver_fee_accruals_source_check check (
        accrual_source in ('delivery','daily_reconciliation','authorized_backfill')
      ),
      constraint outsourced_driver_fee_accruals_amounts_check check (
        fee_rate_snapshot >= 0 and earned_amount = fee_rate_snapshot
        and paid_amount >= 0 and outstanding_amount >= 0 and recovery_amount >= 0
        and (
          (status = 'accrued' and paid_amount = 0 and outstanding_amount = earned_amount
            and recovery_amount = 0)
          or (status = 'partially_paid' and paid_amount > 0 and paid_amount < earned_amount
            and outstanding_amount = earned_amount - paid_amount and recovery_amount = 0)
          or (status = 'paid' and paid_amount = earned_amount and outstanding_amount = 0
            and recovery_amount = 0)
          or (status = 'reversed' and paid_amount = 0 and outstanding_amount = 0
            and recovery_amount = 0)
          or (status = 'recovery_required' and paid_amount > 0 and outstanding_amount = 0
            and recovery_amount = paid_amount)
        )
      ),
      constraint outsourced_driver_fee_accruals_reversal_shape_check check (
        (status not in ('reversed','recovery_required') and reversed_by_account_id is null
          and reversed_at is null and reversal_reason is null)
        or (status in ('reversed','recovery_required') and reversed_by_account_id is not null
          and reversed_at is not null and btrim(reversal_reason) <> '')
      ),
      constraint outsourced_driver_fee_accruals_version_positive check (version > 0)
    );
    create unique index outsourced_driver_fee_accruals_order_unique
      on outsourced_driver_fee_accruals (company_id, order_id);
    create index outsourced_driver_fee_accruals_driver_status_index
      on outsourced_driver_fee_accruals (company_id, driver_id, status, accrual_business_date);
    create index outsourced_driver_fee_accruals_business_date_index
      on outsourced_driver_fee_accruals (company_id, accrual_business_date);

    create function validate_outsourced_driver_fee_accrual() returns trigger language plpgsql as $$
    declare
      order_driver_id uuid;
      order_delivery_status text;
      order_delivered_at timestamptz;
    begin
      if not exists (
        select 1 from drivers d where d.id = new.driver_id and d.company_id = new.company_id
          and d.driver_type = 'outsourced'
      ) then
        raise exception 'Fee accruals require an Outsourced Driver in the same Company';
      end if;
      select o.assigned_driver_id, o.delivery_status, o.delivered_at
        into order_driver_id, order_delivery_status, order_delivered_at
        from orders o
       where o.id = new.order_id and o.company_id = new.company_id;
      if order_driver_id is null then
        raise exception 'Fee accrual Order must belong to the same Company';
      end if;
      if order_delivery_status <> 'delivered' or order_delivered_at is null then
        raise exception 'Fee accruals require a delivered Order with a delivery timestamp';
      end if;
      if order_driver_id <> new.driver_id then
        raise exception 'Fee accrual Driver must be the Order delivering Driver';
      end if;
      if order_delivered_at <> new.delivery_date then
        raise exception 'Fee accrual delivery timestamp must match the delivered Order';
      end if;
      if not exists (
        select 1 from outsourced_driver_fee_versions v
         where v.id = new.fee_rate_version_id and v.company_id = new.company_id
           and v.driver_id = new.driver_id
           and v.status in ('active','superseded')
           and v.effective_from <= new.accrual_business_date
           and coalesce(v.effective_to, 'infinity'::date) >= new.accrual_business_date
           and v.fee_per_order = new.fee_rate_snapshot
      ) then
        raise exception 'Fee-rate snapshot must be effective for the Driver and accrual business date';
      end if;
      return new;
    end;
    $$;
    create trigger outsourced_driver_fee_accruals_scope_guard
      before insert or update on outsourced_driver_fee_accruals
      for each row execute function validate_outsourced_driver_fee_accrual();

    create function protect_outsourced_driver_fee_foundations() returns trigger language plpgsql as $$
    begin
      if tg_op = 'DELETE' then
        raise exception 'Outsourced Driver fee history cannot be deleted';
      end if;
      if tg_table_name = 'outsourced_driver_fee_versions' and exists (
        select 1 from outsourced_driver_fee_accruals a
         where a.company_id = old.company_id and a.fee_rate_version_id = old.id
      ) and (
        new.fee_per_order is distinct from old.fee_per_order
        or new.driver_id is distinct from old.driver_id
        or new.effective_from is distinct from old.effective_from
      ) then
        raise exception 'Fee-rate versions used by an accrual are immutable';
      end if;
      if tg_table_name = 'outsourced_driver_fee_accruals' and (
        new.company_id is distinct from old.company_id
        or new.driver_id is distinct from old.driver_id
        or new.order_id is distinct from old.order_id
        or new.fee_rate_version_id is distinct from old.fee_rate_version_id
        or new.fee_rate_snapshot is distinct from old.fee_rate_snapshot
        or new.earned_amount is distinct from old.earned_amount
      ) then
        raise exception 'Fee accrual source and earned snapshots are immutable';
      end if;
      if tg_table_name = 'outsourced_driver_fee_accruals'
        and old.status in ('reversed','recovery_required') then
        raise exception 'Reversed or recovery-required fee accruals are immutable';
      end if;
      return new;
    end;
    $$;
    create trigger outsourced_driver_fee_versions_immutable
      before update or delete on outsourced_driver_fee_versions
      for each row execute function protect_outsourced_driver_fee_foundations();
    create trigger outsourced_driver_fee_accruals_immutable
      before update or delete on outsourced_driver_fee_accruals
      for each row execute function protect_outsourced_driver_fee_foundations();

    create function protect_legacy_commission_history() returns trigger language plpgsql as $$
    begin
      raise exception 'Legacy Driver commission and payment history is read-only';
    end;
    $$;
    create trigger driver_commission_orders_legacy_immutable
      before update or delete on driver_commission_orders
      for each row execute function protect_legacy_commission_history();
    create trigger payroll_commission_links_legacy_immutable
      before update or delete on payroll_commission_links
      for each row execute function protect_legacy_commission_history();
    create trigger outsourced_driver_payments_legacy_immutable
      before update or delete on outsourced_driver_payments
      for each row execute function protect_legacy_commission_history();

    insert into permissions (code, description) values
      ('outsourced_driver_fees.view', 'View Outsourced Driver fee rates and accruals'),
      ('outsourced_driver_fees.manage', 'Manage Outsourced Driver fee rates and accrual foundations')
    on conflict (code) do nothing;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from role_permissions where permission_code in (
      'outsourced_driver_fees.view','outsourced_driver_fees.manage'
    );
    delete from permissions where code in (
      'outsourced_driver_fees.view','outsourced_driver_fees.manage'
    );
    drop trigger if exists outsourced_driver_payments_legacy_immutable
      on outsourced_driver_payments;
    drop trigger if exists payroll_commission_links_legacy_immutable
      on payroll_commission_links;
    drop trigger if exists driver_commission_orders_legacy_immutable
      on driver_commission_orders;
    drop function if exists protect_legacy_commission_history();
    drop trigger if exists outsourced_driver_fee_accruals_immutable
      on outsourced_driver_fee_accruals;
    drop trigger if exists outsourced_driver_fee_versions_immutable
      on outsourced_driver_fee_versions;
    drop function if exists protect_outsourced_driver_fee_foundations();
    drop trigger if exists outsourced_driver_fee_accruals_scope_guard
      on outsourced_driver_fee_accruals;
    drop function if exists validate_outsourced_driver_fee_accrual();
    drop table if exists outsourced_driver_fee_accruals;
    drop trigger if exists outsourced_driver_fee_versions_guard
      on outsourced_driver_fee_versions;
    drop function if exists validate_outsourced_driver_fee_version();
    drop table if exists outsourced_driver_fee_versions;
  `.execute(database);
}
