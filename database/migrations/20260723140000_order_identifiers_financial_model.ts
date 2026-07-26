import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Prospective Order identifiers and Trader-deduction financial model.
 *
 * Existing Orders intentionally remain null in every new column. The conditional
 * constraint applies only to Orders created with the new model marker, preserving
 * all historical financial values and reconciliation/settlement links verbatim.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table orders
      add column serial_number text,
      add column serial_number_normalized text,
      add column reference_number text,
      add column reference_number_normalized text,
      add column financial_model_version text,
      add column service_fee_net_amount numeric(18,2),
      add column service_fee_vat_amount numeric(18,2),
      add column additional_fees numeric(18,2),
      add column additional_fee_vat_amount numeric(18,2),
      add column total_deductions numeric(18,2),
      add column vat_enabled_snapshot boolean,
      add column vat_rate_snapshot numeric(9,4),
      add column vat_price_mode_snapshot text,
      add column customer_area_name_ar_snapshot text,
      add column area_name_fallback_used boolean;

    create unique index orders_serial_number_normalized_unique
      on orders (company_id, serial_number_normalized)
      where serial_number_normalized is not null;

    create unique index orders_reference_number_normalized_unique
      on orders (company_id, reference_number_normalized)
      where reference_number_normalized is not null;

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
  `.execute(database);

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

    create trigger orders_manual_identifiers_immutable
      before update of serial_number, serial_number_normalized,
        reference_number, reference_number_normalized, financial_model_version
      on orders
      for each row execute function protect_order_manual_identifiers();
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop trigger if exists orders_manual_identifiers_immutable on orders;
    drop function if exists protect_order_manual_identifiers();
    alter table orders drop constraint if exists orders_prospective_financial_model_check;
    drop index if exists orders_reference_number_normalized_unique;
    drop index if exists orders_serial_number_normalized_unique;
    alter table orders
      drop column if exists area_name_fallback_used,
      drop column if exists customer_area_name_ar_snapshot,
      drop column if exists vat_price_mode_snapshot,
      drop column if exists vat_rate_snapshot,
      drop column if exists vat_enabled_snapshot,
      drop column if exists total_deductions,
      drop column if exists additional_fee_vat_amount,
      drop column if exists additional_fees,
      drop column if exists service_fee_vat_amount,
      drop column if exists service_fee_net_amount,
      drop column if exists financial_model_version,
      drop column if exists reference_number_normalized,
      drop column if exists reference_number,
      drop column if exists serial_number_normalized,
      drop column if exists serial_number;
  `.execute(database);
}
