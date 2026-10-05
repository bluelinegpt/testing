import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Restore the audited Hold Reactivation exception to the Order identifier guard.
 *
 * 20260902012000 taught `protect_order_manual_identifiers` one exception: Hold
 * Reactivation (`OrdersWorkflowService.reactivateHoldOrders`) gives a Hold
 * Order a new Serial Number and date, inside a transaction that sets
 * `blueline.hold_reactivation = on` and writes `order_serial_history` for the
 * change.
 *
 * 20260920000000 then rewrote the same function to make reference_number
 * editable, and in doing so dropped that exception. Every Hold Reactivation
 * since has been refused with "Order serial number and financial model are
 * immutable" (seen on Render, Lahthza, 5 Oct 2026). The refusal rolled each
 * reactivation back completely; no Order data was changed.
 *
 * This keeps 20260920's rules (serial number and financial model immutable,
 * reference number editable) and restores the exception exactly as it was
 * scoped before:
 *  - only inside a transaction that set `blueline.hold_reactivation` (local to
 *    that transaction, `set_config(..., true)`);
 *  - only for an Order leaving `hold` for in_branch / assigned_to_driver /
 *    out_for_delivery;
 *  - never for the financial model, which stays immutable even then.
 *
 * Function and trigger names are unchanged: verify-schema.ts asserts them.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function protect_order_manual_identifiers() returns trigger as $$
    declare
      hold_reactivation boolean := coalesce(current_setting('blueline.hold_reactivation', true), '') = 'on';
    begin
      if hold_reactivation
         and old.delivery_status = 'hold'
         and new.delivery_status in ('in_branch', 'assigned_to_driver', 'out_for_delivery')
         and new.financial_model_version is not distinct from old.financial_model_version then
        return new;
      end if;
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

/** Back to the 20260920000000 body (no Hold Reactivation exception). */
export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
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
