import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create or replace function enforce_reconciliation_order_driver() returns trigger language plpgsql as $$
    begin
      if not exists (
        select 1
        from driver_reconciliations reconciliation
        join orders target_order
          on target_order.id = new.order_id and target_order.company_id = new.company_id
        where reconciliation.id = new.reconciliation_id
          and reconciliation.company_id = new.company_id
          and target_order.assigned_driver_id = reconciliation.driver_id
          and target_order.delivery_status = 'delivered'
          and target_order.driver_reconciliation_status = 'pending'
          and target_order.customer_amount_due = new.customer_collection_amount
      ) then
        raise exception using
          errcode = '23514',
          message = 'Reconciliation Order must be eligible, match the Driver, and preserve the collected amount';
      end if;
      return new;
    end;
    $$;
  `.execute(database);
}
