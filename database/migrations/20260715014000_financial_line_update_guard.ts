import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger driver_reconciliation_orders_driver_guard on driver_reconciliation_orders;
    create trigger driver_reconciliation_orders_driver_guard
      before insert or update of
        reconciliation_id, order_id, company_id, customer_collection_amount,
        driver_payable_deduction
      on driver_reconciliation_orders
      for each row execute function enforce_reconciliation_order_driver();

    drop trigger trader_settlement_orders_trader_guard on trader_settlement_orders;
    create trigger trader_settlement_orders_trader_guard
      before insert or update of
        settlement_id, order_id, company_id, gross_payable, deductions_and_charges,
        adjustments, net_payable
      on trader_settlement_orders
      for each row execute function enforce_settlement_order_trader();
  `.execute(database);
}
