import { type Kysely, sql } from "kysely";

type Database = Record<string, never>;

export async function up(database: Kysely<Database>): Promise<void> {
  await sql`
    create table employee_driver_earning_period_payroll_allocations(
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id),
      period_id uuid not null,
      payroll_entry_id uuid not null,
      allocated_amount numeric(18,2) not null check(allocated_amount>=0),
      reversed_at timestamptz,
      created_at timestamptz not null default now(),
      foreign key(period_id,company_id) references employee_driver_earning_periods(id,company_id),
      foreign key(payroll_entry_id,company_id) references payroll_entries(id,company_id)
    );
    create unique index employee_driver_period_active_payroll_allocation
      on employee_driver_earning_period_payroll_allocations(company_id,period_id)
      where reversed_at is null;

    create function validate_employee_driver_period_payroll_allocation()
      returns trigger language plpgsql as $$
    declare earned numeric(18,2); interim numeric(18,2); period_employee uuid; line_employee uuid;
    begin
      select total_earnings,employee_id into earned,period_employee
        from employee_driver_earning_periods where id=new.period_id and company_id=new.company_id
          and status<>'reversed' for update;
      select employee_id into line_employee from payroll_entries
        where id=new.payroll_entry_id and company_id=new.company_id;
      if period_employee is null or line_employee is distinct from period_employee then
        raise exception using errcode='23514',message='employee_driver_period_payroll_mismatch';
      end if;
      select coalesce(sum(a.allocated_amount),0) into interim
        from employee_driver_earning_period_payment_allocations a
        join employee_variable_earning_payments p on p.id=a.payment_id and p.company_id=a.company_id
       where a.company_id=new.company_id and a.period_id=new.period_id
         and a.reversed_at is null and p.status='confirmed';
      if interim+new.allocated_amount>earned then
        raise exception using errcode='23514',message='employee_driver_earning_period_overallocated';
      end if;
      return new;
    end $$;
    create trigger employee_driver_period_payroll_allocation_guard
      before insert or update on employee_driver_earning_period_payroll_allocations
      for each row execute function validate_employee_driver_period_payroll_allocation();
  `.execute(database);
}

export async function down(database: Kysely<Database>): Promise<void> {
  await sql`drop trigger if exists employee_driver_period_payroll_allocation_guard
      on employee_driver_earning_period_payroll_allocations;
    drop function if exists validate_employee_driver_period_payroll_allocation();
    drop table if exists employee_driver_earning_period_payroll_allocations`.execute(database);
}
