-- READ ONLY DIAGNOSTIC
-- NO DATA MODIFICATION
-- Driver Collections, Option A (Aiman, 10 Oct 2026):
-- existing delivered Orders with nothing to collect from the customer
-- (COD 0, Trader pays the fee) that are still `not_applicable` and so never
-- reached a Driver Collection. This only COUNTS them, per company and Driver,
-- so Aiman can approve which ones move to `pending`. Nothing is changed here.
--
-- Scope (matches spec section 5, "Backfill"):
--   delivered (not closed), domestic (not gcc_international, not collect_order),
--   assigned Driver, customer_amount_due = 0, driver_reconciliation_status =
--   'not_applicable', not an explicit no-value Free Order, not linked to any
--   active (confirmed, unreversed) Driver Collection.
-- Columns split outsourced Drivers with an unpaid delivery fee (the ones the
-- spec proposes to move) from the rest (employee Drivers / fee already paid),
-- which stay as they are unless Aiman approves otherwise.
--
-- Run per company: replace the company_id in the `params` CTE.
-- XYZ Deliver services (test): dd28829b-2b7c-4851-a0be-181b92673e84
-- Lahthza:                     4d9095cb-3da6-4b8b-9d8e-ff01f8192bdb
-- AL Fahd Al Maliky:           2f0703c3-2b3b-45ef-a6ab-de9b3694c0a1

BEGIN;
SET TRANSACTION READ ONLY;

-- QUERY 1: per Driver summary.
WITH params AS (
  SELECT 'dd28829b-2b7c-4851-a0be-181b92673e84'::uuid AS company_id
),
candidates AS (
  SELECT o.company_id, o.id AS order_id, o.order_number, o.serial_number,
         o.assigned_driver_id, o.delivered_at,
         d.name_en AS driver_name, d.driver_type,
         COALESCE((
           SELECT SUM(a.outstanding_amount)
             FROM outsourced_driver_fee_accruals a
            WHERE a.company_id = o.company_id
              AND a.order_id = o.id
              AND a.earning_type = 'delivery'
              AND a.status IN ('accrued', 'partially_paid')
         ), 0)::numeric(18,2) AS unpaid_fee
    FROM orders o
    JOIN params p ON p.company_id = o.company_id
    JOIN drivers d ON d.id = o.assigned_driver_id AND d.company_id = o.company_id
   WHERE o.delivery_status = 'delivered'
     AND o.order_type NOT IN ('gcc_international', 'collect_order')
     AND o.assigned_driver_id IS NOT NULL
     AND o.customer_amount_due = 0
     AND o.driver_reconciliation_status = 'not_applicable'
     AND NOT (o.is_free_order AND o.trader_net_payable <= 0)
     AND NOT EXISTS (
       SELECT 1
         FROM driver_reconciliation_orders link
         JOIN driver_reconciliations r
           ON r.id = link.reconciliation_id AND r.company_id = link.company_id
        WHERE link.company_id = o.company_id
          AND link.order_id = o.id
          AND r.status = 'confirmed'
          AND NOT EXISTS (
            SELECT 1 FROM driver_reconciliations rv
             WHERE rv.company_id = r.company_id AND rv.reversal_of_id = r.id
          )
     )
)
SELECT driver_name, driver_type,
       COUNT(*)::int AS zero_collection_orders,
       COUNT(*) FILTER (WHERE driver_type = 'outsourced' AND unpaid_fee > 0)::int
         AS proposed_to_move_outsourced_unpaid_fee,
       SUM(unpaid_fee) FILTER (WHERE driver_type = 'outsourced')::numeric(18,2)
         AS unpaid_outsourced_fees,
       COUNT(*) FILTER (WHERE NOT (driver_type = 'outsourced' AND unpaid_fee > 0))::int
         AS stays_not_applicable,
       MIN(delivered_at)::date AS oldest_delivery,
       MAX(delivered_at)::date AS newest_delivery
  FROM candidates
 GROUP BY driver_name, driver_type
 ORDER BY proposed_to_move_outsourced_unpaid_fee DESC, driver_name;

-- QUERY 2: the Order list behind QUERY 1 (same scope, one row per Order).
WITH params AS (
  SELECT 'dd28829b-2b7c-4851-a0be-181b92673e84'::uuid AS company_id
)
SELECT o.order_number, o.serial_number, o.delivered_at::date AS delivered,
       d.name_en AS driver_name, d.driver_type,
       o.payment_condition, o.cod_amount, o.service_fee, o.trader_net_payable,
       COALESCE((
         SELECT SUM(a.outstanding_amount)
           FROM outsourced_driver_fee_accruals a
          WHERE a.company_id = o.company_id
            AND a.order_id = o.id
            AND a.earning_type = 'delivery'
            AND a.status IN ('accrued', 'partially_paid')
       ), 0)::numeric(18,2) AS unpaid_fee
  FROM orders o
  JOIN params p ON p.company_id = o.company_id
  JOIN drivers d ON d.id = o.assigned_driver_id AND d.company_id = o.company_id
 WHERE o.delivery_status = 'delivered'
   AND o.order_type NOT IN ('gcc_international', 'collect_order')
   AND o.customer_amount_due = 0
   AND o.driver_reconciliation_status = 'not_applicable'
   AND NOT (o.is_free_order AND o.trader_net_payable <= 0)
   AND NOT EXISTS (
     SELECT 1
       FROM driver_reconciliation_orders link
       JOIN driver_reconciliations r
         ON r.id = link.reconciliation_id AND r.company_id = link.company_id
      WHERE link.company_id = o.company_id
        AND link.order_id = o.id
        AND r.status = 'confirmed'
        AND NOT EXISTS (
          SELECT 1 FROM driver_reconciliations rv
           WHERE rv.company_id = r.company_id AND rv.reversal_of_id = r.id
        )
   )
 ORDER BY d.name_en, o.delivered_at;

ROLLBACK;
