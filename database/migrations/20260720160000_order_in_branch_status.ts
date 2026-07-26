import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

// Adds the optional "Item in Branch" lifecycle status between New and Assign Driver.
// An order can move New -> in_branch (item physically received at the branch) and then
// be assigned to a driver; assignment is also still allowed directly from New.
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table orders drop constraint orders_delivery_status_check;
    alter table orders add constraint orders_delivery_status_check check (delivery_status in (
      'new', 'in_branch', 'assigned_to_driver', 'out_for_delivery', 'delivered',
      'returned_to_branch', 'returned_to_trader', 'cancelled', 'closed'
    ));

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
          'not_eligible', 'unsettled', 'settled', 'money_sent_to_trader',
          'money_received_by_trader', 'reversed'
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
    update orders set delivery_status = 'new' where delivery_status = 'in_branch';

    alter table orders drop constraint orders_delivery_status_check;
    alter table orders add constraint orders_delivery_status_check check (delivery_status in (
      'new', 'assigned_to_driver', 'out_for_delivery', 'delivered',
      'returned_to_branch', 'returned_to_trader', 'cancelled', 'closed'
    ));

    create or replace function is_valid_order_status_value(status_dimension_value text, status_value text)
    returns boolean language sql immutable strict parallel safe as $$
      select case status_dimension_value
        when 'delivery' then status_value in (
          'new', 'processing', 'assigned', 'returned',
          'assigned_to_driver', 'out_for_delivery', 'delivered',
          'returned_to_branch', 'returned_to_trader', 'cancelled', 'closed'
        )
        when 'driver_reconciliation' then status_value in ('not_applicable', 'pending', 'reconciled', 'reversed')
        when 'trader_settlement' then status_value in (
          'not_eligible', 'unsettled', 'settled', 'money_sent_to_trader',
          'money_received_by_trader', 'reversed'
        )
        when 'return' then status_value in ('not_applicable', 'returned_to_branch', 'returned_to_trader')
        when 'accounting' then status_value in ('unposted', 'posted', 'reversed')
        else false
      end
    $$;
  `.execute(database);
}
