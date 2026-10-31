import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * One-time data fix, approved by Aiman on 31 Oct 2026 (option A: "no fee for
 * returned items, only if delivered").
 *
 * Six "Pay by Trader" delivery fees on Lahthza (CMP-000003) Orders that were
 * Returned to Trader, never delivered. A fee is collected only for a
 * delivered Order, so these could never be settled, yet Trader Account and
 * the statement showed them as owed (96.00 in all):
 *
 *   RCV-000094  ORD-001730  ref 06559   ARMAN ABYA (TRD-000063)        16.00
 *   RCV-000056  ORD-001196  ref 05048   jalal abyay (TRD-000065)       16.00
 *   RCV-000068  ORD-001451  ref 04214   mohmad Sakib abaya (TRD-000066) 16.00
 *   RCV-000055  ORD-001195  ref 05428   mohmad Sakib abaya (TRD-000066) 16.00
 *   RCV-000073  ORD-001516  ref 005261  فيصل عبايا (TRD-000067)         16.00
 *   RCV-000082  ORD-001634  ref 06703   فيصل عبايا (TRD-000067)         16.00
 *
 * Exactly what an Order now does when it is marked Returned to Trader
 * (`order-fee-receivable-cancel.ts`): the fee is cancelled only while nobody
 * has paid any part of it, and the `trader_receivables` trigger posts the
 * reversal in the books. Scoped to that Company, those six numbers, and an
 * Order still Returned to Trader -- a row that changed since is left alone.
 * Re-running is a no-op (a cancelled row no longer matches).
 */
const LAHTHZA = "4d9095cb-3da6-4b8b-9d8e-ff01f8192bdb";
const RECEIVABLES = ["RCV-000094", "RCV-000056", "RCV-000068", "RCV-000055", "RCV-000073", "RCV-000082"];

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    with cancelled as (
      update trader_receivables r
         set status = 'cancelled', updated_at = now()
        from orders o
       where r.company_id = ${LAHTHZA}::uuid
         and o.company_id = r.company_id
         and o.order_number = r.source_reference
         and r.source_type = 'service_charge'
         and r.status = 'outstanding'
         and r.amount_collected = 0
         and o.delivery_status = 'returned_to_trader'
         and o.delivered_at is null
         and r.receivable_number in (${sql.join(RECEIVABLES)})
      returning r.id, r.receivable_number, r.original_amount_due, r.trader_id, o.order_number
    )
    insert into audit_events (
      company_id, actor_account_id, action, subject_type, subject_id, reason,
      after_data, correlation_id, source_application
    )
    select ${LAHTHZA}::uuid, null, 'trader_receivable.cancel_from_order', 'trader_receivable',
           c.id::text, 'Order returned to Trader: no fee unless delivered (approved by Aiman, 31 Oct 2026)',
           jsonb_build_object(
             'amount', c.original_amount_due::text,
             'orderNumber', c.order_number,
             'reason', 'Order returned to Trader',
             'receivableNumber', c.receivable_number,
             'traderId', c.trader_id
           ),
           'migration-20261031100000-returned-order-fees', 'system'
      from cancelled c
  `.execute(database);
}

/** No down: the reversal is posted in the books. Correct forward if ever needed. */
export async function down(): Promise<void> {}
