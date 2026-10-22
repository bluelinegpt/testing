import { type RawBuilder, sql } from "kysely";

/**
 * COD shortfall: the Trader pays what a "Pay by Customer" COD does not cover.
 *
 * Per Company switch (`companies.trader_pays_cod_shortfall`, Aiman, 22 Oct
 * 2026). On a "Pay by Customer" Order whose COD is above 0 but below its fees
 * the customer pays only the COD, so the rest of the fee was never collected
 * from anyone -- ORD-000023 (CMP-000001): COD 1.00, fee 20.00, the Company
 * received 1.00 and the 19.00 was lost. With the switch on, the Trader owes the
 * shortfall (fees - COD) as a service-charge Trader Receivable, exactly like a
 * "Pay by Trader" fee, and it is deducted in the Trader Settlement.
 *
 * COD 0 is unchanged: the customer pays the full fee. Off for every Company
 * except CMP-000001 until Aiman approves it for the others.
 */

/** Is the switch on for this Company? False when the column does not exist yet. */
export async function traderPaysCodShortfall(
  executor: Parameters<RawBuilder<unknown>["execute"]>[0],
  companyId: string,
): Promise<boolean> {
  const row = (
    await sql<{ enabled: boolean | null }>`
      select (to_jsonb(c) ->> 'trader_pays_cod_shortfall')::boolean as enabled
        from companies c where c.id = ${companyId}::uuid
    `.execute(executor)
  ).rows[0];
  return row?.enabled === true;
}

/** The switch, in SQL, for the Company of the Order aliased `alias`. */
export function codShortfallEnabledSql(alias: string): RawBuilder<boolean> {
  return sql<boolean>`coalesce((
    select (to_jsonb(shortfall_company) ->> 'trader_pays_cod_shortfall')::boolean
      from companies shortfall_company
     where shortfall_company.id = ${sql.ref(`${alias}.company_id`)}), false)`;
}

/**
 * The Trader receivable aliased `alias` can be collected or deducted now.
 *
 * A service charge that belongs to an Order waits until that Order is
 * delivered (and its fee is the Trader's). A service charge added by hand
 * (Add Charge to Trader) belongs to no Order -- no source reference, or one
 * that is not an Order Number -- and is collectable at once. Before this, the
 * delivered-Order test hid every manual Service Charge from settlements
 * (RCV-000007, CMP-000001, 22 Oct 2026). Any other source type is always
 * collectable.
 */
export function receivableCollectableNowSql(alias: string): RawBuilder<boolean> {
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  return sql<boolean>`(${column("source_type")} <> 'service_charge'
    or not exists (
      select 1 from orders fee_order
       where fee_order.company_id = ${column("company_id")}
         and fee_order.order_number = ${column("source_reference")})
    or exists (
      select 1 from orders delivered_order
       where delivered_order.company_id = ${column("company_id")}
         and delivered_order.order_number = ${column("source_reference")}
         and delivered_order.delivered_at is not null
         and ${traderMayOweFeeSql("delivered_order")}))`;
}

/**
 * The Order aliased `alias` is one whose fee the Trader may owe: "Pay by
 * Trader", or "Pay by Customer" with a COD above 0 under the switch (whether a
 * shortfall remains is the amount's business: greatest(fees - COD, 0)).
 */
export function traderMayOweFeeSql(alias: string): RawBuilder<boolean> {
  const column = (name: string) => sql.ref(`${alias}.${name}`);
  // A shortfall charge already made stays owed after the Company turns the
  // switch off again (rollback from Platform Administration): it is still
  // shown, collectable and healthy; only new Orders stop being charged.
  return sql<boolean>`(${column("payment_condition")} = 'customer_pays_cod_trader_pays_fee'
    or (${column("payment_condition")} = 'customer_pays_cod_and_fee'
        and ${column("cod_amount")} > 0
        and (${codShortfallEnabledSql(alias)}
          or exists (
            select 1 from trader_receivables kept_shortfall
             where kept_shortfall.company_id = ${column("company_id")}
               and kept_shortfall.source_type = 'service_charge'
               and kept_shortfall.source_reference = ${column("order_number")}
               and kept_shortfall.status not in ('cancelled', 'reversed')))))`;
}
