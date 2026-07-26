import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Adds the operational Hold status and makes the prospective Reference Number optional.
 *
 * This migration changes constraints and validation functions only. It deliberately does
 * not update existing Orders, status history, financial snapshots, or reconciliations.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table orders drop constraint orders_delivery_status_check;
    alter table orders add constraint orders_delivery_status_check check (delivery_status in (
      'new', 'in_branch', 'assigned_to_driver', 'out_for_delivery', 'hold', 'delivered',
      'returned_to_branch', 'returned_to_trader', 'cancelled', 'closed'
    ));

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
          'not_eligible', 'unsettled', 'settled', 'money_sent_to_trader',
          'money_received_by_trader', 'reversed'
        )
        when 'return' then status_value in ('not_applicable', 'returned_to_branch', 'returned_to_trader')
        when 'accounting' then status_value in ('unposted', 'posted', 'reversed')
        else false
      end
    $$;

    alter table orders drop constraint orders_prospective_financial_model_check;
    alter table orders add constraint orders_prospective_financial_model_check check (
      financial_model_version is null
      or (
        financial_model_version = 'trader_deduction_v1'
        and serial_number is not null
        and btrim(serial_number) <> ''
        and serial_number_normalized is not null
        and btrim(serial_number_normalized) <> ''
        and (
          (reference_number is null and reference_number_normalized is null)
          or (
            reference_number is not null
            and btrim(reference_number) <> ''
            and reference_number_normalized is not null
            and btrim(reference_number_normalized) <> ''
          )
        )
        and service_fee_net_amount is not null
        and service_fee_net_amount >= 0
        and service_fee_vat_amount is not null
        and service_fee_vat_amount >= 0
        and additional_fees is not null
        and additional_fees >= 0
        and additional_fee_vat_amount is not null
        and additional_fee_vat_amount >= 0
        and total_deductions is not null
        and total_deductions =
          service_fee_net_amount + service_fee_vat_amount
          + additional_fees + additional_fee_vat_amount
        and total_deductions <= cod_amount
        and customer_amount_due = cod_amount
        and trader_gross_payable = cod_amount
        and trader_paid_service_fee = service_fee_net_amount + service_fee_vat_amount
        and trader_deductions = additional_fees + additional_fee_vat_amount
        and trader_net_payable = cod_amount - total_deductions
        and vat_amount = service_fee_vat_amount + additional_fee_vat_amount
        and payment_condition = 'customer_pays_cod_trader_pays_fee'
        and vat_enabled_snapshot is not null
        and vat_rate_snapshot is not null
        and vat_rate_snapshot between 0 and 100
        and (
          (vat_enabled_snapshot and vat_price_mode_snapshot in ('inclusive', 'exclusive'))
          or (not vat_enabled_snapshot and vat_price_mode_snapshot is null)
        )
        and area_name_fallback_used is not null
      )
    );

    create or replace function enforce_initial_order_assignment() returns trigger language plpgsql as $$
    declare
      current_driver_id uuid;
      current_delivery_status text;
    begin
      select assigned_driver_id, delivery_status into current_driver_id, current_delivery_status
      from orders where id = new.order_id and company_id = new.company_id;
      if not found or current_driver_id is distinct from new.driver_id then
        raise exception using errcode = '23514',
          message = 'Active assignment Driver must match the Order current Driver';
      end if;
      if current_delivery_status not in ('assigned_to_driver', 'hold') then
        raise exception using errcode = '23514',
          message = 'Only a newly assigned or held Order can receive an active assignment';
      end if;
      return new;
    end;
    $$;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    do $$
    begin
      if exists (select 1 from orders where delivery_status = 'hold') then
        raise exception 'Cannot roll back Hold support while Hold Orders exist';
      end if;
      if exists (
        select 1 from orders
        where financial_model_version = 'trader_deduction_v1'
          and reference_number is null
      ) then
        raise exception 'Cannot restore mandatory Reference Number while prospective Orders without one exist';
      end if;
    end
    $$;

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

    alter table orders drop constraint orders_prospective_financial_model_check;
    alter table orders add constraint orders_prospective_financial_model_check check (
      financial_model_version is null
      or (
        financial_model_version = 'trader_deduction_v1'
        and serial_number is not null
        and btrim(serial_number) <> ''
        and serial_number_normalized is not null
        and btrim(serial_number_normalized) <> ''
        and reference_number is not null
        and btrim(reference_number) <> ''
        and reference_number_normalized is not null
        and btrim(reference_number_normalized) <> ''
        and service_fee_net_amount is not null
        and service_fee_net_amount >= 0
        and service_fee_vat_amount is not null
        and service_fee_vat_amount >= 0
        and additional_fees is not null
        and additional_fees >= 0
        and additional_fee_vat_amount is not null
        and additional_fee_vat_amount >= 0
        and total_deductions is not null
        and total_deductions =
          service_fee_net_amount + service_fee_vat_amount
          + additional_fees + additional_fee_vat_amount
        and total_deductions <= cod_amount
        and customer_amount_due = cod_amount
        and trader_gross_payable = cod_amount
        and trader_paid_service_fee = service_fee_net_amount + service_fee_vat_amount
        and trader_deductions = additional_fees + additional_fee_vat_amount
        and trader_net_payable = cod_amount - total_deductions
        and vat_amount = service_fee_vat_amount + additional_fee_vat_amount
        and payment_condition = 'customer_pays_cod_trader_pays_fee'
        and vat_enabled_snapshot is not null
        and vat_rate_snapshot is not null
        and vat_rate_snapshot between 0 and 100
        and (
          (vat_enabled_snapshot and vat_price_mode_snapshot in ('inclusive', 'exclusive'))
          or (not vat_enabled_snapshot and vat_price_mode_snapshot is null)
        )
        and area_name_fallback_used is not null
      )
    );

    create or replace function enforce_initial_order_assignment() returns trigger language plpgsql as $$
    declare
      current_driver_id uuid;
      current_delivery_status text;
    begin
      select assigned_driver_id, delivery_status into current_driver_id, current_delivery_status
      from orders where id = new.order_id and company_id = new.company_id;
      if not found or current_driver_id is distinct from new.driver_id then
        raise exception using errcode = '23514',
          message = 'Active assignment Driver must match the Order current Driver';
      end if;
      if current_delivery_status <> 'assigned_to_driver' then
        raise exception using errcode = '23514',
          message = 'Only a newly assigned Order can receive an active assignment';
      end if;
      return new;
    end;
    $$;
  `.execute(database);
}
