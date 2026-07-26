import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

// Phase A schema (trader side): per-Order trader-payable ledger so a Trader can be paid in
// partial payments over time with order-level allocation.
//   - orders.trader_paid_amount        running total paid to the Trader for this Order
//   - orders.trader_outstanding_balance generated = trader_net_payable - trader_paid_amount
//   - trader_settlement_status gains 'partially_settled' and 'settled'
//   - trader_settlement_orders.allocated_amount: how much of that settlement was applied here
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table orders add column trader_paid_amount numeric(18, 2) not null default 0;
    -- Overpayment and negative outstanding are impossible at the database: paid can never
    -- exceed the amount due to the Trader, and (with row locking in the payment service)
    -- concurrent partial payments can never over-allocate.
    alter table orders add constraint orders_trader_paid_amount_range
      check (trader_paid_amount >= 0 and trader_paid_amount <= trader_net_payable);
    alter table orders add column trader_outstanding_balance numeric(18, 2)
      generated always as (trader_net_payable - trader_paid_amount) stored;

    alter table trader_settlement_orders
      add column allocated_amount numeric(18, 2) not null default 0
      constraint trader_settlement_orders_allocated_amount_nonneg check (allocated_amount >= 0);

    -- Allow an Order that is already partially settled to be added to a further settlement,
    -- so a Trader can be paid in several partial payments over time. (Was 'unsettled' only.)
    create or replace function enforce_settlement_order_trader() returns trigger
    language plpgsql as $$
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
          and target_order.trader_settlement_status in ('unsettled', 'partially_settled')
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

    alter table orders drop constraint orders_settlement_status_check;
    alter table orders add constraint orders_settlement_status_check check (
      trader_settlement_status in (
        'not_eligible', 'unsettled', 'partially_settled', 'settled',
        'money_sent_to_trader', 'money_received_by_trader', 'reversed'
      )
    );

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

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
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

    alter table orders drop constraint orders_settlement_status_check;
    alter table orders add constraint orders_settlement_status_check check (
      trader_settlement_status in (
        'not_eligible', 'unsettled', 'money_sent_to_trader', 'money_received_by_trader', 'reversed'
      )
    );

    create or replace function enforce_settlement_order_trader() returns trigger
    language plpgsql as $$
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

    alter table trader_settlement_orders drop column allocated_amount;
    alter table orders drop column trader_outstanding_balance;
    alter table orders drop constraint orders_trader_paid_amount_range;
    alter table orders drop column trader_paid_amount;
  `.execute(database);
}
