import { type Kysely, sql } from "kysely";

type Database = Record<string, never>;

export async function up(database: Kysely<Database>): Promise<void> {
  await sql`
    create table employee_driver_earning_period_payment_allocations (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id),
      period_id uuid not null references employee_driver_earning_periods(id),
      payment_id uuid not null references employee_variable_earning_payments(id),
      allocated_amount numeric(18,2) not null check (allocated_amount > 0),
      reversed_at timestamptz,
      created_at timestamptz not null default now(),
      unique(company_id, payment_id)
    );
    create index employee_driver_period_payment_period_idx
      on employee_driver_earning_period_payment_allocations(company_id,period_id)
      where reversed_at is null;

    create function validate_employee_driver_period_payment_allocation()
      returns trigger language plpgsql as $$
    declare earned numeric(18,2); allocated numeric(18,2); period_employee uuid;
    begin
      select total_earnings,employee_id into earned,period_employee
        from employee_driver_earning_periods
       where id=new.period_id and company_id=new.company_id and status<>'reversed'
       for update;
      if period_employee is null then
        raise exception using errcode='23514',message='employee_driver_earning_period_unavailable';
      end if;
      if not exists(select 1 from employee_variable_earning_payments p
        where p.id=new.payment_id and p.company_id=new.company_id
          and p.employee_id=period_employee and p.status='confirmed'
          and p.amount_paid=new.allocated_amount) then
        raise exception using errcode='23514',message='employee_driver_period_payment_mismatch';
      end if;
      select coalesce(sum(a.allocated_amount),0) into allocated
        from employee_driver_earning_period_payment_allocations a
       where a.company_id=new.company_id and a.period_id=new.period_id
         and a.reversed_at is null and a.id<>new.id;
      if allocated+new.allocated_amount>earned then
        raise exception using errcode='23514',message='employee_driver_earning_period_overpaid';
      end if;
      return new;
    end $$;
    create trigger employee_driver_period_payment_allocation_guard
      before insert or update on employee_driver_earning_period_payment_allocations
      for each row execute function validate_employee_driver_period_payment_allocation();
  `.execute(database);
}

export async function down(database: Kysely<Database>): Promise<void> {
  await sql`
    drop trigger if exists employee_driver_period_payment_allocation_guard
      on employee_driver_earning_period_payment_allocations;
    drop function if exists validate_employee_driver_period_payment_allocation();
    drop table if exists employee_driver_earning_period_payment_allocations;
  `.execute(database);
}
