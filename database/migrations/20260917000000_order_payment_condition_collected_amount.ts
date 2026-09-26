import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * The Create Order COD amount represents the total amount the Driver/Company
 * should collect from the Customer for the Order. Delivery/service fees are
 * deducted from that collected amount before calculating the Trader payable.
 *
 * `customer_pays_cod_and_fee` means the Customer-paid amount entered on the
 * Order already includes COD and/or fee. `customer_pays_cod_trader_pays_fee`
 * uses the same Order math, but any fee shortfall is collected later from the
 * Trader as a Trader Receivable by application logic.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table orders drop constraint if exists orders_prospective_financial_model_check;
    alter table orders add constraint orders_prospective_financial_model_check check (
      financial_model_version is null or (
        financial_model_version = 'trader_deduction_v1'
        and serial_number is not null and btrim(serial_number) <> ''
        and serial_number_normalized is not null and btrim(serial_number_normalized) <> ''
        and (
          (reference_number is null and reference_number_normalized is null)
          or (
            reference_number is not null and btrim(reference_number) <> ''
            and reference_number_normalized is not null and btrim(reference_number_normalized) <> ''
          )
        )
        and service_fee_net_amount >= 0 and service_fee_vat_amount >= 0
        and additional_fees >= 0 and additional_fee_vat_amount >= 0
        and vat_amount = service_fee_vat_amount + additional_fee_vat_amount
        and (
          (
            payment_condition = 'customer_pays_cod_trader_pays_fee'
            and total_deductions = service_fee_net_amount + service_fee_vat_amount + additional_fees + additional_fee_vat_amount
            and customer_amount_due = cod_amount
            and trader_gross_payable = cod_amount
            and trader_paid_service_fee = service_fee_net_amount + service_fee_vat_amount
            and trader_deductions = additional_fees + additional_fee_vat_amount
            and trader_net_payable = greatest(cod_amount - total_deductions, 0)
          )
          or (
            payment_condition = 'customer_pays_cod_and_fee'
            and customer_amount_due = case
              when cod_amount > 0 then cod_amount
              else service_fee_net_amount + service_fee_vat_amount + additional_fees + additional_fee_vat_amount
            end
            and trader_gross_payable = cod_amount
            and trader_paid_service_fee = case
              when cod_amount > 0 then service_fee_net_amount + service_fee_vat_amount
              else 0
            end
            and trader_deductions = case
              when cod_amount > 0 then additional_fees + additional_fee_vat_amount
              else 0
            end
            and total_deductions = case
              when cod_amount > 0 then service_fee_net_amount + service_fee_vat_amount + additional_fees + additional_fee_vat_amount
              else 0
            end
            and trader_net_payable = greatest(cod_amount - total_deductions, 0)
          )
        )
        and vat_enabled_snapshot is not null
        and vat_rate_snapshot between 0 and 100
        and (
          (vat_enabled_snapshot and vat_price_mode_snapshot in ('inclusive', 'exclusive'))
          or (not vat_enabled_snapshot and vat_price_mode_snapshot is null)
        )
        and (area_name_fallback_used is not null or customer_provenance_status = 'not_applicable')
      )
    ) not valid;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table orders drop constraint if exists orders_prospective_financial_model_check;
  `.execute(database);
}
