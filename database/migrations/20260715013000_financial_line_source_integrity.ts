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
          and target_order.amount_collected = new.customer_collection_amount
      ) then
        raise exception using
          errcode = '23514',
          message = 'Reconciliation Order must be eligible, match the Driver, and preserve the collected amount';
      end if;
      return new;
    end;
    $$;

    create or replace function enforce_settlement_order_trader() returns trigger language plpgsql as $$
    begin
      if not exists (
        select 1
        from trader_settlements settlement
        join orders target_order
          on target_order.id = new.order_id and target_order.company_id = new.company_id
        where settlement.id = new.settlement_id
          and settlement.company_id = new.company_id
          and target_order.trader_id = settlement.trader_id
          and target_order.delivery_status = 'delivered'
          and target_order.driver_reconciliation_status in ('reconciled', 'not_applicable')
          and target_order.trader_settlement_status = 'unsettled'
          and target_order.trader_gross_payable = new.gross_payable
          and target_order.trader_paid_service_fee
                + target_order.trader_deductions
                + target_order.trader_charges = new.deductions_and_charges
          and target_order.trader_adjustments = new.adjustments
          and target_order.trader_net_payable = new.net_payable
      ) then
        raise exception using
          errcode = '23514',
          message = 'Settlement Order must be eligible, match the Trader, and preserve payable amounts';
      end if;
      return new;
    end;
    $$;
  `.execute(database);
}
