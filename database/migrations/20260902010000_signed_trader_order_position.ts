import { type Kysely, sql } from "kysely";
type MigrationDatabase=Record<string,never>;
/** Retains a Trader debit on an Order while keeping settlement payments non-negative. */
export async function up(database:Kysely<MigrationDatabase>):Promise<void>{await sql`
  alter table orders drop constraint orders_nonnegative_amounts;
  alter table orders add constraint orders_nonnegative_amounts check(cod_amount>=0 and service_fee>=0
    and customer_charges>=0 and customer_credits_refunds>=0 and customer_amount_due>=0 and amount_collected>=0
    and trader_gross_payable>=0 and trader_paid_service_fee>=0 and trader_deductions>=0 and trader_charges>=0
    and driver_cost>=0 and return_driver_fee>=0 and order_expenses_total>=0 and company_other_charges>=0 and vat_amount>=0);
  alter table orders drop constraint orders_trader_paid_amount_range;
  alter table orders add constraint orders_trader_paid_amount_range check(trader_paid_amount>=0
    and ((trader_net_payable>=0 and trader_paid_amount<=trader_net_payable)
      or (trader_net_payable<0 and trader_paid_amount=0)));
  alter table orders drop constraint orders_prospective_financial_model_check;
  alter table orders add constraint orders_prospective_financial_model_check check(financial_model_version is null or(
    financial_model_version='trader_deduction_v1' and serial_number is not null and btrim(serial_number)<>''
    and serial_number_normalized is not null and btrim(serial_number_normalized)<>''
    and ((reference_number is null and reference_number_normalized is null) or(reference_number is not null
      and btrim(reference_number)<>'' and reference_number_normalized is not null and btrim(reference_number_normalized)<>''))
    and service_fee_net_amount>=0 and service_fee_vat_amount>=0 and additional_fees>=0 and additional_fee_vat_amount>=0
    and total_deductions=service_fee_net_amount+service_fee_vat_amount+additional_fees+additional_fee_vat_amount
    and customer_amount_due=cod_amount and trader_gross_payable=cod_amount
    and trader_paid_service_fee=service_fee_net_amount+service_fee_vat_amount
    and trader_deductions=additional_fees+additional_fee_vat_amount and trader_net_payable=cod_amount-total_deductions
    and vat_amount=service_fee_vat_amount+additional_fee_vat_amount
    and payment_condition='customer_pays_cod_trader_pays_fee' and vat_enabled_snapshot is not null
    and vat_rate_snapshot between 0 and 100 and ((vat_enabled_snapshot and vat_price_mode_snapshot in('inclusive','exclusive'))
      or(not vat_enabled_snapshot and vat_price_mode_snapshot is null)) and area_name_fallback_used is not null));
`.execute(database);}
export async function down(database:Kysely<MigrationDatabase>):Promise<void>{await sql`
  do $$ begin if exists(select 1 from orders where trader_net_payable<0) then raise exception 'Cannot restore non-negative Trader payable while signed Order positions exist'; end if; end $$;
`.execute(database);}
