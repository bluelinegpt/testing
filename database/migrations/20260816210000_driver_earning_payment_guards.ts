import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/** Database-level paid-once and source-eligibility guarantees. */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create function validate_employee_variable_earning_allocation()
      returns trigger language plpgsql as $$
    declare source_employee uuid; source_period uuid; active_total numeric(18,2);
    begin
      if new.source_type='delivery' then
        select employee_id,payroll_period_id into source_employee,source_period
          from employee_order_earnings where id=new.employee_order_earning_id and company_id=new.company_id;
      else
        select employee_id,payroll_period_id into source_employee,source_period
          from employee_driver_collection_facts where id=new.employee_collection_fact_id and company_id=new.company_id;
      end if;
      if source_period is not null then
        raise exception using errcode='23514',message='variable_earning_source_already_allocated_to_payroll';
      end if;
      if not exists(select 1 from employee_variable_earning_payments p
        where p.id=new.payment_id and p.company_id=new.company_id and p.employee_id=source_employee
          and p.status='confirmed') then
        raise exception using errcode='23514',message='variable_earning_payment_employee_mismatch';
      end if;
      select coalesce(sum(a.allocated_amount),0) into active_total
        from employee_variable_earning_payment_allocations a
       where a.company_id=new.company_id and a.reversed_at is null and a.id<>new.id
         and ((new.source_type='delivery' and a.employee_order_earning_id=new.employee_order_earning_id)
           or (new.source_type='collection' and a.employee_collection_fact_id=new.employee_collection_fact_id));
      if active_total+new.allocated_amount>new.source_gross_amount then
        raise exception using errcode='23514',message='variable_earning_source_overpaid';
      end if;
      return new;
    end $$;
    create trigger employee_variable_earning_allocation_guard
      before insert or update on employee_variable_earning_payment_allocations
      for each row execute function validate_employee_variable_earning_allocation();

    create function validate_employee_variable_payment_total()
      returns trigger language plpgsql as $$
    declare target_payment uuid; target_company uuid; expected numeric(18,2); allocated numeric(18,2);
    begin
      target_payment:=coalesce(new.payment_id,old.payment_id); target_company:=coalesce(new.company_id,old.company_id);
      select case when status='reversed' then 0 else amount_paid end into expected
        from employee_variable_earning_payments where id=target_payment and company_id=target_company;
      select coalesce(sum(allocated_amount),0) into allocated
        from employee_variable_earning_payment_allocations
       where payment_id=target_payment and company_id=target_company and reversed_at is null;
      if allocated<>expected then
        raise exception using errcode='23514',message='variable_earning_payment_allocation_total_mismatch';
      end if;
      return null;
    end $$;
    create constraint trigger employee_variable_payment_total_guard
      after insert or update or delete on employee_variable_earning_payment_allocations
      deferrable initially deferred for each row
      execute function validate_employee_variable_payment_total();
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists employee_variable_payment_total_guard on employee_variable_earning_payment_allocations;
    drop trigger if exists employee_variable_earning_allocation_guard on employee_variable_earning_payment_allocations;
    drop function if exists validate_employee_variable_payment_total();
    drop function if exists validate_employee_variable_earning_allocation();
  `.execute(database);
}
