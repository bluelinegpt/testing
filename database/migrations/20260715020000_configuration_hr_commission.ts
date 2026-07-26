import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table employees
      add column date_of_birth date,
      add column nationality text,
      add column job_title text,
      add column department text,
      add column employee_type text,
      add column second_mobile_number text,
      add column email text,
      add column area_id uuid,
      add constraint employees_area_fk foreign key (area_id, company_id)
        references areas(id, company_id) on delete restrict;

    alter table drivers alter column account_id drop not null;
    alter table drivers
      add column second_mobile_number text,
      add column email text,
      add column area_id uuid,
      add column third_party_company_id uuid,
      add column date_of_birth date,
      add column nationality text,
      add constraint drivers_area_fk foreign key (area_id, company_id)
        references areas(id, company_id) on delete restrict,
      add constraint drivers_third_party_company_fk foreign key (third_party_company_id, company_id)
        references third_party_delivery_companies(id, company_id) on delete restrict;

    alter table drivers drop constraint drivers_employee_consistency;
    alter table drivers add constraint drivers_employee_consistency check (
      (driver_type = 'employee' and employee_id is not null and outsourced_fee_per_delivered_order is null)
      or (driver_type = 'outsourced' and employee_id is null)
    );

    create table allowance_types (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      code text not null,
      name text not null,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      unique (company_id, code),
      constraint allowance_types_code_nonempty check (btrim(code) <> ''),
      constraint allowance_types_name_nonempty check (btrim(name) <> ''),
      constraint allowance_types_version_positive check (version > 0)
    );

    create table employee_salary_versions (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      employee_id uuid not null,
      basic_salary numeric(18,2) not null,
      effective_from date not null,
      effective_to date,
      created_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      constraint employee_salary_versions_employee_fk foreign key (employee_id, company_id)
        references employees(id, company_id) on delete restrict,
      constraint employee_salary_versions_actor_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint employee_salary_versions_amount_nonnegative check (basic_salary >= 0),
      constraint employee_salary_versions_dates_check check (
        effective_to is null or effective_to >= effective_from
      )
    );
    create index employee_salary_versions_effective_index
      on employee_salary_versions (company_id, employee_id, effective_from desc);

    create table employee_allowances (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      employee_id uuid not null,
      allowance_type_id uuid not null,
      amount numeric(18,2) not null,
      effective_from date not null,
      effective_to date,
      is_active boolean not null default true,
      created_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      constraint employee_allowances_employee_fk foreign key (employee_id, company_id)
        references employees(id, company_id) on delete restrict,
      constraint employee_allowances_type_fk foreign key (allowance_type_id, company_id)
        references allowance_types(id, company_id) on delete restrict,
      constraint employee_allowances_actor_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint employee_allowances_amount_nonnegative check (amount >= 0),
      constraint employee_allowances_dates_check check (effective_to is null or effective_to >= effective_from),
      constraint employee_allowances_version_positive check (version > 0)
    );
    create index employee_allowances_effective_index
      on employee_allowances (company_id, employee_id, effective_from desc);

    create table hr_documents (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      employee_id uuid,
      driver_id uuid,
      document_type text not null,
      document_number text,
      issue_date date,
      expiry_date date,
      issuing_authority text,
      description text,
      licence_category text,
      restrictions text,
      vehicle_category text,
      status text not null default 'active',
      replaced_by_document_id uuid,
      created_by_account_id uuid not null,
      updated_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      constraint hr_documents_employee_fk foreign key (employee_id, company_id)
        references employees(id, company_id) on delete restrict,
      constraint hr_documents_driver_fk foreign key (driver_id, company_id)
        references drivers(id, company_id) on delete restrict,
      constraint hr_documents_replacement_fk foreign key (replaced_by_document_id, company_id)
        references hr_documents(id, company_id) on delete restrict,
      constraint hr_documents_creator_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint hr_documents_updater_fk foreign key (updated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint hr_documents_owner_check check ((employee_id is null) <> (driver_id is null)),
      constraint hr_documents_type_check check (
        document_type in ('passport', 'emirates_id', 'driving_licence', 'visa_residency', 'other')
      ),
      constraint hr_documents_status_check check (status in ('active', 'replaced', 'disabled')),
      constraint hr_documents_dates_check check (expiry_date is null or issue_date is null or expiry_date >= issue_date),
      constraint hr_documents_replacement_check check (
        (status = 'replaced' and replaced_by_document_id is not null)
        or (status <> 'replaced' and replaced_by_document_id is null)
      ),
      constraint hr_documents_version_positive check (version > 0)
    );
    create index hr_documents_employee_index on hr_documents (company_id, employee_id, created_at desc)
      where employee_id is not null;
    create index hr_documents_driver_index on hr_documents (company_id, driver_id, created_at desc)
      where driver_id is not null;
    create index hr_documents_expiry_index on hr_documents (company_id, expiry_date)
      where status = 'active' and expiry_date is not null;
    create unique index hr_documents_active_number_unique
      on hr_documents (company_id, document_type, lower(document_number))
      where status = 'active' and document_number is not null;

    create table hr_document_attachments (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      document_id uuid not null,
      file_object_id uuid not null,
      description text,
      status text not null default 'active',
      replaced_by_attachment_id uuid,
      uploaded_by_account_id uuid not null,
      uploaded_at timestamptz not null default now(),
      disabled_by_account_id uuid,
      disabled_at timestamptz,
      unique (id, company_id),
      constraint hr_document_attachments_document_fk foreign key (document_id, company_id)
        references hr_documents(id, company_id) on delete restrict,
      constraint hr_document_attachments_file_fk foreign key (file_object_id, company_id)
        references file_objects(id, company_id) on delete restrict,
      constraint hr_document_attachments_replacement_fk foreign key (replaced_by_attachment_id, company_id)
        references hr_document_attachments(id, company_id) on delete restrict,
      constraint hr_document_attachments_uploader_fk foreign key (uploaded_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint hr_document_attachments_disabler_fk foreign key (disabled_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint hr_document_attachments_status_check check (status in ('active', 'replaced', 'disabled')),
      constraint hr_document_attachments_disabled_check check (
        (status = 'disabled' and disabled_by_account_id is not null and disabled_at is not null)
        or (status <> 'disabled' and disabled_by_account_id is null and disabled_at is null)
      )
    );
    create index hr_document_attachments_document_index
      on hr_document_attachments (company_id, document_id, uploaded_at desc);

    create table driver_commission_rules (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      driver_id uuid not null,
      name text not null,
      commission_method text not null,
      commission_basis text,
      commission_rate numeric(18,4) not null,
      calculation_frequency text not null,
      eligible_order_status text not null default 'delivered',
      effective_from date not null,
      effective_to date,
      is_active boolean not null default true,
      created_by_account_id uuid,
      created_at timestamptz not null default now(),
      disabled_at timestamptz,
      version bigint not null default 1,
      unique (id, company_id),
      constraint driver_commission_rules_driver_fk foreign key (driver_id, company_id)
        references drivers(id, company_id) on delete restrict,
      constraint driver_commission_rules_actor_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint driver_commission_rules_name_nonempty check (btrim(name) <> ''),
      constraint driver_commission_rules_method_check check (commission_method in ('fixed', 'percentage')),
      constraint driver_commission_rules_basis_check check (
        (commission_method = 'fixed' and commission_basis is null)
        or (commission_method = 'percentage' and commission_basis = 'service_fee')
      ),
      constraint driver_commission_rules_rate_check check (
        commission_rate >= 0 and (commission_method <> 'percentage' or commission_rate <= 100)
      ),
      constraint driver_commission_rules_frequency_check check (calculation_frequency in ('daily', 'monthly')),
      constraint driver_commission_rules_status_check check (eligible_order_status = 'delivered'),
      constraint driver_commission_rules_dates_check check (effective_to is null or effective_to >= effective_from),
      constraint driver_commission_rules_version_positive check (version > 0)
    );
    create index driver_commission_rules_effective_index
      on driver_commission_rules (company_id, driver_id, effective_from desc);

    create table driver_commission_calculations (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      driver_id uuid not null,
      commission_rule_id uuid not null,
      calculation_reference text not null,
      calculation_frequency text not null,
      period_start date not null,
      period_end date not null,
      eligible_order_count integer not null,
      commission_method text not null,
      commission_basis text,
      commission_rate numeric(18,4) not null,
      gross_commission numeric(18,2) not null,
      additions numeric(18,2) not null default 0,
      deductions numeric(18,2) not null default 0,
      adjustment_reason text,
      net_payable numeric(18,2) not null,
      status text not null,
      created_by_account_id uuid not null,
      paid_by_account_id uuid,
      paid_at timestamptz,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, calculation_reference),
      constraint driver_commission_calculations_driver_fk foreign key (driver_id, company_id)
        references drivers(id, company_id) on delete restrict,
      constraint driver_commission_calculations_rule_fk foreign key (commission_rule_id, company_id)
        references driver_commission_rules(id, company_id) on delete restrict,
      constraint driver_commission_calculations_creator_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint driver_commission_calculations_payer_fk foreign key (paid_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint driver_commission_calculations_frequency_check check (calculation_frequency in ('daily', 'monthly')),
      constraint driver_commission_calculations_method_check check (commission_method in ('fixed', 'percentage')),
      constraint driver_commission_calculations_basis_check check (
        (commission_method = 'fixed' and commission_basis is null)
        or (commission_method = 'percentage' and commission_basis = 'service_fee')
      ),
      constraint driver_commission_calculations_dates_check check (period_end >= period_start),
      constraint driver_commission_calculations_count_check check (eligible_order_count >= 0),
      constraint driver_commission_calculations_amounts_check check (
        commission_rate >= 0 and gross_commission >= 0 and additions >= 0 and deductions >= 0
        and net_payable >= 0 and net_payable = gross_commission + additions - deductions
      ),
      constraint driver_commission_calculations_adjustment_check check (
        (additions = 0 and deductions = 0) or btrim(coalesce(adjustment_reason, '')) <> ''
      ),
      constraint driver_commission_calculations_status_check check (
        status in ('accrued', 'payable', 'paid', 'consumed', 'cancelled')
      ),
      constraint driver_commission_calculations_payment_check check (
        (status = 'paid' and paid_by_account_id is not null and paid_at is not null)
        or (status <> 'paid' and paid_by_account_id is null and paid_at is null)
      )
    );
    create index driver_commission_calculations_period_index
      on driver_commission_calculations (company_id, driver_id, period_start, period_end);

    create table driver_commission_orders (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      calculation_id uuid not null,
      driver_id uuid not null,
      order_id uuid not null,
      allocation_kind text not null,
      delivery_date date not null,
      service_fee_snapshot numeric(18,2) not null,
      commission_amount numeric(18,2) not null,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, driver_id, order_id, allocation_kind),
      constraint driver_commission_orders_calculation_fk foreign key (calculation_id, company_id)
        references driver_commission_calculations(id, company_id) on delete restrict,
      constraint driver_commission_orders_driver_fk foreign key (driver_id, company_id)
        references drivers(id, company_id) on delete restrict,
      constraint driver_commission_orders_order_fk foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict,
      constraint driver_commission_orders_kind_check check (allocation_kind in ('accrual', 'payment')),
      constraint driver_commission_orders_amounts_check check (service_fee_snapshot >= 0 and commission_amount >= 0)
    );
    create index driver_commission_orders_calculation_index
      on driver_commission_orders (company_id, calculation_id);

    create table payroll_commission_links (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      payroll_entry_id uuid not null,
      commission_calculation_id uuid not null,
      amount numeric(18,2) not null,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, commission_calculation_id),
      constraint payroll_commission_links_payroll_fk foreign key (payroll_entry_id, company_id)
        references payroll_entries(id, company_id) on delete restrict,
      constraint payroll_commission_links_calculation_fk foreign key (commission_calculation_id, company_id)
        references driver_commission_calculations(id, company_id) on delete restrict,
      constraint payroll_commission_links_amount_nonnegative check (amount >= 0)
    );

    create table outsourced_driver_payments (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      commission_calculation_id uuid not null,
      payment_method text not null,
      payment_date date not null,
      company_bank_account_id uuid,
      payment_reference text,
      paid_by_account_id uuid not null,
      idempotency_key text not null,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, commission_calculation_id),
      unique (company_id, idempotency_key),
      constraint outsourced_driver_payments_calculation_fk foreign key (commission_calculation_id, company_id)
        references driver_commission_calculations(id, company_id) on delete restrict,
      constraint outsourced_driver_payments_bank_fk foreign key (company_bank_account_id, company_id)
        references company_bank_accounts(id, company_id) on delete restrict,
      constraint outsourced_driver_payments_actor_fk foreign key (paid_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint outsourced_driver_payments_method_check check (payment_method in ('cash', 'bank_transfer')),
      constraint outsourced_driver_payments_bank_check check (
        (payment_method = 'cash' and company_bank_account_id is null)
        or (payment_method = 'bank_transfer' and company_bank_account_id is not null and btrim(coalesce(payment_reference, '')) <> '')
      ),
      constraint outsourced_driver_payments_idempotency_nonempty check (btrim(idempotency_key) <> '')
    );

    alter table payroll_periods add constraint payroll_periods_calendar_month_check check (
      period_start = date_trunc('month', period_start)::date
      and period_end = (date_trunc('month', period_start) + interval '1 month - 1 day')::date
    );

    create function reject_final_commission_mutation() returns trigger language plpgsql as $$
    begin
      if old.status in ('paid', 'consumed') then
        raise exception using errcode = '23514', message = 'Final commission calculations are immutable';
      end if;
      if tg_op = 'DELETE' then
        raise exception using errcode = '23514', message = 'Commission calculations cannot be deleted';
      end if;
      return new;
    end;
    $$;
    create trigger driver_commission_calculations_immutable
      before update or delete on driver_commission_calculations
      for each row execute function reject_final_commission_mutation();

    create function prevent_commission_rule_overlap() returns trigger language plpgsql as $$
    begin
      if new.is_active and exists (
        select 1 from driver_commission_rules r
        where r.company_id = new.company_id and r.driver_id = new.driver_id
          and r.calculation_frequency = new.calculation_frequency and r.is_active
          and r.id <> new.id
          and daterange(r.effective_from, coalesce(r.effective_to + 1, 'infinity'::date), '[)')
              && daterange(new.effective_from, coalesce(new.effective_to + 1, 'infinity'::date), '[)')
      ) then
        raise exception using errcode = '23505', message = 'Active Driver commission rules cannot overlap';
      end if;
      return new;
    end;
    $$;
    create trigger driver_commission_rules_no_overlap
      before insert or update on driver_commission_rules
      for each row execute function prevent_commission_rule_overlap();

    create function prevent_salary_version_overlap() returns trigger language plpgsql as $$
    begin
      if exists (
        select 1 from employee_salary_versions s
        where s.company_id = new.company_id and s.employee_id = new.employee_id and s.id <> new.id
          and daterange(s.effective_from, coalesce(s.effective_to + 1, 'infinity'::date), '[)')
              && daterange(new.effective_from, coalesce(new.effective_to + 1, 'infinity'::date), '[)')
      ) then
        raise exception using errcode = '23505', message = 'Employee salary versions cannot overlap';
      end if;
      return new;
    end;
    $$;
    create trigger employee_salary_versions_no_overlap
      before insert or update on employee_salary_versions
      for each row execute function prevent_salary_version_overlap();

    create function enforce_employee_allowance_limit() returns trigger language plpgsql as $$
    declare overlapping_count integer;
    begin
      if not new.is_active then return new; end if;
      select count(*) into overlapping_count from employee_allowances a
      where a.company_id = new.company_id and a.employee_id = new.employee_id and a.is_active
        and a.id <> new.id
        and daterange(a.effective_from, coalesce(a.effective_to + 1, 'infinity'::date), '[)')
            && daterange(new.effective_from, coalesce(new.effective_to + 1, 'infinity'::date), '[)');
      if overlapping_count >= 4 then
        raise exception using errcode = '23514', message = 'An Employee may have at most four active allowances';
      end if;
      return new;
    end;
    $$;
    create trigger employee_allowances_max_four
      before insert or update on employee_allowances
      for each row execute function enforce_employee_allowance_limit();

    insert into driver_commission_rules (
      company_id, driver_id, name, commission_method, commission_basis,
      commission_rate, calculation_frequency, eligible_order_status,
      effective_from, is_active, created_by_account_id
    )
    select d.company_id, d.id, 'Migrated outsourced delivery fee', 'fixed', null,
           d.outsourced_fee_per_delivered_order, 'monthly', 'delivered', current_date, true, null
      from drivers d
     where d.driver_type = 'outsourced'
       and d.outsourced_fee_per_delivered_order is not null;

    insert into audit_events (
      company_id, action, subject_type, subject_id, after_data, reason, correlation_id
    )
    select d.company_id, 'driver_commission_rule.migrate', 'driver', d.id::text,
           jsonb_build_object(
             'method', 'fixed', 'rate', d.outsourced_fee_per_delivered_order,
             'frequency', 'monthly', 'effectiveFrom', current_date
           ),
           'Convert existing outsourced fee for future calculations only',
           'migration:20260715020000:' || d.id::text
      from drivers d
     where d.driver_type = 'outsourced'
       and d.outsourced_fee_per_delivered_order is not null;
  `.execute(database);
}
