import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/** Permit identifier replacement only inside the audited Hold-reactivation transaction. */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function protect_order_manual_identifiers() returns trigger as $$
    declare
      hold_reactivation boolean := coalesce(current_setting('blueline.hold_reactivation', true), '') = 'on';
    begin
      if hold_reactivation
         and old.delivery_status = 'hold'
         and new.delivery_status in ('in_branch', 'assigned_to_driver', 'out_for_delivery')
         and new.reference_number is not distinct from old.reference_number
         and new.reference_number_normalized is not distinct from old.reference_number_normalized
         and new.financial_model_version is not distinct from old.financial_model_version then
        return new;
      end if;
      if new.serial_number is distinct from old.serial_number
         or new.serial_number_normalized is distinct from old.serial_number_normalized
         or new.reference_number is distinct from old.reference_number
         or new.reference_number_normalized is distinct from old.reference_number_normalized
         or new.financial_model_version is distinct from old.financial_model_version then
        raise exception 'Order manual identifiers and financial model are immutable'
          using errcode = 'integrity_constraint_violation';
      end if;
      return new;
    end;
    $$ language plpgsql;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function protect_order_manual_identifiers() returns trigger as $$
    begin
      if new.serial_number is distinct from old.serial_number
         or new.serial_number_normalized is distinct from old.serial_number_normalized
         or new.reference_number is distinct from old.reference_number
         or new.reference_number_normalized is distinct from old.reference_number_normalized
         or new.financial_model_version is distinct from old.financial_model_version then
        raise exception 'Order manual identifiers and financial model are immutable'
          using errcode = 'integrity_constraint_violation';
      end if;
      return new;
    end;
    $$ language plpgsql;
  `.execute(database);
}
