import { type Kysely, sql } from "kysely";

type Database = Record<string, never>;

export async function up(database: Kysely<Database>): Promise<void> {
  await sql`
    create or replace function validate_employee_driver_period_payment_allocation()
      returns trigger language plpgsql as $$
    declare earned numeric(18,2); allocated numeric(18,2); payroll_allocated numeric(18,2);
      period_employee uuid;
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
      select coalesce(sum(a.allocated_amount),0) into payroll_allocated
        from employee_driver_earning_period_payroll_allocations a
        join payroll_entries p on p.id=a.payroll_entry_id and p.company_id=a.company_id
       where a.company_id=new.company_id and a.period_id=new.period_id
         and a.reversed_at is null and p.approved_at is not null;
      if allocated+payroll_allocated+new.allocated_amount>earned then
        raise exception using errcode='23514',message='employee_driver_earning_period_overpaid';
      end if;
      return new;
    end $$;
  `.execute(database);
}

export async function down(database: Kysely<Database>): Promise<void> {
  // The preceding migration's stricter-than-legacy allocation function remains required.
  void database;
}
