import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * One-time data fix, approved by Aiman on 15 Nov 2026.
 *
 * On 15 Nov 2026 (01:49-02:54 UTC) five settlement posts on Lahthza
 * (CMP-000003) failed with "Query read timeout". The API's client-side
 * query_timeout left each transaction open on its pooled connection, and the
 * next request's COMMIT saved the abandoned half settlement -- a header still
 * `draft`, its lines, and no payment (fixed for the future by commit 81151215,
 * which moves the limit to PostgreSQL's statement_timeout).
 *
 *   SET-000278  الاناقة     order 5706 (90.00) - fee RCV-000132 (20.00) = 70.00
 *   SET-000279  ARMAN ABYA  14 orders                               2,498.00
 *   SET-000280  ARMAN ABYA  14 orders                               2,498.00
 *   SET-000281  الاناقة     order 5706                                  90.00
 *   SET-000282  ARMAN ABYA  14 orders                               2,498.00
 *
 * No payment, cash movement, accounting event or Order change was ever made
 * for them; all 15 Orders are still unsettled. What they left behind:
 *   - 5 `draft` settlement headers, 44 order lines and 1 fee offset;
 *   - RCV-000132 marked collected (20.00) by SET-000278's offset, though no
 *     money was received;
 *   - 5 idempotency records (`draft-<draft id>`) with no result, which make a
 *     re-post of the same draft fail with "already being processed".
 *
 * This removes exactly those rows and puts RCV-000132 back to outstanding,
 * with an audit line for each. It runs only if everything is still exactly
 * as found on 15 Nov; otherwise it changes nothing. Any error inside the
 * block rolls the whole cleanup back and is logged as a WARNING, so it can
 * never stop the API from starting. A confirmed settlement can never be
 * deleted (trigger `trader_settlements_immutable`).
 *
 * Not touched: Orders, payments, cash, accounting, ARMAN's open draft
 * (7bddf03a), other settlements or drafts, other Companies. SET-000278..282
 * remain unused numbers.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    do $cleanup$
    declare
      v_company constant uuid := '4d9095cb-3da6-4b8b-9d8e-ff01f8192bdb';
      v_numbers constant text[] := array['SET-000278','SET-000279','SET-000280','SET-000281','SET-000282'];
      v_keys constant text[] := array[
        'draft-46e5a284-af71-4e69-a869-36d314c7689a',
        'draft-c8572f95-7ea3-4f60-9bd5-efea292a240d',
        'draft-fd1407f7-86b8-4568-90df-9bf0c245a25a',
        'draft-3aa36bc0-c17c-4217-8d8e-061b9dd7c668',
        'draft-7bddf03a-4a64-449b-82ea-388aa52871e8'];
      v_correlation constant text := 'migration-20261115100000-lahthza-half-settlements';
      v_reason constant text :=
        'Half-saved by the 15 Nov 2026 query-timeout incident: never paid or confirmed (approved by Aiman, 15 Nov 2026)';
      v_ids uuid[];
      v_line_count integer;
      v_offset_count integer;
      v_key_count integer;
      v_rcv record;
      v_set record;
      v_done integer;
    begin
      -- Already done (or never applicable here): nothing to clean.
      if not exists (select 1 from trader_settlements
                      where company_id = v_company and settlement_number = any(v_numbers)) then
        raise notice 'Lahthza half-settlement cleanup: nothing to do';
        return;
      end if;

      -- 1. Every one of the five must still be an unpaid, unconfirmed draft.
      select array_agg(s.id) into v_ids
        from trader_settlements s
       where s.company_id = v_company
         and s.settlement_number = any(v_numbers)
         and s.status = 'draft'
         and not exists (select 1 from trader_settlement_payments p
                          where p.company_id = s.company_id and p.settlement_id = s.id)
         and not exists (select 1 from trader_settlement_credit_applications c
                          where c.company_id = s.company_id and c.settlement_id = s.id)
         and not exists (select 1 from trader_settlement_zero_due_orders z
                          where z.company_id = s.company_id and z.settlement_id = s.id);
      if coalesce(array_length(v_ids, 1), 0) <> 5 then
        raise exception 'expected 5 unpaid draft settlements, found %', coalesce(array_length(v_ids, 1), 0);
      end if;

      select count(*) into v_line_count from trader_settlement_orders
       where company_id = v_company and settlement_id = any(v_ids);
      select count(*) into v_offset_count from trader_settlement_receivable_offsets
       where company_id = v_company and settlement_id = any(v_ids);
      if v_line_count <> 44 or v_offset_count <> 1 then
        raise exception 'expected 44 order lines and 1 fee offset, found % and %', v_line_count, v_offset_count;
      end if;

      -- 2. The one fee offset: RCV-000132 on SET-000278, 20.00, and that offset
      --    must be the receivable's only collection.
      select r.id, r.receivable_number, r.status, r.amount_collected, r.original_amount_due,
             x.amount_allocated, s.settlement_number, (r.trader_id = s.trader_id) as same_trader
        into v_rcv
        from trader_settlement_receivable_offsets x
        join trader_settlements s on s.id = x.settlement_id and s.company_id = x.company_id
        join trader_receivables r on r.id = x.receivable_id and r.company_id = x.company_id
       where x.company_id = v_company and x.settlement_id = any(v_ids);
      if v_rcv.id is null or v_rcv.receivable_number <> 'RCV-000132' or v_rcv.settlement_number <> 'SET-000278'
         or v_rcv.status <> 'collected' or v_rcv.amount_collected <> 20.00
         or v_rcv.amount_allocated <> 20.00 or not v_rcv.same_trader
         or exists (select 1 from trader_collection_allocations a
                     where a.company_id = v_company and a.receivable_id = v_rcv.id)
         or exists (select 1 from trader_settlement_receivable_offsets o
                     where o.company_id = v_company and o.receivable_id = v_rcv.id
                       and not (o.settlement_id = any(v_ids))) then
        raise exception 'RCV-000132 is not as found on 15 Nov (status %, collected %)',
          v_rcv.status, v_rcv.amount_collected;
      end if;

      -- 3. The five stuck idempotency records, still without a result.
      select count(*) into v_key_count from idempotency_records
       where company_id = v_company and operation = 'trader_settlements.create'
         and idempotency_key = any(v_keys) and resource_id is null and completed_at is null;
      if v_key_count <> 5 then
        raise exception 'expected 5 stuck submission records, found %', v_key_count;
      end if;

      -- Everything is as found. Clean up.
      update trader_receivables
         set amount_collected = 0, status = 'outstanding', updated_at = now()
       where company_id = v_company and id = v_rcv.id
         and status = 'collected' and amount_collected = 20.00;
      get diagnostics v_done = row_count;
      if v_done <> 1 then raise exception 'RCV-000132 changed during the cleanup'; end if;
      insert into audit_events (company_id, actor_account_id, action, subject_type, subject_id, reason,
                                before_data, after_data, correlation_id, source_application)
      values (v_company, null, 'trader_receivable.restore_after_failed_settlement', 'trader_receivable',
              v_rcv.id::text, v_reason,
              jsonb_build_object('receivableNumber', 'RCV-000132', 'status', 'collected',
                                 'amountCollected', '20.00', 'offsetBy', 'SET-000278'),
              jsonb_build_object('receivableNumber', 'RCV-000132', 'status', 'outstanding',
                                 'amountCollected', '0.00'),
              v_correlation, 'system');

      for v_set in
        select s.id, s.settlement_number, s.trader_id, s.net_payable, s.gross_payable, s.other_deductions,
               s.created_at, s.created_by_account_id,
               (select count(*) from trader_settlement_orders l
                 where l.company_id = s.company_id and l.settlement_id = s.id) as line_count,
               (select coalesce(jsonb_agg(o.order_number order by o.order_number), '[]'::jsonb)
                  from trader_settlement_orders l
                  join orders o on o.id = l.order_id and o.company_id = l.company_id
                 where l.company_id = s.company_id and l.settlement_id = s.id) as order_numbers
          from trader_settlements s
         where s.company_id = v_company and s.id = any(v_ids)
         order by s.settlement_number
      loop
        insert into audit_events (company_id, actor_account_id, action, subject_type, subject_id, reason,
                                  before_data, after_data, correlation_id, source_application)
        values (v_company, null, 'trader_settlement.remove_half_saved_draft', 'trader_settlement',
                v_set.id::text, v_reason,
                jsonb_build_object('settlementNumber', v_set.settlement_number, 'status', 'draft',
                                   'traderId', v_set.trader_id, 'grossPayable', v_set.gross_payable::text,
                                   'feeOffsets', v_set.other_deductions::text,
                                   'netPayable', v_set.net_payable::text, 'payments', 0,
                                   'orderLines', v_set.line_count, 'orderNumbers', v_set.order_numbers,
                                   'createdAt', v_set.created_at,
                                   'createdByAccountId', v_set.created_by_account_id),
                jsonb_build_object('removed', true),
                v_correlation, 'system');
      end loop;

      delete from trader_settlement_receivable_offsets
       where company_id = v_company and settlement_id = any(v_ids);
      delete from trader_settlement_orders
       where company_id = v_company and settlement_id = any(v_ids);
      delete from trader_settlements
       where company_id = v_company and id = any(v_ids) and status = 'draft';
      get diagnostics v_done = row_count;
      if v_done <> 5 then raise exception 'expected to remove 5 settlements, removed %', v_done; end if;

      delete from idempotency_records
       where company_id = v_company and operation = 'trader_settlements.create'
         and idempotency_key = any(v_keys) and resource_id is null and completed_at is null;

      raise notice 'Lahthza half-settlement cleanup: removed SET-000278..282 (44 lines, 1 fee offset), restored RCV-000132, cleared 5 stuck submissions';
    exception when others then
      -- Never block start-up: the whole cleanup is rolled back and nothing changes.
      raise warning 'Lahthza half-settlement cleanup skipped, nothing changed: %', sqlerrm;
    end
    $cleanup$;
  `.execute(database);
}

/** No down: the removed rows were never valid records. The audit lines keep what was removed. */
export async function down(): Promise<void> {}
