import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Payroll Prompt 1B: evolves the legacy monthly Payroll structures and adds
 * immutable snapshots, adjustments, cash payments, and allocations. Legacy
 * rows are preserved and explicitly marked; no operational API is introduced.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table payroll_periods drop constraint payroll_periods_status_check;
    alter table payroll_periods drop constraint payroll_periods_close_check;

    update payroll_periods set status = case when status = 'open' then 'draft' else 'closed' end;

    alter table payroll_periods
      add column payroll_month date,
      add column calculation_date date,
      add column total_employees integer not null default 0,
      add column total_basic_salary numeric(18,2) not null default 0,
      add column total_allowances numeric(18,2) not null default 0,
      add column total_employee_driver_commission numeric(18,2) not null default 0,
      add column total_earning_adjustments numeric(18,2) not null default 0,
      add column total_deductions numeric(18,2) not null default 0,
      add column total_net_salary numeric(18,2) not null default 0,
      add column total_paid numeric(18,2) not null default 0,
      add column total_outstanding numeric(18,2) not null default 0,
      add column notes text,
      add column created_by_account_id uuid,
      add column calculated_by_account_id uuid,
      add column calculated_at timestamptz,
      add column approved_by_account_id uuid,
      add column approved_at timestamptz,
      add column reversed_by_account_id uuid,
      add column reversed_at timestamptz,
      add column reversal_reason text,
      add column reversal_of_period_id uuid,
      add column version bigint not null default 1,
      add column updated_at timestamptz not null default now();

    update payroll_periods set payroll_month = date_trunc('month', period_start)::date;
    alter table payroll_periods alter column payroll_month set not null;

    alter table payroll_periods
      add constraint payroll_periods_status_check check (
        status in ('draft','calculated','approved','partially_paid','paid','closed','reversed')
      ),
      add constraint payroll_periods_month_check check (
        payroll_month = date_trunc('month', payroll_month)::date
        and payroll_month = date_trunc('month', period_start)::date
        and payroll_month = date_trunc('month', period_end)::date
      ),
      add constraint payroll_periods_totals_check check (
        total_employees >= 0 and total_basic_salary >= 0 and total_allowances >= 0
        and total_employee_driver_commission >= 0 and total_earning_adjustments >= 0
        and total_deductions >= 0 and total_net_salary >= 0 and total_paid >= 0
        and total_outstanding >= 0 and total_paid + total_outstanding = total_net_salary
      ),
      add constraint payroll_periods_creator_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint payroll_periods_calculator_fk foreign key (calculated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint payroll_periods_approver_fk foreign key (approved_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint payroll_periods_reverser_fk foreign key (reversed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint payroll_periods_reversal_fk foreign key (reversal_of_period_id, company_id)
        references payroll_periods(id, company_id) on delete restrict,
      add constraint payroll_periods_reversal_self_check check (
        reversal_of_period_id is null or reversal_of_period_id <> id
      ),
      add constraint payroll_periods_reversal_shape_check check (
        (status <> 'reversed' and reversed_by_account_id is null and reversed_at is null
          and reversal_reason is null)
        or (status = 'reversed' and reversed_by_account_id is not null and reversed_at is not null
          and btrim(reversal_reason) <> '')
      ),
      add constraint payroll_periods_version_positive check (version > 0);

    do $$
    declare conflict_record record;
    begin
      select company_id, payroll_month, count(*) as period_count
        into conflict_record
        from payroll_periods
       group by company_id, payroll_month
      having count(*) > 1
       limit 1;
      if found then
        raise exception 'Conflicting Payroll periods: Company %, month %, records %',
          conflict_record.company_id, conflict_record.payroll_month, conflict_record.period_count;
      end if;
    end;
    $$;
    create unique index payroll_periods_active_month_unique
      on payroll_periods (company_id, payroll_month) where status <> 'reversed';
    create index payroll_periods_status_index on payroll_periods (company_id, status, payroll_month desc);

    alter table payroll_entries drop constraint payroll_entries_amounts_check;
    alter table payroll_entries drop constraint payroll_entries_status_check;
    alter table payroll_entries drop constraint payroll_entries_confirmation_check;
    drop trigger if exists payroll_entries_immutable on payroll_entries;

    alter table payroll_entries rename column basic_salary to basic_salary_snapshot;
    alter table payroll_entries rename column delivered_order_commission to employee_driver_commission;
    alter table payroll_entries rename column allowances to allowance_total;
    alter table payroll_entries rename column deductions to deduction_adjustments_total;
    alter table payroll_entries rename column total_salary to net_salary;
    alter table payroll_entries rename column reversal_of_id to reversal_of_line_id;

    alter table payroll_entries
      add column employee_number_snapshot text,
      add column employee_name_snapshot text,
      add column employee_name_ar_snapshot text,
      add column employment_type_snapshot text,
      add column salary_version_id uuid,
      add column earning_adjustments_total numeric(18,2) not null default 0,
      add column gross_earnings numeric(18,2),
      add column amount_paid numeric(18,2) not null default 0,
      add column outstanding_amount numeric(18,2),
      add column salary_hold_snapshot boolean not null default false,
      add column notes text,
      add column calculated_by_account_id uuid,
      add column calculated_at timestamptz,
      add column approved_by_account_id uuid,
      add column approved_at timestamptz,
      add column reversed_by_account_id uuid,
      add column reversed_at timestamptz,
      add column reversal_reason text,
      add column source_marker text not null default 'legacy',
      add column version bigint not null default 1;

    update payroll_entries pe
       set employee_number_snapshot = e.employee_number,
           employee_name_snapshot = e.name_en,
           employee_name_ar_snapshot = e.name_ar,
           employment_type_snapshot = e.employee_type,
           earning_adjustments_total = 0,
           gross_earnings = pe.basic_salary_snapshot + pe.allowance_total
             + pe.employee_driver_commission,
           outstanding_amount = pe.net_salary,
           approved_by_account_id = pe.confirmed_by_account_id,
           approved_at = pe.confirmed_at,
           status = case when pe.status = 'confirmed' then 'approved' else 'draft' end
      from employees e
     where e.id = pe.employee_id and e.company_id = pe.company_id;

    alter table payroll_entries
      alter column employee_number_snapshot set not null,
      alter column employee_name_snapshot set not null,
      alter column gross_earnings set not null,
      alter column outstanding_amount set not null,
      add constraint payroll_entries_salary_version_fk foreign key (salary_version_id, company_id)
        references employee_salary_versions(id, company_id) on delete restrict,
      add constraint payroll_entries_calculator_fk foreign key (calculated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint payroll_entries_approver_fk foreign key (approved_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint payroll_entries_reverser_fk foreign key (reversed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint payroll_entries_status_check check (
        status in ('draft','calculated','approved','partially_paid','paid','held','reversed')
      ),
      add constraint payroll_entries_source_check check (source_marker in ('legacy','new_payroll')),
      add constraint payroll_entries_amounts_check check (
        basic_salary_snapshot >= 0 and employee_driver_commission >= 0 and allowance_total >= 0
        and earning_adjustments_total >= 0 and deduction_adjustments_total >= 0 and advances >= 0
        and gross_earnings >= 0 and net_salary >= 0 and amount_paid >= 0
        and outstanding_amount >= 0 and amount_paid <= net_salary
        and gross_earnings = basic_salary_snapshot + allowance_total
          + employee_driver_commission + earning_adjustments_total
        and net_salary = gross_earnings - deduction_adjustments_total - advances
        and outstanding_amount = net_salary - amount_paid
      ),
      add constraint payroll_entries_reversal_shape_check check (
        (status <> 'reversed' and reversed_by_account_id is null and reversed_at is null
          and reversal_reason is null)
        or (status = 'reversed' and reversed_by_account_id is not null and reversed_at is not null
          and btrim(reversal_reason) <> '')
      ),
      add constraint payroll_entries_version_positive check (version > 0);

    update payroll_periods p
       set total_employees = totals.employee_count,
           total_basic_salary = totals.basic_salary,
           total_allowances = totals.allowances,
           total_employee_driver_commission = totals.driver_commission,
           total_earning_adjustments = totals.earning_adjustments,
           total_deductions = totals.deductions,
           total_net_salary = totals.net_salary,
           total_paid = totals.amount_paid,
           total_outstanding = totals.outstanding
      from (
        select payroll_period_id,
               count(*)::integer as employee_count,
               coalesce(sum(basic_salary_snapshot), 0) as basic_salary,
               coalesce(sum(allowance_total), 0) as allowances,
               coalesce(sum(employee_driver_commission), 0) as driver_commission,
               coalesce(sum(earning_adjustments_total), 0) as earning_adjustments,
               coalesce(sum(deduction_adjustments_total + advances), 0) as deductions,
               coalesce(sum(net_salary), 0) as net_salary,
               coalesce(sum(amount_paid), 0) as amount_paid,
               coalesce(sum(outstanding_amount), 0) as outstanding
          from payroll_entries
         group by payroll_period_id
      ) totals
     where p.id = totals.payroll_period_id;

    create table payroll_line_allowances (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      payroll_line_id uuid not null,
      allowance_type_id uuid,
      allowance_code_snapshot text not null,
      allowance_name_snapshot text not null,
      allowance_name_ar_snapshot text,
      amount numeric(18,2) not null,
      source_employee_allowance_id uuid,
      created_at timestamptz not null default now(),
      unique (id, company_id),
      unique (company_id, payroll_line_id, allowance_code_snapshot),
      constraint payroll_line_allowances_line_fk foreign key (payroll_line_id, company_id)
        references payroll_entries(id, company_id) on delete restrict,
      constraint payroll_line_allowances_type_fk foreign key (allowance_type_id, company_id)
        references allowance_types(id, company_id) on delete restrict,
      constraint payroll_line_allowances_source_fk foreign key (source_employee_allowance_id, company_id)
        references employee_allowances(id, company_id) on delete restrict,
      constraint payroll_line_allowances_amount_nonnegative check (amount >= 0),
      constraint payroll_line_allowances_code_nonempty check (btrim(allowance_code_snapshot) <> ''),
      constraint payroll_line_allowances_name_nonempty check (btrim(allowance_name_snapshot) <> '')
    );
    create index payroll_line_allowances_line_index
      on payroll_line_allowances (company_id, payroll_line_id);

    create function enforce_payroll_allowance_snapshot_limit() returns trigger language plpgsql as $$
    declare snapshot_count integer;
    begin
      perform 1 from payroll_entries p
       where p.id = new.payroll_line_id and p.company_id = new.company_id
       for update;
      select count(*) into snapshot_count from payroll_line_allowances a
       where a.company_id = new.company_id and a.payroll_line_id = new.payroll_line_id
         and a.id <> new.id;
      if snapshot_count >= 4 then
        raise exception 'A Payroll line cannot have more than four allowance snapshots';
      end if;
      return new;
    end;
    $$;
    create trigger payroll_line_allowances_max_four
      before insert or update on payroll_line_allowances
      for each row execute function enforce_payroll_allowance_snapshot_limit();

    create table payroll_adjustments (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      payroll_period_id uuid not null,
      payroll_line_id uuid not null,
      employee_id uuid not null,
      adjustment_type text not null,
      direction text not null,
      amount numeric(18,2) not null,
      reason text not null,
      source_reference text,
      notes text,
      status text not null default 'active',
      created_by_account_id uuid not null,
      created_at timestamptz not null default now(),
      reversed_by_account_id uuid,
      reversed_at timestamptz,
      reversal_reason text,
      reversal_of_adjustment_id uuid,
      version bigint not null default 1,
      updated_at timestamptz not null default now(),
      unique (id, company_id),
      constraint payroll_adjustments_period_fk foreign key (payroll_period_id, company_id)
        references payroll_periods(id, company_id) on delete restrict,
      constraint payroll_adjustments_line_fk foreign key (payroll_line_id, company_id)
        references payroll_entries(id, company_id) on delete restrict,
      constraint payroll_adjustments_employee_fk foreign key (employee_id, company_id)
        references employees(id, company_id) on delete restrict,
      constraint payroll_adjustments_creator_fk foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint payroll_adjustments_reverser_fk foreign key (reversed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint payroll_adjustments_reversal_fk foreign key (reversal_of_adjustment_id, company_id)
        references payroll_adjustments(id, company_id) on delete restrict,
      constraint payroll_adjustments_type_check check (
        adjustment_type in ('bonus','penalty','unpaid_leave','advance_recovery','correction','other')
      ),
      constraint payroll_adjustments_direction_check check (direction in ('earning','deduction')),
      constraint payroll_adjustments_status_check check (status in ('active','reversed')),
      constraint payroll_adjustments_amount_positive check (amount > 0),
      constraint payroll_adjustments_reason_nonempty check (btrim(reason) <> ''),
      constraint payroll_adjustments_reversal_self_check check (
        reversal_of_adjustment_id is null or reversal_of_adjustment_id <> id
      ),
      constraint payroll_adjustments_reversal_shape_check check (
        (status = 'active' and reversed_by_account_id is null and reversed_at is null
          and reversal_reason is null)
        or (status = 'reversed' and reversed_by_account_id is not null and reversed_at is not null
          and btrim(reversal_reason) <> '')
      ),
      constraint payroll_adjustments_version_positive check (version > 0)
    );
    create index payroll_adjustments_line_index
      on payroll_adjustments (company_id, payroll_line_id, status);

    create function validate_payroll_adjustment_scope() returns trigger language plpgsql as $$
    begin
      if not exists (
        select 1 from payroll_entries l
         where l.id = new.payroll_line_id and l.company_id = new.company_id
           and l.payroll_period_id = new.payroll_period_id
           and l.employee_id = new.employee_id
      ) then
        raise exception 'Payroll adjustment must match its Payroll period, line, Employee, and Company';
      end if;
      return new;
    end;
    $$;
    create trigger payroll_adjustments_scope_guard
      before insert or update on payroll_adjustments
      for each row execute function validate_payroll_adjustment_scope();

    create table payroll_payments (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      payment_number text not null,
      payment_date date not null,
      payment_method text not null default 'cash',
      total_amount numeric(18,2) not null,
      cash_voucher_reference text,
      external_reference text,
      acknowledgement_type text not null,
      acknowledgement_value text,
      notes text,
      status text not null default 'confirmed',
      paid_by_account_id uuid not null,
      idempotency_key text not null,
      request_hash text not null,
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
      constraint payroll_payments_payer_fk foreign key (paid_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint payroll_payments_reverser_fk foreign key (reversed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint payroll_payments_reversal_fk foreign key (reversal_of_payment_id, company_id)
        references payroll_payments(id, company_id) on delete restrict,
      constraint payroll_payments_method_check check (payment_method = 'cash'),
      constraint payroll_payments_status_check check (status in ('confirmed','reversed')),
      constraint payroll_payments_acknowledgement_check check (
        acknowledgement_type in ('checkbox','typed_name','physical_signature')
      ),
      constraint payroll_payments_amount_positive check (total_amount > 0),
      constraint payroll_payments_idempotency_nonempty check (btrim(idempotency_key) <> ''),
      constraint payroll_payments_hash_nonempty check (btrim(request_hash) <> ''),
      constraint payroll_payments_reversal_self_check check (
        reversal_of_payment_id is null or reversal_of_payment_id <> id
      ),
      constraint payroll_payments_reversal_shape_check check (
        (status = 'confirmed' and reversed_by_account_id is null and reversed_at is null
          and reversal_reason is null)
        or (status = 'reversed' and reversed_by_account_id is not null and reversed_at is not null
          and btrim(reversal_reason) <> '')
      ),
      constraint payroll_payments_version_positive check (version > 0)
    );
    create index payroll_payments_date_index on payroll_payments (company_id, payment_date desc);

    create table payroll_payment_allocations (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      payroll_payment_id uuid not null,
      payroll_line_id uuid not null,
      employee_id uuid not null,
      allocated_amount numeric(18,2) not null,
      allocation_order integer not null,
      created_at timestamptz not null default now(),
      reversed_at timestamptz,
      reversal_allocation_id uuid,
      unique (id, company_id),
      unique (company_id, payroll_payment_id, payroll_line_id),
      constraint payroll_payment_allocations_payment_fk
        foreign key (payroll_payment_id, company_id)
        references payroll_payments(id, company_id) on delete restrict,
      constraint payroll_payment_allocations_line_fk foreign key (payroll_line_id, company_id)
        references payroll_entries(id, company_id) on delete restrict,
      constraint payroll_payment_allocations_employee_fk foreign key (employee_id, company_id)
        references employees(id, company_id) on delete restrict,
      constraint payroll_payment_allocations_reversal_fk foreign key (reversal_allocation_id, company_id)
        references payroll_payment_allocations(id, company_id) on delete restrict,
      constraint payroll_payment_allocations_amount_positive check (allocated_amount > 0),
      constraint payroll_payment_allocations_order_positive check (allocation_order > 0),
      constraint payroll_payment_allocations_reversal_self_check check (
        reversal_allocation_id is null or reversal_allocation_id <> id
      )
    );
    create index payroll_payment_allocations_line_index
      on payroll_payment_allocations (company_id, payroll_line_id) where reversed_at is null;

    create function validate_payroll_payment_allocation_scope() returns trigger language plpgsql as $$
    declare
      payment_status text;
      line_employee_id uuid;
      line_status text;
      line_outstanding numeric(18,2);
    begin
      select p.status into payment_status
        from payroll_payments p
       where p.id = new.payroll_payment_id and p.company_id = new.company_id;
      select l.employee_id, l.status, l.outstanding_amount
        into line_employee_id, line_status, line_outstanding
        from payroll_entries l
       where l.id = new.payroll_line_id and l.company_id = new.company_id
       for update;
      if payment_status is null or line_employee_id is null
        or line_employee_id <> new.employee_id then
        raise exception 'Payroll payment allocation scope does not match the Employee and Company';
      end if;
      if payment_status <> 'confirmed' then
        raise exception 'Payroll allocations require a confirmed payment';
      end if;
      if tg_op = 'INSERT' then
        if line_status not in ('approved','partially_paid')
          or line_outstanding <= 0
          or new.allocated_amount > line_outstanding then
          raise exception 'Payroll allocation exceeds the active outstanding salary';
        end if;
      elsif new.payroll_payment_id is distinct from old.payroll_payment_id
        or new.payroll_line_id is distinct from old.payroll_line_id
        or new.allocated_amount is distinct from old.allocated_amount then
        if line_status not in ('approved','partially_paid')
          or line_outstanding <= 0
          or new.allocated_amount > line_outstanding then
          raise exception 'Payroll allocation exceeds the active outstanding salary';
        end if;
      end if;
      return new;
    end;
    $$;
    create trigger payroll_payment_allocations_scope_guard
      before insert or update on payroll_payment_allocations
      for each row execute function validate_payroll_payment_allocation_scope();

    create function validate_payroll_payment_total() returns trigger language plpgsql as $$
    declare
      target_payment_id uuid;
      payment_amount numeric(18,2);
      payment_status text;
      allocation_total numeric(18,2);
    begin
      if tg_table_name = 'payroll_payments' then
        target_payment_id := new.id;
      else
        target_payment_id := new.payroll_payment_id;
      end if;
      select p.total_amount, p.status into payment_amount, payment_status
        from payroll_payments p
       where p.id = target_payment_id and p.company_id = new.company_id;
      select coalesce(sum(a.allocated_amount), 0) into allocation_total
        from payroll_payment_allocations a
       where a.company_id = new.company_id
         and a.payroll_payment_id = target_payment_id
         and a.reversed_at is null;
      if payment_status = 'confirmed' and allocation_total <> payment_amount then
        raise exception 'Payroll payment total must equal its active allocations';
      end if;
      if payment_status = 'reversed' and allocation_total <> 0 then
        raise exception 'Reversed Payroll payments cannot retain active allocations';
      end if;
      return new;
    end;
    $$;
    create constraint trigger payroll_payments_total_guard
      after insert or update on payroll_payments
      deferrable initially deferred
      for each row execute function validate_payroll_payment_total();
    create constraint trigger payroll_payment_allocations_total_guard
      after insert or update on payroll_payment_allocations
      deferrable initially deferred
      for each row execute function validate_payroll_payment_total();

    create function protect_payroll_foundation_records() returns trigger language plpgsql as $$
    declare parent_period_status text;
    begin
      if tg_op = 'DELETE' then
        raise exception 'Payroll financial history cannot be deleted';
      end if;

      if tg_table_name = 'payroll_periods' and old.status in
        ('approved','partially_paid','paid','closed','reversed') then
        if old.status = 'reversed'
          or new.status not in ('approved','partially_paid','paid','closed','reversed')
          or (
            to_jsonb(new) - array[
              'status','total_paid','total_outstanding','closed_by_account_id','closed_at',
              'reversed_by_account_id','reversed_at','reversal_reason','version','updated_at'
            ]::text[]
            is distinct from
            to_jsonb(old) - array[
              'status','total_paid','total_outstanding','closed_by_account_id','closed_at',
              'reversed_by_account_id','reversed_at','reversal_reason','version','updated_at'
            ]::text[]
          ) then
          raise exception 'Approved or finalized Payroll periods are immutable; use settlement or reversal';
        end if;
        return new;
      end if;

      if tg_table_name = 'payroll_entries' and old.status in
        ('approved','partially_paid','paid','held','reversed') then
        if old.status = 'reversed'
          or new.status not in ('approved','partially_paid','paid','held','reversed')
          or (
            to_jsonb(new) - array[
              'status','amount_paid','outstanding_amount','reversed_by_account_id',
              'reversed_at','reversal_reason','version','updated_at'
            ]::text[]
            is distinct from
            to_jsonb(old) - array[
              'status','amount_paid','outstanding_amount','reversed_by_account_id',
              'reversed_at','reversal_reason','version','updated_at'
            ]::text[]
          ) then
          raise exception 'Approved or finalized Payroll lines are immutable; use settlement or reversal';
        end if;
        return new;
      end if;

      if tg_table_name = 'payroll_line_allowances' then
        raise exception 'Payroll allowance snapshots are immutable';
      end if;

      if tg_table_name = 'payroll_adjustments' then
        select p.status into parent_period_status
          from payroll_periods p
         where p.id = old.payroll_period_id and p.company_id = old.company_id;
        if old.status = 'reversed' then
          raise exception 'Reversed Payroll adjustments are immutable';
        end if;
        if parent_period_status in ('approved','partially_paid','paid','closed','reversed') then
          if new.status <> 'reversed'
            or (
              to_jsonb(new) - array[
                'status','reversed_by_account_id','reversed_at','reversal_reason',
                'reversal_of_adjustment_id','version','updated_at'
              ]::text[]
              is distinct from
              to_jsonb(old) - array[
                'status','reversed_by_account_id','reversed_at','reversal_reason',
                'reversal_of_adjustment_id','version','updated_at'
              ]::text[]
            ) then
            raise exception 'Adjustments in approved Payroll are immutable; use reversal';
          end if;
        end if;
        return new;
      end if;

      if tg_table_name = 'payroll_payments' then
        if old.status <> 'confirmed' or new.status <> 'reversed'
          or (
            to_jsonb(new) - array[
              'status','reversed_by_account_id','reversed_at','reversal_reason',
              'reversal_of_payment_id','version','updated_at'
            ]::text[]
            is distinct from
            to_jsonb(old) - array[
              'status','reversed_by_account_id','reversed_at','reversal_reason',
              'reversal_of_payment_id','version','updated_at'
            ]::text[]
          ) then
          raise exception 'Confirmed Payroll payment history is immutable; use reversal';
        end if;
        return new;
      end if;

      if tg_table_name = 'payroll_payment_allocations' then
        if old.reversed_at is not null or new.reversed_at is null
          or (
            to_jsonb(new) - array['reversed_at','reversal_allocation_id']::text[]
            is distinct from
            to_jsonb(old) - array['reversed_at','reversal_allocation_id']::text[]
          ) then
          raise exception 'Payroll payment allocations are immutable; use reversal';
        end if;
        return new;
      end if;

      return new;
    end;
    $$;

    create trigger payroll_periods_foundation_guard
      before update or delete on payroll_periods
      for each row execute function protect_payroll_foundation_records();
    create trigger payroll_entries_foundation_guard
      before update or delete on payroll_entries
      for each row execute function protect_payroll_foundation_records();
    create trigger payroll_line_allowances_immutable
      before update or delete on payroll_line_allowances
      for each row execute function protect_payroll_foundation_records();
    create trigger payroll_adjustments_immutable
      before update or delete on payroll_adjustments
      for each row execute function protect_payroll_foundation_records();
    create trigger payroll_payments_immutable
      before update or delete on payroll_payments
      for each row execute function protect_payroll_foundation_records();
    create trigger payroll_payment_allocations_immutable
      before update or delete on payroll_payment_allocations
      for each row execute function protect_payroll_foundation_records();

    create function protect_used_salary_history() returns trigger language plpgsql as $$
    begin
      if tg_op = 'DELETE' and exists (
        select 1 from payroll_entries p
         where p.company_id = old.company_id and p.salary_version_id = old.id
           and p.status in ('approved','partially_paid','paid','held','reversed')
      ) then
        raise exception 'Salary versions used by approved Payroll cannot be deleted';
      end if;
      if tg_op = 'UPDATE' and exists (
        select 1 from payroll_entries p
         where p.company_id = old.company_id and p.salary_version_id = old.id
           and p.status in ('approved','partially_paid','paid','held','reversed')
      ) and (
        new.basic_salary is distinct from old.basic_salary
        or new.effective_from is distinct from old.effective_from
      ) then
        raise exception 'Salary versions used by approved Payroll cannot be materially changed';
      end if;
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end;
    $$;
    create trigger employee_salary_versions_payroll_guard
      before update or delete on employee_salary_versions
      for each row execute function protect_used_salary_history();

    create function protect_used_employee_allowance() returns trigger language plpgsql as $$
    begin
      if exists (
        select 1 from payroll_line_allowances s
        join payroll_entries p on p.id = s.payroll_line_id and p.company_id = s.company_id
         where s.company_id = old.company_id and s.source_employee_allowance_id = old.id
           and p.status in ('approved','partially_paid','paid','held','reversed')
      ) then
        if tg_op = 'DELETE'
          or new.amount is distinct from old.amount
          or new.allowance_type_id is distinct from old.allowance_type_id
          or new.effective_from is distinct from old.effective_from then
          raise exception 'Allowances used by approved Payroll cannot be materially changed';
        end if;
      end if;
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end;
    $$;
    create trigger employee_allowances_payroll_guard
      before update or delete on employee_allowances
      for each row execute function protect_used_employee_allowance();

    insert into permissions (code, description) values
      ('payroll.view', 'View Employee Payroll'),
      ('payroll.manage', 'Manage Payroll periods, lines, and adjustments'),
      ('payroll.approve', 'Approve calculated Payroll'),
      ('payroll.pay', 'Confirm Employee cash Payroll payments'),
      ('payroll.reverse', 'Reverse Payroll periods, adjustments, and payments')
    on conflict (code) do nothing;

    alter table company_reference_counters drop constraint company_reference_counters_type_check;
    alter table company_reference_counters add constraint company_reference_counters_type_check check (
      reference_type in (
        'order','payment','reconciliation','settlement','journal','payroll','import',
        'trader','area','customer','driver','employee','trader_receivable','trader_collection',
        'payroll_payment'
      )
    );
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from company_reference_counters where reference_type = 'payroll_payment';
    alter table company_reference_counters drop constraint company_reference_counters_type_check;
    alter table company_reference_counters add constraint company_reference_counters_type_check check (
      reference_type in (
        'order','payment','reconciliation','settlement','journal','payroll','import',
        'trader','area','customer','driver','employee','trader_receivable','trader_collection'
      )
    );
    delete from role_permissions where permission_code like 'payroll.%';
    delete from permissions where code like 'payroll.%';

    drop trigger if exists employee_allowances_payroll_guard on employee_allowances;
    drop function if exists protect_used_employee_allowance();
    drop trigger if exists employee_salary_versions_payroll_guard on employee_salary_versions;
    drop function if exists protect_used_salary_history();
    drop trigger if exists payroll_payment_allocations_immutable on payroll_payment_allocations;
    drop trigger if exists payroll_payment_allocations_total_guard on payroll_payment_allocations;
    drop trigger if exists payroll_payments_total_guard on payroll_payments;
    drop function if exists validate_payroll_payment_total();
    drop trigger if exists payroll_payment_allocations_scope_guard on payroll_payment_allocations;
    drop function if exists validate_payroll_payment_allocation_scope();
    drop trigger if exists payroll_payments_immutable on payroll_payments;
    drop trigger if exists payroll_adjustments_immutable on payroll_adjustments;
    drop trigger if exists payroll_adjustments_scope_guard on payroll_adjustments;
    drop function if exists validate_payroll_adjustment_scope();
    drop trigger if exists payroll_line_allowances_immutable on payroll_line_allowances;
    drop trigger if exists payroll_entries_foundation_guard on payroll_entries;
    drop trigger if exists payroll_periods_foundation_guard on payroll_periods;
    drop function if exists protect_payroll_foundation_records();

    drop table if exists payroll_payment_allocations;
    drop table if exists payroll_payments;
    drop table if exists payroll_adjustments;
    drop trigger if exists payroll_line_allowances_max_four on payroll_line_allowances;
    drop function if exists enforce_payroll_allowance_snapshot_limit();
    drop table if exists payroll_line_allowances;

    drop index if exists payroll_periods_status_index;
    drop index if exists payroll_periods_active_month_unique;

    update payroll_entries
       set confirmed_by_account_id = coalesce(
             confirmed_by_account_id, approved_by_account_id,
             reversed_by_account_id, calculated_by_account_id, created_by_account_id
           ),
           confirmed_at = coalesce(
             confirmed_at, approved_at, reversed_at, calculated_at, updated_at, created_at
           )
     where status in ('approved','partially_paid','paid','held','reversed');

    alter table payroll_entries
      drop constraint if exists payroll_entries_version_positive,
      drop constraint if exists payroll_entries_reversal_shape_check,
      drop constraint if exists payroll_entries_amounts_check,
      drop constraint if exists payroll_entries_source_check,
      drop constraint if exists payroll_entries_status_check,
      drop constraint if exists payroll_entries_reverser_fk,
      drop constraint if exists payroll_entries_approver_fk,
      drop constraint if exists payroll_entries_calculator_fk,
      drop constraint if exists payroll_entries_salary_version_fk,
      drop column if exists version,
      drop column if exists source_marker,
      drop column if exists reversal_reason,
      drop column if exists reversed_at,
      drop column if exists reversed_by_account_id,
      drop column if exists approved_at,
      drop column if exists approved_by_account_id,
      drop column if exists calculated_at,
      drop column if exists calculated_by_account_id,
      drop column if exists notes,
      drop column if exists salary_hold_snapshot,
      drop column if exists outstanding_amount,
      drop column if exists amount_paid,
      drop column if exists gross_earnings,
      drop column if exists earning_adjustments_total,
      drop column if exists salary_version_id,
      drop column if exists employment_type_snapshot,
      drop column if exists employee_name_ar_snapshot,
      drop column if exists employee_name_snapshot,
      drop column if exists employee_number_snapshot;

    alter table payroll_entries rename column reversal_of_line_id to reversal_of_id;
    alter table payroll_entries rename column net_salary to total_salary;
    alter table payroll_entries rename column deduction_adjustments_total to deductions;
    alter table payroll_entries rename column allowance_total to allowances;
    alter table payroll_entries rename column employee_driver_commission to delivered_order_commission;
    alter table payroll_entries rename column basic_salary_snapshot to basic_salary;
    update payroll_entries
       set status = case
             when status in ('approved','partially_paid','paid','held','reversed')
               then 'confirmed'
             else 'draft'
           end,
           confirmed_by_account_id = case
             when status in ('approved','partially_paid','paid','held','reversed')
               then confirmed_by_account_id
             else null
           end,
           confirmed_at = case
             when status in ('approved','partially_paid','paid','held','reversed')
               then confirmed_at
             else null
           end;
    alter table payroll_entries add constraint payroll_entries_amounts_check check (
      basic_salary >= 0 and delivered_order_commission >= 0 and allowances >= 0
      and deductions >= 0 and advances >= 0 and total_salary >= 0
      and total_salary = basic_salary + delivered_order_commission + allowances - deductions - advances
    );
    alter table payroll_entries add constraint payroll_entries_status_check
      check (status in ('draft','confirmed'));
    alter table payroll_entries add constraint payroll_entries_confirmation_check check (
      (status = 'draft' and confirmed_by_account_id is null and confirmed_at is null)
      or (status = 'confirmed' and confirmed_by_account_id is not null and confirmed_at is not null)
    );
    create trigger payroll_entries_immutable before update or delete on payroll_entries
      for each row execute function reject_finalized_financial_mutation();

    alter table payroll_periods
      drop constraint if exists payroll_periods_version_positive,
      drop constraint if exists payroll_periods_reversal_shape_check,
      drop constraint if exists payroll_periods_reversal_self_check,
      drop constraint if exists payroll_periods_reversal_fk,
      drop constraint if exists payroll_periods_reverser_fk,
      drop constraint if exists payroll_periods_approver_fk,
      drop constraint if exists payroll_periods_calculator_fk,
      drop constraint if exists payroll_periods_creator_fk,
      drop constraint if exists payroll_periods_totals_check,
      drop constraint if exists payroll_periods_month_check,
      drop constraint if exists payroll_periods_status_check,
      drop column if exists updated_at,
      drop column if exists version,
      drop column if exists reversal_of_period_id,
      drop column if exists reversal_reason,
      drop column if exists reversed_at,
      drop column if exists reversed_by_account_id,
      drop column if exists approved_at,
      drop column if exists approved_by_account_id,
      drop column if exists calculated_at,
      drop column if exists calculated_by_account_id,
      drop column if exists created_by_account_id,
      drop column if exists notes,
      drop column if exists total_outstanding,
      drop column if exists total_paid,
      drop column if exists total_net_salary,
      drop column if exists total_deductions,
      drop column if exists total_earning_adjustments,
      drop column if exists total_employee_driver_commission,
      drop column if exists total_allowances,
      drop column if exists total_basic_salary,
      drop column if exists total_employees,
      drop column if exists calculation_date,
      drop column if exists payroll_month;
    update payroll_periods
       set status = case when status = 'closed' then 'closed' else 'open' end,
           closed_by_account_id = case when status = 'closed' then closed_by_account_id else null end,
           closed_at = case when status = 'closed' then closed_at else null end;
    alter table payroll_periods add constraint payroll_periods_status_check check (status in ('open','closed'));
    alter table payroll_periods add constraint payroll_periods_close_check check (
      (status = 'open' and closed_by_account_id is null and closed_at is null)
      or (status = 'closed' and closed_by_account_id is not null and closed_at is not null)
    );
  `.execute(database);
}
