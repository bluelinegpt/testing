import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Payroll Prompt 2: additive operational fields and exception history.
 * Prompt 1 foundation migrations remain unchanged.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table idempotency_records
      add column response_body jsonb;

    alter table payroll_periods
      add column period_reference text;
    with ranked as (
      select id,
             row_number() over (
               partition by company_id, payroll_month
               order by created_at, id
             ) as revision
        from payroll_periods
    )
    update payroll_periods p
       set period_reference =
         'PAY-' || to_char(p.payroll_month, 'YYYY-MM') ||
         case when ranked.revision = 1 then '' else '-R' || ranked.revision::text end
      from ranked
     where ranked.id = p.id;
    alter table payroll_periods
      alter column period_reference set not null,
      add constraint payroll_periods_reference_nonempty
        check (btrim(period_reference) <> ''),
      add constraint payroll_periods_reference_unique
        unique (company_id, period_reference);

    alter table payroll_entries
      add column department_snapshot text,
      add column salary_hold_reason_snapshot text,
      add column salary_hold_from_snapshot date,
      add column salary_hold_to_snapshot date;
    update payroll_entries p
       set department_snapshot = e.department,
           salary_hold_reason_snapshot = case
             when p.salary_hold_snapshot then e.salary_hold_reason else null
           end,
           salary_hold_from_snapshot = case
             when p.salary_hold_snapshot then e.salary_hold_from else null
           end,
           salary_hold_to_snapshot = case
             when p.salary_hold_snapshot then e.salary_hold_to else null
           end
      from employees e
     where e.id = p.employee_id and e.company_id = p.company_id;
    alter table payroll_entries
      add constraint payroll_entries_hold_snapshot_check check (
        (not salary_hold_snapshot)
        or (
          btrim(coalesce(salary_hold_reason_snapshot, '')) <> ''
          and salary_hold_from_snapshot is not null
          and (
            salary_hold_to_snapshot is null
            or salary_hold_to_snapshot >= salary_hold_from_snapshot
          )
        )
      );

    alter table payroll_commission_links
      add column source_marker text not null default 'legacy',
      add constraint payroll_commission_links_source_check
        check (source_marker in ('legacy','new_payroll'));
    alter table payroll_commission_links
      alter column source_marker set default 'new_payroll';

    alter table payroll_payments
      add column payroll_period_id uuid;
    alter table payroll_payments
      add constraint payroll_payments_period_fk
        foreign key (payroll_period_id, company_id)
        references payroll_periods(id, company_id) on delete restrict;
    do $$
    begin
      if exists (select 1 from payroll_payments where payroll_period_id is null) then
        raise exception 'Existing Payroll payments require a reviewed period link before Payroll Prompt 2';
      end if;
    end;
    $$;
    alter table payroll_payments
      alter column payroll_period_id set not null;
    create index payroll_payments_period_index
      on payroll_payments (company_id, payroll_period_id, payment_date desc);

    create table payroll_calculation_exceptions (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      payroll_period_id uuid not null,
      calculation_run_id uuid not null,
      employee_id uuid,
      employee_number_snapshot text,
      employee_name_snapshot text,
      exception_code text not null,
      message text not null,
      category text not null,
      severity text not null,
      status text not null default 'active',
      created_at timestamptz not null default now(),
      resolved_at timestamptz,
      unique (id, company_id),
      constraint payroll_calculation_exceptions_period_fk
        foreign key (payroll_period_id, company_id)
        references payroll_periods(id, company_id) on delete restrict,
      constraint payroll_calculation_exceptions_employee_fk
        foreign key (employee_id, company_id)
        references employees(id, company_id) on delete restrict,
      constraint payroll_calculation_exceptions_code_nonempty
        check (btrim(exception_code) <> ''),
      constraint payroll_calculation_exceptions_message_nonempty
        check (btrim(message) <> ''),
      constraint payroll_calculation_exceptions_severity_check
        check (severity in ('blocking','warning')),
      constraint payroll_calculation_exceptions_status_check
        check (status in ('active','resolved')),
      constraint payroll_calculation_exceptions_resolution_check check (
        (status = 'active' and resolved_at is null)
        or (status = 'resolved' and resolved_at is not null)
      )
    );
    create index payroll_calculation_exceptions_period_index
      on payroll_calculation_exceptions (
        company_id, payroll_period_id, status, severity, created_at
      );

    create or replace function protect_payroll_foundation_records()
      returns trigger language plpgsql as $$
    declare
      parent_period_status text;
      parent_line_status text;
      parent_line_approved_at timestamptz;
    begin
      if tg_op = 'INSERT' then
        if tg_table_name = 'payroll_entries' then
          select p.status into parent_period_status
            from payroll_periods p
           where p.id = new.payroll_period_id and p.company_id = new.company_id;
          if parent_period_status not in ('draft','calculated') then
            raise exception 'Payroll lines cannot be added after period approval';
          end if;
        elsif tg_table_name = 'payroll_line_allowances' then
          select l.status, l.approved_at
            into parent_line_status, parent_line_approved_at
            from payroll_entries l
           where l.id = new.payroll_line_id and l.company_id = new.company_id;
          if parent_line_status not in ('draft','calculated','held')
            or parent_line_approved_at is not null then
            raise exception 'Approved Payroll allowance snapshots are immutable';
          end if;
        elsif tg_table_name = 'payroll_adjustments' then
          select p.status into parent_period_status
            from payroll_periods p
           where p.id = new.payroll_period_id and p.company_id = new.company_id;
          if parent_period_status not in ('draft','calculated') then
            raise exception 'Adjustments cannot be added after Payroll approval';
          end if;
        end if;
        return new;
      end if;

      if tg_op = 'DELETE' then
        if tg_table_name = 'payroll_entries'
          and old.status in ('draft','calculated','held')
          and old.approved_at is null then
          return old;
        end if;
        if tg_table_name = 'payroll_line_allowances' then
          select l.status, l.approved_at
            into parent_line_status, parent_line_approved_at
            from payroll_entries l
           where l.id = old.payroll_line_id and l.company_id = old.company_id;
          if parent_line_status in ('draft','calculated','held')
            and parent_line_approved_at is null then
            return old;
          end if;
        end if;
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

      if tg_table_name = 'payroll_entries' and (
        old.status in ('approved','partially_paid','paid','reversed')
        or (old.status = 'held' and old.approved_at is not null)
      ) then
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
        select l.status, l.approved_at
          into parent_line_status, parent_line_approved_at
          from payroll_entries l
         where l.id = old.payroll_line_id and l.company_id = old.company_id;
        if parent_line_status in ('draft','calculated','held')
          and parent_line_approved_at is null then
          return new;
        end if;
        raise exception 'Approved Payroll allowance snapshots are immutable';
      end if;

      if tg_table_name = 'payroll_adjustments' then
        select p.status into parent_period_status
          from payroll_periods p
         where p.id = old.payroll_period_id and p.company_id = old.company_id;
        if old.status = 'reversed' then
          raise exception 'Reversed Payroll adjustments are immutable';
        end if;
        if parent_period_status in ('approved','partially_paid','paid','closed','reversed') then
          raise exception 'Adjustments in approved Payroll are immutable';
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

    drop trigger payroll_entries_foundation_guard on payroll_entries;
    create trigger payroll_entries_foundation_guard
      before insert or update or delete on payroll_entries
      for each row execute function protect_payroll_foundation_records();
    drop trigger payroll_line_allowances_immutable on payroll_line_allowances;
    create trigger payroll_line_allowances_immutable
      before insert or update or delete on payroll_line_allowances
      for each row execute function protect_payroll_foundation_records();
    drop trigger payroll_adjustments_immutable on payroll_adjustments;
    create trigger payroll_adjustments_immutable
      before insert or update or delete on payroll_adjustments
      for each row execute function protect_payroll_foundation_records();

    create function protect_payroll_commission_link_history()
      returns trigger language plpgsql as $$
    declare
      line_source text;
      line_status text;
    begin
      if tg_op = 'INSERT' then
        select p.status, p.source_marker into line_status, line_source
          from payroll_entries p
         where p.id = new.payroll_entry_id and p.company_id = new.company_id;
        if line_status not in ('draft','calculated','held')
          or new.source_marker <> line_source then
          raise exception 'Payroll commission links can be added only during calculation';
        end if;
        return new;
      end if;
      if old.source_marker = 'legacy' then
        raise exception 'Legacy Payroll commission links are read-only';
      end if;
      select p.status into line_status
        from payroll_entries p
       where p.id = old.payroll_entry_id and p.company_id = old.company_id;
      if line_status not in ('draft','calculated','held') then
        raise exception 'Approved Payroll commission links are immutable';
      end if;
      if tg_op = 'DELETE' then return old; end if;
      return new;
    end;
    $$;
    drop trigger if exists payroll_commission_links_legacy_immutable
      on payroll_commission_links;
    create trigger payroll_commission_links_immutable
      before insert or update or delete on payroll_commission_links
      for each row execute function protect_payroll_commission_link_history();
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists payroll_commission_links_immutable
      on payroll_commission_links;
    drop function if exists protect_payroll_commission_link_history();
    create trigger payroll_commission_links_legacy_immutable
      before update or delete on payroll_commission_links
      for each row execute function protect_legacy_commission_history();

    create or replace function protect_payroll_foundation_records()
      returns trigger language plpgsql as $$
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

    drop trigger payroll_adjustments_immutable on payroll_adjustments;
    create trigger payroll_adjustments_immutable
      before update or delete on payroll_adjustments
      for each row execute function protect_payroll_foundation_records();
    drop trigger payroll_line_allowances_immutable on payroll_line_allowances;
    create trigger payroll_line_allowances_immutable
      before update or delete on payroll_line_allowances
      for each row execute function protect_payroll_foundation_records();
    drop trigger payroll_entries_foundation_guard on payroll_entries;
    create trigger payroll_entries_foundation_guard
      before update or delete on payroll_entries
      for each row execute function protect_payroll_foundation_records();

    drop table if exists payroll_calculation_exceptions;
    drop index if exists payroll_payments_period_index;
    alter table payroll_payments
      drop constraint if exists payroll_payments_period_fk,
      drop column if exists payroll_period_id;
    alter table payroll_commission_links
      drop constraint if exists payroll_commission_links_source_check,
      drop column if exists source_marker;
    alter table payroll_entries
      drop constraint if exists payroll_entries_hold_snapshot_check,
      drop column if exists salary_hold_to_snapshot,
      drop column if exists salary_hold_from_snapshot,
      drop column if exists salary_hold_reason_snapshot,
      drop column if exists department_snapshot;
    alter table payroll_periods
      drop constraint if exists payroll_periods_reference_unique,
      drop constraint if exists payroll_periods_reference_nonempty,
      drop column if exists period_reference;
    alter table idempotency_records
      drop column if exists response_body;
  `.execute(database);
}
