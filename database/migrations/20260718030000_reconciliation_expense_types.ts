import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table expense_types add column display_name text;
    update expense_types set display_name = name_en where display_name is null;

    insert into expense_types (company_id, code, name_en, display_name)
    select company.id, seed.code, seed.name, seed.name
      from companies company
      cross join (values
        ('PETROL', 'Petrol'),
        ('WATER', 'Water'),
        ('PARKING', 'Parking'),
        ('VEHICLE', 'Vehicle-related'),
        ('OTHER', 'Other')
      ) as seed (code, name)
    on conflict (company_id, lower(code)) do nothing;

    alter table expense_types
      alter column display_name set not null,
      add constraint expense_types_display_name_nonempty check (btrim(display_name) <> ''),
      add constraint expense_types_code_format check (code ~ '^[A-Z][A-Z0-9_-]{1,31}$');
    create unique index expense_types_display_name_unique
      on expense_types (company_id, lower(btrim(display_name)));

    create function normalize_expense_type_name() returns trigger language plpgsql as $$
    begin
      if tg_op = 'UPDATE' and new.code is distinct from old.code then
        raise exception using errcode = '23514', message = 'Expense Type code is immutable';
      end if;
      new.display_name := btrim(new.display_name);
      if new.display_name = '' then
        raise exception using errcode = '23514', message = 'Expense Type Name is required';
      end if;
      new.name_en := new.display_name;
      return new;
    end;
    $$;
    create trigger expense_types_name_guard
      before insert or update on expense_types
      for each row execute function normalize_expense_type_name();

    create function validate_reconciliation_expense_description() returns trigger language plpgsql as $$
    declare
      expense_type_code text;
    begin
      if new.description is not null then
        new.description := btrim(new.description);
        if new.description = '' then
          new.description := null;
        end if;
      end if;
      select code into expense_type_code from expense_types
       where id = new.expense_type_id and company_id = new.company_id;
      if expense_type_code is null then
        raise exception using errcode = '23514', message = 'Expense Type does not belong to the Company';
      end if;
      if upper(expense_type_code) = 'OTHER' and new.description is null then
        raise exception using errcode = '23514', message = 'A description is required for Other expenses';
      end if;
      return new;
    end;
    $$;
    create trigger driver_reconciliation_expenses_description_guard
      before insert or update of company_id, expense_type_id, description
      on driver_reconciliation_expenses
      for each row execute function validate_reconciliation_expense_description();
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists driver_reconciliation_expenses_description_guard
      on driver_reconciliation_expenses;
    drop function if exists validate_reconciliation_expense_description();

    drop trigger if exists expense_types_name_guard on expense_types;
    drop function if exists normalize_expense_type_name();

    drop index if exists expense_types_display_name_unique;
    alter table expense_types
      drop constraint if exists expense_types_code_format,
      drop constraint if exists expense_types_display_name_nonempty,
      drop column if exists display_name;
  `.execute(database);
}
