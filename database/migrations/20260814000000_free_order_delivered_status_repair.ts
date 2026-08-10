import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Repairs explicit Free Orders that were delivered before the post-delivery
 * status rule was corrected.
 *
 * Deterministic scope only:
 * - the Order is explicitly marked `is_free_order`;
 * - all Order-level financial values are zero;
 * - delivery is already complete;
 * - the stored Driver cash / Trader settlement statuses still imply money work.
 *
 * No collection, settlement, accounting event or journal is created. This only
 * moves the Order's own stored workflow statuses back to the existing
 * not-applicable/not-eligible values that zero-value Free Orders should have
 * had all along. Driver compensation subledgers are intentionally untouched.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  const repaired = await sql<{
    companyId: string;
    driverReconciliationStatus: string;
    orderId: string;
    orderNumber: string;
    traderSettlementStatus: string;
  }>`
    with candidates as (
      select id, company_id, order_number,
             driver_reconciliation_status, trader_settlement_status
        from orders
       where is_free_order = true
         and delivery_status = 'delivered'
         and coalesce(cod_amount, 0) = 0
         and coalesce(service_fee, 0) = 0
         and coalesce(additional_fees, 0) = 0
         and coalesce(total_deductions, 0) = 0
         and coalesce(customer_amount_due, 0) = 0
         and coalesce(trader_net_payable, 0) = 0
         and (
           driver_reconciliation_status <> 'not_applicable'
           or trader_settlement_status <> 'not_eligible'
         )
    ),
    repaired as (
      update orders target
         set driver_reconciliation_status = 'not_applicable',
             trader_settlement_status = 'not_eligible',
             amount_collected = 0,
             updated_at = now(),
             version = version + 1
        from candidates
       where target.id = candidates.id
      returning target.company_id as "companyId",
                target.id as "orderId",
                target.order_number as "orderNumber",
                candidates.driver_reconciliation_status as "driverReconciliationStatus",
                candidates.trader_settlement_status as "traderSettlementStatus"
    )
    select * from repaired
  `.execute(database);

  for (const row of repaired.rows) {
    await sql`
      insert into audit_events (
        company_id, action, subject_type, subject_id, before_data, after_data,
        reason, correlation_id
      ) values (
        ${row.companyId}::uuid,
        'order.free_order_status_repair',
        'order',
        ${row.orderId}::uuid,
        jsonb_build_object(
          'orderNumber', ${row.orderNumber}::text,
          'driverReconciliationStatus', ${row.driverReconciliationStatus}::text,
          'traderSettlementStatus', ${row.traderSettlementStatus}::text
        ),
        jsonb_build_object(
          'driverReconciliationStatus', 'not_applicable',
          'traderSettlementStatus', 'not_eligible',
          'amountCollected', '0.00'
        ),
        'Repair delivered zero-value Free Order financial workflow statuses',
        ${`migration:20260814000000:${row.orderId}`}::text
      )
    `.execute(database);
  }
}
