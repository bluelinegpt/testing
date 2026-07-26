import { type Kysely, sql } from "kysely";

/**
 * Employee is the master workforce entity; "Driver" is one configurable role.
 *
 * Adds a Company-scoped, configurable `employee_roles` list (Customer Service,
 * Driver, Warehouse, ...). Exactly the roles flagged `is_driver_role` make the
 * Employee an operational Driver as well. `employees.employee_role_id` records
 * each employee's role.
 *
 * Because every Driver is now created from an Employee, an outsourced Driver is
 * linked to its backing Employee — which the old drivers_employee_consistency
 * check forbade — so that check is relaxed to allow it.
 */
export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    create table employee_roles (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      code text not null,
      name_en text not null,
      name_ar text,
      is_driver_role boolean not null default false,
      is_active boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version bigint not null default 1,
      unique (id, company_id),
      constraint employee_roles_code_format check (code ~ '^[A-Z0-9_]{2,40}$'),
      constraint employee_roles_name_nonempty check (btrim(name_en) <> ''),
      constraint employee_roles_version_positive check (version > 0)
    );
    create unique index employee_roles_code_unique on employee_roles (company_id, lower(code));
    create unique index employee_roles_name_unique
      on employee_roles (company_id, lower(btrim(name_en)));
  `.execute(database);

  // Seed a starter set per Company. Re-running is a no-op.
  await sql`
    insert into employee_roles (company_id, code, name_en, name_ar, is_driver_role)
    select c.id, r.code, r.name_en, r.name_ar, r.is_driver_role
      from companies c
      cross join (values
        ('DRIVER', 'Driver', 'سائق', true),
        ('CUSTOMER_SERVICE', 'Customer Service', 'خدمة العملاء', false),
        ('WAREHOUSE', 'Warehouse', 'المستودع', false),
        ('OPERATIONS', 'Operations', 'العمليات', false),
        ('ACCOUNTS', 'Accounts', 'الحسابات', false)
      ) as r(code, name_en, name_ar, is_driver_role)
    on conflict (company_id, lower(code)) do nothing;
  `.execute(database);

  await sql`
    alter table employees add column employee_role_id uuid;
    alter table employees add constraint employees_role_fk
      foreign key (employee_role_id, company_id)
      references employee_roles (id, company_id) on delete restrict;
    create index employees_role_index on employees (company_id, employee_role_id);
  `.execute(database);

  await sql`
    alter table drivers drop constraint drivers_employee_consistency;
    alter table drivers add constraint drivers_employee_consistency check (
      (driver_type = 'employee'
        and employee_id is not null
        and outsourced_fee_per_delivered_order is null)
      or (driver_type = 'outsourced'
        and outsourced_fee_per_delivered_order is not null)
    );
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`
    alter table drivers drop constraint drivers_employee_consistency;
    alter table drivers add constraint drivers_employee_consistency check (
      (driver_type = 'employee' and employee_id is not null
        and outsourced_fee_per_delivered_order is null)
      or (driver_type = 'outsourced' and employee_id is null)
    );
  `.execute(database);

  await sql`
    alter table employees drop constraint if exists employees_role_fk;
    drop index if exists employees_role_index;
    alter table employees drop column if exists employee_role_id;
    drop table if exists employee_roles;
  `.execute(database);
}
