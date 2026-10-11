-- Cancel the unpaid Order fees on CANCELLED Orders (Aiman, 11 Oct 2026, Option B).
-- Company: Dana Delivery Services (Test)  company_id dd28829b-2b7c-4851-a0be-181b92673e84
-- Expected: 20 fee charges, AED 378.00, none partly paid.
-- Only fees with nothing collected are touched. The trader_receivables trigger
-- posts the reversal in the books, exactly as when an Order's fee is edited.
-- Run in the Neon SQL editor (branch main, database neondb).

-- 1) PREVIEW (read-only). Must show 20 rows, total 378.00, collected 0.00 on every row.
select r.receivable_number, o.order_number, r.status, r.original_amount_due, r.amount_collected, r.outstanding_amount
  from trader_receivables r
  join orders o on o.company_id = r.company_id and o.order_number = r.source_reference
 where r.company_id = 'dd28829b-2b7c-4851-a0be-181b92673e84'::uuid
   and r.source_type = 'service_charge'
   and r.status = 'outstanding'
   and r.amount_collected = 0
   and o.delivery_status = 'cancelled'
 order by o.order_number;

-- 2) APPLY. Run the whole block together. Check the row count it reports (20)
--    before COMMIT; if it is anything else, run ROLLBACK instead.
begin;

with cancelled as (
  update trader_receivables r
     set status = 'cancelled', updated_at = now()
    from orders o
   where r.company_id = 'dd28829b-2b7c-4851-a0be-181b92673e84'::uuid
     and o.company_id = r.company_id
     and o.order_number = r.source_reference
     and r.source_type = 'service_charge'
     and r.status = 'outstanding'
     and r.amount_collected = 0
     and o.delivery_status = 'cancelled'
  returning r.id, r.company_id, r.receivable_number, r.original_amount_due, r.trader_id, o.order_number
)
insert into audit_events (company_id, actor_account_id, action, subject_type, subject_id, after_data, correlation_id)
select c.company_id, null, 'trader_receivable.cancel_from_order', 'trader_receivable', c.id::text,
       jsonb_build_object('amount', c.original_amount_due::text, 'orderNumber', c.order_number,
                          'reason', 'Order cancelled (clean-up 11 Oct 2026)',
                          'receivableNumber', c.receivable_number, 'traderId', c.trader_id::text),
       'cleanup-cancelled-order-fees-2026-10-11'
  from cancelled c;

-- Must return 0 before you commit.
select count(*) as still_open
  from trader_receivables r
  join orders o on o.company_id = r.company_id and o.order_number = r.source_reference
 where r.company_id = 'dd28829b-2b7c-4851-a0be-181b92673e84'::uuid
   and r.source_type = 'service_charge'
   and r.status in ('outstanding', 'partially_collected')
   and o.delivery_status = 'cancelled';

commit;
