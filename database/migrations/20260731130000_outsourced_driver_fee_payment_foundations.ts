import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Payroll Prompt 1D: cash/collection-offset payment headers and allocation
 * foundations. Driver Collection calculations remain unchanged; the nullable
 * reconciliation relationship is only prepared for a later workflow.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table outsourced_driver_fee_payments (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      payment_number text not null,
      driver_id uuid not null,
      payment_date date not null,
      payment_method text not null,
      payment_source text not null,
      amount_paid numeric(18,2) not null,
      cash_voucher_reference text,
      external_reference text,
      notes text,
      status text not null default 'confirmed',
      paid_by_account_id uuid not null,
      linked_driver_reconciliation_id uuid,
      idempotency_key text not null,
      request_hash text not null,
      source_marker text not null default 'new_outsourced_fee',
      created_at timestamptz not null default now(),
      reversed_by_account_id uuid,
      reversed_at timestamptz,
      reversal_reason text,
      reversal_of_payment_id uuid,
      version bigint not null default 1,
      updated_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, payment_number),
      unique (company_id, idempotency_key),
      constraint outsourced_driver_fee_payments_driver_fk foreign key (driver_id, company_id)
        references drivers(id, company_id) on delete restrict,
      constraint outsourced_driver_fee_payments_payer_fk
        foreign key (paid_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint outsourced_driver_fee_payments_reverser_fk
        foreign key (reversed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint outsourced_driver_fee_payments_reconciliation_fk
        foreign key (linked_driver_reconciliation_id, company_id)
        references driver_reconciliations(id, company_id) on delete restrict,
      constraint outsourced_driver_fee_payments_reversal_fk
        foreign key (reversal_of_payment_id, company_id)
        references outsourced_driver_fee_payments(id, company_id) on delete restrict,
      constraint outsourced_driver_fee_payments_method_check check (
        payment_method in ('cash','collection_offset')
      ),
      constraint outsourced_driver_fee_payments_source_check check (
        payment_source in ('separate_payment','driver_collection')
      ),
      constraint outsourced_driver_fee_payments_method_source_check check (
        (payment_method = 'cash' and payment_source = 'separate_payment'
          and linked_driver_reconciliation_id is null)
        or (payment_method = 'collection_offset' and payment_source = 'driver_collection'
          and linked_driver_reconciliation_id is not null)
      ),
      constraint outsourced_driver_fee_payments_status_check check (
        status in ('confirmed','reversed')
      ),
      constraint outsourced_driver_fee_payments_amount_positive check (amount_paid > 0),
      constraint outsourced_driver_fee_payments_idempotency_nonempty check (
        btrim(idempotency_key) <> '' and btrim(request_hash) <> ''
      ),
      constraint outsourced_driver_fee_payments_source_marker_check check (
        source_marker in ('legacy','new_outsourced_fee')
      ),
      constraint outsourced_driver_fee_payments_reversal_self_check check (
        reversal_of_payment_id is null or reversal_of_payment_id <> id
      ),
      constraint outsourced_driver_fee_payments_reversal_shape_check check (
        (status = 'confirmed' and reversed_by_account_id is null and reversed_at is null
          and reversal_reason is null)
        or (status = 'reversed' and reversed_by_account_id is not null and reversed_at is not null
          and btrim(reversal_reason) <> '')
      ),
      constraint outsourced_driver_fee_payments_version_positive check (version > 0)
    );
    create unique index outsourced_driver_fee_payments_active_reconciliation_unique
      on outsourced_driver_fee_payments (company_id, linked_driver_reconciliation_id)
      where linked_driver_reconciliation_id is not null and status = 'confirmed';
    create index outsourced_driver_fee_payments_driver_date_index
      on outsourced_driver_fee_payments (
        company_id, driver_id, status, payment_source, payment_date desc
      );

    create table outsourced_driver_fee_payment_allocations (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      payment_id uuid not null,
      accrual_id uuid not null,
      allocated_amount numeric(18,2) not null,
      allocation_order integer not null,
      created_at timestamptz not null default now(),
      reversed_at timestamptz,
      reversal_allocation_id uuid,
      unique (id, company_id),
      unique (company_id, payment_id, accrual_id),
      constraint outsourced_driver_fee_payment_allocations_payment_fk
        foreign key (payment_id, company_id)
        references outsourced_driver_fee_payments(id, company_id) on delete restrict,
      constraint outsourced_driver_fee_payment_allocations_accrual_fk
        foreign key (accrual_id, company_id)
        references outsourced_driver_fee_accruals(id, company_id) on delete restrict,
      constraint outsourced_driver_fee_payment_allocations_reversal_fk
        foreign key (reversal_allocation_id, company_id)
        references outsourced_driver_fee_payment_allocations(id, company_id) on delete restrict,
      constraint outsourced_driver_fee_payment_allocations_amount_positive check (
        allocated_amount > 0
      ),
      constraint outsourced_driver_fee_payment_allocations_order_positive check (
        allocation_order > 0
      ),
      constraint outsourced_driver_fee_payment_allocations_reversal_self_check check (
        reversal_allocation_id is null or reversal_allocation_id <> id
      )
    );
    create index outsourced_driver_fee_payment_allocations_accrual_index
      on outsourced_driver_fee_payment_allocations (company_id, accrual_id)
      where reversed_at is null;

    create function validate_outsourced_driver_fee_payment_scope() returns trigger language plpgsql as $$
    declare reconciliation_driver uuid;
    begin
      if not exists (
        select 1 from drivers d where d.id = new.driver_id and d.company_id = new.company_id
          and d.driver_type = 'outsourced'
      ) then
        raise exception 'Fee payments require an Outsourced Driver in the same Company';
      end if;
      if new.linked_driver_reconciliation_id is not null then
        select r.driver_id into reconciliation_driver
          from driver_reconciliations r
         where r.id = new.linked_driver_reconciliation_id and r.company_id = new.company_id;
        if reconciliation_driver is null or reconciliation_driver <> new.driver_id then
          raise exception 'Linked Driver reconciliation must belong to the same Driver and Company';
        end if;
      end if;
      return new;
    end;
    $$;
    create trigger outsourced_driver_fee_payments_scope_guard
      before insert or update on outsourced_driver_fee_payments
      for each row execute function validate_outsourced_driver_fee_payment_scope();

    create function validate_outsourced_driver_fee_allocation_scope() returns trigger language plpgsql as $$
    declare payment_driver uuid;
    declare payment_status text;
    declare accrual_driver uuid;
    declare accrual_status text;
    declare accrual_outstanding numeric(18,2);
    begin
      select p.driver_id, p.status into payment_driver, payment_status
        from outsourced_driver_fee_payments p
       where p.id = new.payment_id and p.company_id = new.company_id;
      select a.driver_id, a.status, a.outstanding_amount
        into accrual_driver, accrual_status, accrual_outstanding
        from outsourced_driver_fee_accruals a
       where a.id = new.accrual_id and a.company_id = new.company_id
       for update;
      if payment_driver is null or accrual_driver is null or payment_driver <> accrual_driver then
        raise exception 'Fee payment and accrual must belong to the same Driver and Company';
      end if;
      if payment_status <> 'confirmed' then
        raise exception 'Allocations require a confirmed fee payment';
      end if;
      if tg_op = 'INSERT' then
        if accrual_status not in ('accrued','partially_paid')
          or accrual_outstanding <= 0
          or new.allocated_amount > accrual_outstanding then
          raise exception 'Allocation exceeds the active Outsourced Driver fee outstanding amount';
        end if;
      elsif new.payment_id is distinct from old.payment_id
        or new.accrual_id is distinct from old.accrual_id
        or new.allocated_amount is distinct from old.allocated_amount then
        if accrual_status not in ('accrued','partially_paid')
          or accrual_outstanding <= 0
          or new.allocated_amount > accrual_outstanding then
          raise exception 'Allocation exceeds the active Outsourced Driver fee outstanding amount';
        end if;
      end if;
      return new;
    end;
    $$;
    create trigger outsourced_driver_fee_payment_allocations_scope_guard
      before insert or update on outsourced_driver_fee_payment_allocations
      for each row execute function validate_outsourced_driver_fee_allocation_scope();

    create function validate_outsourced_driver_fee_payment_total()
      returns trigger language plpgsql as $$
    declare
      target_payment_id uuid;
      payment_amount numeric(18,2);
      payment_status text;
      allocation_total numeric(18,2);
    begin
      if tg_table_name = 'outsourced_driver_fee_payments' then
        target_payment_id := new.id;
      else
        target_payment_id := new.payment_id;
      end if;
      select p.amount_paid, p.status into payment_amount, payment_status
        from outsourced_driver_fee_payments p
       where p.id = target_payment_id and p.company_id = new.company_id;
      select coalesce(sum(a.allocated_amount), 0) into allocation_total
        from outsourced_driver_fee_payment_allocations a
       where a.company_id = new.company_id
         and a.payment_id = target_payment_id
         and a.reversed_at is null;
      if payment_status = 'confirmed' and allocation_total <> payment_amount then
        raise exception 'Outsourced Driver fee payment total must equal its active allocations';
      end if;
      if payment_status = 'reversed' and allocation_total <> 0 then
        raise exception 'Reversed Outsourced Driver fee payments cannot retain active allocations';
      end if;
      return new;
    end;
    $$;
    create constraint trigger outsourced_driver_fee_payments_total_guard
      after insert or update on outsourced_driver_fee_payments
      deferrable initially deferred
      for each row execute function validate_outsourced_driver_fee_payment_total();
    create constraint trigger outsourced_driver_fee_payment_allocations_total_guard
      after insert or update on outsourced_driver_fee_payment_allocations
      deferrable initially deferred
      for each row execute function validate_outsourced_driver_fee_payment_total();

    create function protect_outsourced_driver_fee_payments() returns trigger language plpgsql as $$
    begin
      if tg_op = 'DELETE' then
        raise exception 'Outsourced Driver fee payment history cannot be deleted';
      end if;
      if tg_table_name = 'outsourced_driver_fee_payments' then
        if old.status = 'confirmed' and new.status = 'reversed'
          and new.reversed_by_account_id is not null and new.reversed_at is not null
          and btrim(new.reversal_reason) <> ''
          and (
            to_jsonb(new) - array[
              'status','reversed_by_account_id','reversed_at','reversal_reason',
              'reversal_of_payment_id','version','updated_at'
            ]::text[]
            =
            to_jsonb(old) - array[
              'status','reversed_by_account_id','reversed_at','reversal_reason',
              'reversal_of_payment_id','version','updated_at'
            ]::text[]
          ) then
          return new;
        end if;
        raise exception 'Confirmed Outsourced Driver fee payments are immutable; use reversal';
      end if;
      if tg_table_name = 'outsourced_driver_fee_payment_allocations'
        and old.reversed_at is null and new.reversed_at is not null
        and (
          to_jsonb(new) - array['reversed_at','reversal_allocation_id']::text[]
          =
          to_jsonb(old) - array['reversed_at','reversal_allocation_id']::text[]
        ) then
        return new;
      end if;
      raise exception 'Fee payment allocations are immutable; use reversal';
    end;
    $$;
    create trigger outsourced_driver_fee_payments_immutable
      before update or delete on outsourced_driver_fee_payments
      for each row execute function protect_outsourced_driver_fee_payments();
    create trigger outsourced_driver_fee_payment_allocations_immutable
      before update or delete on outsourced_driver_fee_payment_allocations
      for each row execute function protect_outsourced_driver_fee_payments();

    insert into permissions (code, description) values
      ('outsourced_driver_fees.pay', 'Confirm Outsourced Driver fee payments and collection offsets'),
      ('outsourced_driver_fees.reverse', 'Reverse Outsourced Driver fee payments and offsets')
    on conflict (code) do nothing;

    alter table company_reference_counters drop constraint company_reference_counters_type_check;
    alter table company_reference_counters add constraint company_reference_counters_type_check check (
      reference_type in (
        'order','payment','reconciliation','settlement','journal','payroll','import',
        'trader','area','customer','driver','employee','trader_receivable','trader_collection',
        'payroll_payment','outsourced_driver_fee_payment'
      )
    );
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from company_reference_counters
     where reference_type = 'outsourced_driver_fee_payment';
    alter table company_reference_counters drop constraint company_reference_counters_type_check;
    alter table company_reference_counters add constraint company_reference_counters_type_check check (
      reference_type in (
        'order','payment','reconciliation','settlement','journal','payroll','import',
        'trader','area','customer','driver','employee','trader_receivable','trader_collection',
        'payroll_payment'
      )
    );
    delete from role_permissions where permission_code in (
      'outsourced_driver_fees.pay','outsourced_driver_fees.reverse'
    );
    delete from permissions where code in (
      'outsourced_driver_fees.pay','outsourced_driver_fees.reverse'
    );
    drop trigger if exists outsourced_driver_fee_payment_allocations_immutable
      on outsourced_driver_fee_payment_allocations;
    drop trigger if exists outsourced_driver_fee_payment_allocations_total_guard
      on outsourced_driver_fee_payment_allocations;
    drop trigger if exists outsourced_driver_fee_payments_total_guard
      on outsourced_driver_fee_payments;
    drop function if exists validate_outsourced_driver_fee_payment_total();
    drop trigger if exists outsourced_driver_fee_payments_immutable
      on outsourced_driver_fee_payments;
    drop function if exists protect_outsourced_driver_fee_payments();
    drop trigger if exists outsourced_driver_fee_payment_allocations_scope_guard
      on outsourced_driver_fee_payment_allocations;
    drop function if exists validate_outsourced_driver_fee_allocation_scope();
    drop trigger if exists outsourced_driver_fee_payments_scope_guard
      on outsourced_driver_fee_payments;
    drop function if exists validate_outsourced_driver_fee_payment_scope();
    drop table if exists outsourced_driver_fee_payment_allocations;
    drop table if exists outsourced_driver_fee_payments;
  `.execute(database);
}
