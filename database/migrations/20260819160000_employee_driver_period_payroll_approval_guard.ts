import { type Kysely, sql } from "kysely";

type Database = Record<string, never>;

export async function up(database: Kysely<Database>): Promise<void> {
  await sql`
    create function validate_employee_driver_period_payroll_approval()
      returns trigger language plpgsql as $$
    declare conflict_period uuid;
    begin
      if old.approved_at is null and new.approved_at is not null then
        select pa.period_id into conflict_period
          from employee_driver_earning_period_payroll_allocations pa
          join employee_driver_earning_periods p on p.id=pa.period_id and p.company_id=pa.company_id
         where pa.company_id=new.company_id and pa.payroll_entry_id=new.id and pa.reversed_at is null
           and pa.allocated_amount+coalesce((select sum(ia.allocated_amount)
             from employee_driver_earning_period_payment_allocations ia
             join employee_variable_earning_payments ip on ip.id=ia.payment_id and ip.company_id=ia.company_id
             where ia.company_id=pa.company_id and ia.period_id=pa.period_id
               and ia.reversed_at is null and ip.status='confirmed'),0)>p.total_earnings
         limit 1 for update of p;
        if conflict_period is not null then
          raise exception using errcode='23514',message='employee_driver_period_changed_recalculate_payroll';
        end if;
      end if;
      return new;
    end $$;
    create trigger employee_driver_period_payroll_approval_guard
      before update of approved_at on payroll_entries
      for each row execute function validate_employee_driver_period_payroll_approval();
  `.execute(database);
}

export async function down(database: Kysely<Database>): Promise<void> {
  await sql`drop trigger if exists employee_driver_period_payroll_approval_guard on payroll_entries;
    drop function if exists validate_employee_driver_period_payroll_approval()`.execute(database);
}
