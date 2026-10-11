-- WRITES DATA -- REVIEW BEFORE RUNNING. Run ONLY after the Driver Collections
-- release (migration 20261011020000 + API + web) is deployed to production.
--
-- Driver Collections step 5 (Aiman approved 11 Oct 2026: "All 31 orders").
-- Moves existing delivered Orders with nothing to collect (customer amount 0.00)
-- from driver_reconciliation_status 'not_applicable' to 'pending', so they
-- appear in New Driver Collection as "Nothing to collect" and their outsourced
-- Driver fees can be offset. Same scope as
-- scripts/diagnostics/zero-collection-orders-preview.sql.
--
-- Every statement is scoped by company_id. Each move is recorded in
-- order_status_history (driver_reconciliation: not_applicable -> pending).
-- Each company block checks the count it expects (from the 11 Oct preview) and
-- raises an error -- rolling back EVERYTHING -- if the count differs, e.g.
-- because an Order changed since the preview. If that happens, re-run the
-- preview and update the expected counts.
--
--   AL Fahd Al Maliky    2f0703c3-...  expected 9   actor: admin
--   Lahthza              4d9095cb-...  expected 20  actor: ahmed
--   XYZ Deliver services dd28829b-...  expected 2   actor: Aiman

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.move_zero_collection_orders(
  p_company_id uuid, p_actor_account_id uuid, p_expected int
) RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  moved int;
BEGIN
  WITH candidates AS (
    SELECT o.id
      FROM orders o
      JOIN drivers d ON d.id = o.assigned_driver_id AND d.company_id = o.company_id
     WHERE o.company_id = p_company_id
       AND o.delivery_status = 'delivered'
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
     FOR UPDATE OF o
  ),
  updated AS (
    UPDATE orders o
       SET driver_reconciliation_status = 'pending',
           updated_at = now(),
           version = o.version + 1
      FROM candidates c
     WHERE o.company_id = p_company_id
       AND o.id = c.id
    RETURNING o.id
  ),
  history AS (
    INSERT INTO order_status_history (
      company_id, order_id, status_dimension, from_status, to_status, reason,
      changed_by_account_id
    )
    SELECT p_company_id, u.id, 'driver_reconciliation', 'not_applicable', 'pending',
           'Driver Collections: Order with nothing to collect moved to Pending Collection (approved 11 Oct 2026)',
           p_actor_account_id
      FROM updated u
    RETURNING order_id
  )
  SELECT count(*)::int INTO moved FROM history;

  IF moved <> p_expected THEN
    RAISE EXCEPTION 'Company %: expected % Orders, found % -- nothing changed, re-run the preview',
      p_company_id, p_expected, moved;
  END IF;
  RETURN moved;
END;
$$;

SELECT 'AL Fahd Al Maliky' AS company, pg_temp.move_zero_collection_orders(
  '2f0703c3-2b3b-45ef-a6ab-de9b3694c0a1', '7410c9d3-f91f-404b-bb8b-00cef9507a28', 9) AS moved;
SELECT 'Lahthza' AS company, pg_temp.move_zero_collection_orders(
  '4d9095cb-3da6-4b8b-9d8e-ff01f8192bdb', '3e5a6d42-db3e-4ead-9b5b-300102747b42', 20) AS moved;
SELECT 'XYZ Deliver services' AS company, pg_temp.move_zero_collection_orders(
  'dd28829b-2b7c-4851-a0be-181b92673e84', '3433a8e1-8740-4031-8eed-e90f00b07635', 2) AS moved;

-- Check before committing: every company should now show 0 rows left.
SELECT o.company_id, count(*)::int AS still_not_applicable
  FROM orders o
 WHERE o.company_id IN ('2f0703c3-2b3b-45ef-a6ab-de9b3694c0a1',
                        '4d9095cb-3da6-4b8b-9d8e-ff01f8192bdb',
                        'dd28829b-2b7c-4851-a0be-181b92673e84')
   AND o.delivery_status = 'delivered'
   AND o.order_type NOT IN ('gcc_international', 'collect_order')
   AND o.assigned_driver_id IS NOT NULL
   AND o.customer_amount_due = 0
   AND o.driver_reconciliation_status = 'not_applicable'
   AND NOT (o.is_free_order AND o.trader_net_payable <= 0)
 GROUP BY o.company_id;

-- If the three "moved" numbers are 9, 20 and 2 and the check returns no rows:
COMMIT;
-- Otherwise run ROLLBACK; instead.
