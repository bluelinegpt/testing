import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Payroll Prompt 1A: Employee eligibility, Salary Hold, and effective-dated
 * salary/allowance audit foundations. Existing Employees remain ineligible
 * until explicitly enabled; no existing salary history is rewritten.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table employees
      add column payroll_eligible boolean not null default false,
      add column salary_hold boolean not null default false,
      add column salary_hold_reason text,
      add column salary_hold_from date,
      add column salary_hold_to date,
      add constraint employees_salary_hold_shape_check check (
        not salary_hold
        or (btrim(coalesce(salary_hold_reason, '')) <> '' and salary_hold_from is not null)
      ),
      add constraint employees_salary_hold_dates_check check (
        salary_hold_to is null or salary_hold_from is null or salary_hold_to >= salary_hold_from
      );

    create index employees_payroll_eligible_index
      on employees (company_id, is_active, payroll_eligible)
      where payroll_eligible;
    create index employees_salary_hold_index
      on employees (company_id, salary_hold, salary_hold_from, salary_hold_to)
      where salary_hold;

    alter table allowance_types add column name_ar text;

    alter table employee_salary_versions
      add column updated_by_account_id uuid,
      add column updated_at timestamptz not null default now(),
      add column notes text,
      add column version bigint not null default 1,
      add constraint employee_salary_versions_updater_fk
        foreign key (updated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      add constraint employee_salary_versions_version_positive check (version > 0);

    alter table employee_allowances
      add column updated_by_account_id uuid,
      add column notes text,
      add constraint employee_allowances_updater_fk
        foreign key (updated_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict;

    create function prevent_employee_allowance_overlap() returns trigger language plpgsql as $$
    begin
      if new.is_active and exists (
        select 1
          from employee_allowances a
         where a.company_id = new.company_id
           and a.employee_id = new.employee_id
           and a.allowance_type_id = new.allowance_type_id
           and a.id <> new.id
           and a.is_active
           and daterange(a.effective_from, coalesce(a.effective_to + 1, 'infinity'::date), '[)')
             && daterange(new.effective_from, coalesce(new.effective_to + 1, 'infinity'::date), '[)')
      ) then
        raise exception 'Employee allowance effective periods cannot overlap for the same allowance type';
      end if;
      return new;
    end;
    $$;

    create trigger employee_allowances_no_overlap
      before insert or update on employee_allowances
      for each row execute function prevent_employee_allowance_overlap();

    create index employee_allowances_type_effective_index
      on employee_allowances (
        company_id, employee_id, allowance_type_id, effective_from desc
      );
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists employee_allowances_type_effective_index;
    drop trigger if exists employee_allowances_no_overlap on employee_allowances;
    drop function if exists prevent_employee_allowance_overlap();

    alter table employee_allowances
      drop constraint if exists employee_allowances_updater_fk,
      drop column if exists notes,
      drop column if exists updated_by_account_id;

    alter table employee_salary_versions
      drop constraint if exists employee_salary_versions_version_positive,
      drop constraint if exists employee_salary_versions_updater_fk,
      drop column if exists version,
      drop column if exists notes,
      drop column if exists updated_at,
      drop column if exists updated_by_account_id;

    alter table allowance_types drop column if exists name_ar;

    drop index if exists employees_salary_hold_index;
    drop index if exists employees_payroll_eligible_index;
    alter table employees
      drop constraint if exists employees_salary_hold_shape_check,
      drop constraint if exists employees_salary_hold_dates_check,
      drop column if exists salary_hold_to,
      drop column if exists salary_hold_from,
      drop column if exists salary_hold_reason,
      drop column if exists salary_hold,
      drop column if exists payroll_eligible;
  `.execute(database);
}
