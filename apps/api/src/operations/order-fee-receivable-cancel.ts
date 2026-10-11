import { type Kysely, sql } from "kysely";

import type { DatabaseSchema } from "../infrastructure/database/database.types.js";

/**
 * Cancelling an Order cancels its Order fee (Aiman, 11 Oct 2026).
 *
 * When a Trader pays the delivery fee, creating the Order raises a
 * `service_charge` Trader Receivable. A fee can only be collected once the
 * Order is delivered (decision 9 Oct 2026), so a cancelled Order's fee could
 * never be collected and stayed open for ever (Dana: 20 cancelled Orders,
 * AED 378.00 in "Traders owe fees" with nothing to collect).
 *
 * Only a fee nobody has paid any part of is cancelled: `outstanding` with
 * nothing collected. A fee the Trader has already paid, fully or partly, is
 * money received and is left exactly as it is. Cancelling posts the full
 * reversal in the books through the `trader_receivables` trigger, the same
 * way an edited fee is replaced (`operations.service.ts`).
 */
export async function cancelUncollectedOrderFeeReceivables(
  database: Kysely<DatabaseSchema>,
  input: {
    readonly actorId: string;
    readonly companyId: string;
    readonly correlationId: string;
    readonly orderId: string;
  },
): Promise<readonly { readonly amount: string; readonly receivableId: string }[]> {
  const cancelled = await sql<{
    amount: string;
    orderNumber: string;
    receivableId: string;
    receivableNumber: string;
    traderId: string;
  }>`
    update trader_receivables r
       set status = 'cancelled', updated_at = now()
      from orders o
     where o.id = ${input.orderId}::uuid
       and o.company_id = ${input.companyId}::uuid
       and r.company_id = o.company_id
       and r.source_type = 'service_charge'
       and r.source_reference = o.order_number
       and r.status = 'outstanding'
       and r.amount_collected = 0
    returning r.id::text as "receivableId", r.receivable_number as "receivableNumber",
              r.original_amount_due::text as amount, r.trader_id::text as "traderId",
              o.order_number as "orderNumber"
  `.execute(database);
  for (const row of cancelled.rows) {
    await sql`
      insert into audit_events (
        company_id, actor_account_id, action, subject_type, subject_id,
        after_data, correlation_id
      ) values (
        ${input.companyId}::uuid, ${input.actorId}::uuid, 'trader_receivable.cancel_from_order',
        'trader_receivable', ${row.receivableId},
        ${JSON.stringify({
          amount: row.amount,
          orderNumber: row.orderNumber,
          reason: "Order cancelled",
          receivableNumber: row.receivableNumber,
          traderId: row.traderId,
        })}::jsonb,
        ${input.correlationId}
      )
    `.execute(database);
  }
  return cancelled.rows.map((row) => ({ amount: row.amount, receivableId: row.receivableId }));
}
