import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Fixes a regression introduced by 20260726200100_trader_payable_ledger.ts: that migration's
 * `create or replace function is_valid_order_status_value(...)` was written to add the new
 * Trader settlement statuses, but its 'delivery' case list was copied from before
 * 20260726190000_order_hold_optional_reference.ts added 'hold', silently dropping validation
 * support for the Hold status from order_status_history going forward.
 *
 * This migration restores 'hold' to the 'delivery' list and otherwise reproduces the
 * 20260726200100 function body exactly, so every other currently-valid status value
 * (delivery, driver_reconciliation, trader_settlement, return, accounting) is unchanged.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function is_valid_order_status_value(status_dimension_value text, status_value text)
    returns boolean language sql immutable strict parallel safe as $$
      select case status_dimension_value
        when 'delivery' then status_value in (
          'new', 'processing', 'assigned', 'returned', 'in_branch',
          'assigned_to_driver', 'out_for_delivery', 'hold', 'delivered',
          'returned_to_branch', 'returned_to_trader', 'cancelled', 'closed'
        )
        when 'driver_reconciliation' then status_value in ('not_applicable', 'pending', 'reconciled', 'reversed')
        when 'trader_settlement' then status_value in (
          'not_eligible', 'unsettled', 'partially_settled', 'settled',
          'money_sent_to_trader', 'money_received_by_trader', 'reversed'
        )
        when 'return' then status_value in ('not_applicable', 'returned_to_branch', 'returned_to_trader')
        when 'accounting' then status_value in ('unposted', 'posted', 'reversed')
        else false
      end
    $$;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    do $$
    begin
      if exists (select 1 from orders where delivery_status = 'hold') then
        raise exception 'Cannot roll back Hold status validation while Hold Orders exist';
      end if;
      if exists (
        select 1 from order_status_history
        where status_dimension = 'delivery' and (to_status = 'hold' or from_status = 'hold')
      ) then
        raise exception 'Cannot roll back Hold status validation while Hold history rows exist';
      end if;
    end
    $$;

    create or replace function is_valid_order_status_value(status_dimension_value text, status_value text)
    returns boolean language sql immutable strict parallel safe as $$
      select case status_dimension_value
        when 'delivery' then status_value in (
          'new', 'processing', 'assigned', 'returned', 'in_branch',
          'assigned_to_driver', 'out_for_delivery', 'delivered',
          'returned_to_branch', 'returned_to_trader', 'cancelled', 'closed'
        )
        when 'driver_reconciliation' then status_value in ('not_applicable', 'pending', 'reconciled', 'reversed')
        when 'trader_settlement' then status_value in (
          'not_eligible', 'unsettled', 'partially_settled', 'settled',
          'money_sent_to_trader', 'money_received_by_trader', 'reversed'
        )
        when 'return' then status_value in ('not_applicable', 'returned_to_branch', 'returned_to_trader')
        when 'accounting' then status_value in ('unposted', 'posted', 'reversed')
        else false
      end
    $$;
  `.execute(database);
}
