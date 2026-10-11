import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * TEST SUPPORT (disposable databases only) -- Repair Center Phase 3, Prompt 4.
 *
 * Turns a crafted Order into a `trader_deduction_v1` Order with VAT OFF and its
 * stored financial obligation, exactly as Order creation would have written it
 * (and as `orders_prospective_financial_model_check` demands). Since Prompt 4
 * the expected Trader receivable is read from that stored obligation, so a
 * crafted "current-era" Order must carry it; a crafted Order WITHOUT it is a
 * legacy Order whose historical amount is not provable.
 *
 * Triggers are bypassed for this one statement (crafted state, like every
 * other crafted fixture row); the CHECK constraints still apply.
 */
export async function markTraderDeductionV1Order(db: Kysely<DatabaseSchema>, orderId: string): Promise<void> {
  await db.transaction().execute(async (transaction) => {
    await sql`set local session_replication_role = replica`.execute(transaction);
    await sql`
      update orders o set
        financial_model_version = 'trader_deduction_v1',
        serial_number = coalesce(nullif(btrim(o.serial_number), ''), o.order_number),
        serial_number_normalized = coalesce(nullif(btrim(o.serial_number_normalized), ''), lower(o.order_number)),
        area_name_fallback_used = coalesce(o.area_name_fallback_used, false),
        vat_enabled_snapshot = false, vat_rate_snapshot = 0, vat_price_mode_snapshot = null,
        service_fee_net_amount = o.service_fee, service_fee_vat_amount = 0,
        additional_fees = coalesce(o.additional_fees, 0), additional_fee_vat_amount = 0, vat_amount = 0,
        total_deductions = case
          when o.payment_condition = 'customer_pays_cod_trader_pays_fee' or o.cod_amount > 0
            then o.service_fee + coalesce(o.additional_fees, 0) else 0 end,
        customer_amount_due = case
          when o.payment_condition = 'customer_pays_cod_trader_pays_fee' or o.cod_amount > 0
            then o.cod_amount else o.service_fee + coalesce(o.additional_fees, 0) end,
        trader_gross_payable = o.cod_amount,
        trader_paid_service_fee = case
          when o.payment_condition = 'customer_pays_cod_trader_pays_fee' or o.cod_amount > 0
            then o.service_fee else 0 end,
        trader_deductions = case
          when o.payment_condition = 'customer_pays_cod_trader_pays_fee' or o.cod_amount > 0
            then coalesce(o.additional_fees, 0) else 0 end,
        trader_net_payable = greatest(o.cod_amount - case
          when o.payment_condition = 'customer_pays_cod_trader_pays_fee' or o.cod_amount > 0
            then o.service_fee + coalesce(o.additional_fees, 0) else 0 end, 0)
       where o.id = ${orderId}::uuid
    `.execute(transaction);
  });
}
