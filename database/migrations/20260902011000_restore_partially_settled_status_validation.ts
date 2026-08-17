import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Forward repair for environments that ran 20260902000000 before its status
 * validator was corrected. Collect Order adds one delivery value; it must not
 * remove the pre-existing partially_settled Trader settlement value.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function is_valid_order_status_value(status_dimension_value text,status_value text)
      returns boolean language sql immutable strict parallel safe as $$
      select case status_dimension_value
        when 'delivery' then status_value in('new','processing','assigned','returned','in_branch',
          'assigned_to_driver','out_for_delivery','hold','delivered','returned_to_branch',
          'returned_to_trader','cancelled','closed','collect_order')
        when 'driver_reconciliation' then status_value in('not_applicable','pending','reconciled','reversed')
        when 'trader_settlement' then status_value in('not_eligible','unsettled','partially_settled','settled',
          'money_sent_to_trader','money_received_by_trader','reversed')
        when 'return' then status_value in('not_applicable','returned_to_branch','returned_to_trader')
        when 'accounting' then status_value in('unposted','posted','reversed') else false end
    $$
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`select 1`.execute(database);
}
