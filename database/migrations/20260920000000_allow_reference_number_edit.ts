import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Allow Reference Number edits on existing Orders.
 *
 * 20260723140000 installed `protect_order_manual_identifiers` blocking every
 * change to serial_number, reference_number and financial_model_version. That
 * contradicted the application itself: `OperationsService.updateOrder` has a
 * dedicated safe-change path that edits reference_number with a company-wide
 * duplicate check, an order_events row and an audit record — so the office
 * Edit form offered a field the database then rejected, even when merely
 * ADDING a reference to an Order that never had one.
 *
 * The guard is narrowed, not removed:
 *  - serial_number (+ normalized) stays immutable — it participates in the
 *    per-date uniqueness contract and printed waybills.
 *  - financial_model_version stays immutable — it selects which financial
 *    check constraint governs the row.
 *  - reference_number (+ normalized) becomes editable. Integrity is still
 *    enforced elsewhere: `orders_reference_number_normalized_unique` prevents
 *    duplicates, and `orders_prospective_financial_model_check` still refuses
 *    a null/blank reference on 'trader_deduction_v1' Orders, so a reference
 *    can be added or corrected but never stripped from a new-model Order.
 *
 * Trigger and function names are unchanged on purpose: verify-schema.ts
 * asserts both names exist.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function protect_order_manual_identifiers() returns trigger as $$
    begin
      if new.serial_number is distinct from old.serial_number
         or new.serial_number_normalized is distinct from old.serial_number_normalized
         or new.financial_model_version is distinct from old.financial_model_version then
        raise exception 'Order serial number and financial model are immutable'
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
