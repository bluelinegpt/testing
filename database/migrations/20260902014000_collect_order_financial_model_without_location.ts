import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/** Keep the prospective financial model valid when a Collect Order has no location. */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await replaceConstraint(database, true);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await replaceConstraint(database, false);
}

async function replaceConstraint(
  database: Kysely<MigrationDatabase>,
  allowLocationFreeCollectOrders: boolean,
): Promise<void> {
  const areaRule = allowLocationFreeCollectOrders
    ? sql`(area_name_fallback_used is not null or order_type = 'collect_order')`
    : sql`area_name_fallback_used is not null`;

  await sql`
    alter table orders drop constraint orders_prospective_financial_model_check;
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
        and total_deductions = service_fee_net_amount + service_fee_vat_amount
          + additional_fees + additional_fee_vat_amount
        and customer_amount_due = cod_amount and trader_gross_payable = cod_amount
        and trader_paid_service_fee = service_fee_net_amount + service_fee_vat_amount
        and trader_deductions = additional_fees + additional_fee_vat_amount
        and trader_net_payable = cod_amount - total_deductions
        and vat_amount = service_fee_vat_amount + additional_fee_vat_amount
        and payment_condition = 'customer_pays_cod_trader_pays_fee'
        and vat_enabled_snapshot is not null and vat_rate_snapshot between 0 and 100
        and (
          (vat_enabled_snapshot and vat_price_mode_snapshot in ('inclusive', 'exclusive'))
          or (not vat_enabled_snapshot and vat_price_mode_snapshot is null)
        )
        and ${areaRule}
      )
    );
  `.execute(database);
}
