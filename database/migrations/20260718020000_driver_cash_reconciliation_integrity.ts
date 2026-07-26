import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table driver_reconciliation_expenses
      add column created_by_account_id uuid,
      add column expense_reference text,
      add column recorded_at timestamptz not null default now();
    alter table driver_reconciliation_expenses
      add constraint driver_reconciliation_expenses_actor_fk
        foreign key (created_by_account_id, company_id)
        references accounts (id, company_id) on delete restrict,
      add constraint driver_reconciliation_expenses_reference_nonempty
        check (expense_reference is null or btrim(expense_reference) <> '');
    create index driver_reconciliation_expenses_actor_index
      on driver_reconciliation_expenses (company_id, created_by_account_id);

    alter table driver_reconciliation_payments
      add constraint driver_reconciliation_payments_reference_nonempty
        check (bank_reference is null or btrim(bank_reference) <> '');
    create unique index driver_reconciliation_payments_bank_reference_unique
      on driver_reconciliation_payments (company_id, upper(btrim(bank_reference)))
      where bank_reference is not null;

    create unique index driver_reconciliation_orders_order_unique
      on driver_reconciliation_orders (company_id, order_id);

    create function protect_driver_reconciliation_reference() returns trigger language plpgsql as $$
    begin
      if new.reconciliation_number is distinct from old.reconciliation_number then
        raise exception using errcode = '23514', message = 'Driver reconciliation number is immutable';
      end if;
      return new;
    end;
    $$;
    create trigger driver_reconciliations_reference_immutable
      before update of reconciliation_number on driver_reconciliations
      for each row execute function protect_driver_reconciliation_reference();

    create function normalize_driver_reconciliation_reference() returns trigger language plpgsql as $$
    begin
      if tg_table_name = 'driver_reconciliation_payments' then
        if new.bank_reference is not null then
          new.bank_reference := btrim(new.bank_reference);
          if new.bank_reference = '' then
            raise exception using errcode = '23514', message = 'Bank Reference is required for Bank Transfer payments';
          end if;
        end if;
      elsif tg_table_name = 'driver_reconciliation_expenses' then
        if new.expense_reference is not null then
          new.expense_reference := btrim(new.expense_reference);
          if new.expense_reference = '' then
            new.expense_reference := null;
          end if;
        end if;
      end if;
      return new;
    end;
    $$;
    create trigger driver_reconciliation_payments_reference_normalize
      before insert or update of bank_reference on driver_reconciliation_payments
      for each row execute function normalize_driver_reconciliation_reference();
    create trigger driver_reconciliation_expenses_reference_normalize
      before insert or update of expense_reference on driver_reconciliation_expenses
      for each row execute function normalize_driver_reconciliation_reference();
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists driver_reconciliation_expenses_reference_normalize
      on driver_reconciliation_expenses;
    drop trigger if exists driver_reconciliation_payments_reference_normalize
      on driver_reconciliation_payments;
    drop function if exists normalize_driver_reconciliation_reference();

    drop trigger if exists driver_reconciliations_reference_immutable on driver_reconciliations;
    drop function if exists protect_driver_reconciliation_reference();

    drop index if exists driver_reconciliation_orders_order_unique;
    drop index if exists driver_reconciliation_payments_bank_reference_unique;
    alter table driver_reconciliation_payments
      drop constraint if exists driver_reconciliation_payments_reference_nonempty;

    drop index if exists driver_reconciliation_expenses_actor_index;
    alter table driver_reconciliation_expenses
      drop constraint if exists driver_reconciliation_expenses_reference_nonempty,
      drop constraint if exists driver_reconciliation_expenses_actor_fk,
      drop column if exists recorded_at,
      drop column if exists expense_reference,
      drop column if exists created_by_account_id;
  `.execute(database);
}
