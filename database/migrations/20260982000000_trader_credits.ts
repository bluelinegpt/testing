import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Trader Credits -- the first-class record of an amount the Company owes a
 * Trader, outside any Settlement.
 *
 * Why this table has to exist, in the words of the case that forced it.
 * `RCV-000047` (AED 18, ORD-000108) was settled by a receivable offset inside
 * `SET-000007`: the Company collected the fee by paying the Trader AED 18
 * LESS. To reverse that Receivable on its own, two things must happen
 * together -- the Receivable stops being owed, AND the Company takes on an
 * obligation for the AED 18 the Trader has already effectively paid. Restoring
 * only the Receivable leaves him owing it while already short-paid: down twice
 * the amount.
 *
 * None of the existing shapes can carry that obligation:
 *
 *   - `trader_settlements.adjustments` exists, but
 *     `validate_trader_settlement_confirmation()` raises on
 *     `new.adjustments <> 0`, so a confirmed Settlement can never hold one.
 *   - A `trader_receivables` row runs the wrong way: a Receivable is money the
 *     Trader owes the Company.
 *   - A physical `trader_collections` row would record cash that never moved.
 *   - A manual Journal moves the General Ledger without moving the Trader's
 *     operational balance, so the two then disagree.
 *
 * So a Credit is its own object, with its own number, lifecycle and provenance
 * back to whatever created it.
 *
 * `remaining_amount` is GENERATED, mirroring
 * `trader_receivables.outstanding_amount` -- including that column's trap,
 * found on 1 Oct 2026 and reproduced here in testing: a GENERATED balance goes
 * on reporting its full value for a row whose status has gone terminal, so a
 * `cancelled` Credit still reads `remaining_amount = 18.00`. EVERY sum over
 * this table MUST filter on `status`. The partial unique index below takes the
 * same care.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    -- 'trader_credit' joins the reference types by READING the live
    -- constraint -- its column name included -- and extending it, never by
    -- restating the list.
    --
    -- Two drafts of this block were wrong before this one, and both would have
    -- done real damage. The first hardcoded a ten-value list that did not
    -- exist; the real constraint holds 'order', 'payment', 'reconciliation',
    -- 'settlement', 'journal', 'payroll', 'import', 'trader_receivable',
    -- 'trader_collection'. The second hardcoded the column as counter_type;
    -- it is reference_type. Either would have dropped legitimate reference
    -- types and broken numbering for several entities.
    --
    -- Postgres renders the predicate two ways and both are parsed below: an
    -- IN list comes back as ARRAY['a'::text, ...], while the
    -- "= any (%L::text[])" this block itself writes comes back as
    -- '{a,b,c}'::text[]. Reading only the first form made a re-run raise and
    -- left the matching down() a silent no-op.
    do $mig$
    declare
      existing text;
      values_found text[];
      array_literal text;
      column_name text;
    begin
      select pg_get_constraintdef(oid) into existing
        from pg_constraint
       where conrelid = 'company_reference_counters'::regclass
         and conname = 'company_reference_counters_type_check';
      if existing is null then
        raise exception 'company_reference_counters_type_check is missing';
      end if;
      -- The column the constraint actually guards, read rather than assumed.
      column_name := split_part(split_part(existing, '(', 3), ' ', 1);
      if column_name is null then
        raise exception 'could not read the guarded column from %', existing;
      end if;
      select array_agg(m[1] order by m[1]) into values_found
        from regexp_matches(existing, '''([a-z_]+)''::text', 'g') as m;
      if values_found is null or array_length(values_found, 1) = 0 then
        array_literal := (regexp_match(existing, '''(\\{[^}]*\\})''::text\\[\\]'))[1];
        if array_literal is null then
          raise exception 'could not read the existing reference types from %', existing;
        end if;
        select array_agg(t order by t) into values_found
          from unnest(string_to_array(btrim(array_literal, '{}'), ',')) as t;
      end if;
      -- Decided on the parsed values, not on text position: the array-literal
      -- rendering '{...,trader_credit}' contains no quoted value to find.
      if 'trader_credit' = any (values_found) then
        return;
      end if;
      -- array_append, not the || operator: an untyped literal on the right of
      -- text[] || parses as an array literal and fails with "malformed array
      -- literal".
      values_found := array_append(values_found, 'trader_credit');
      execute 'alter table company_reference_counters
                 drop constraint company_reference_counters_type_check';
      execute format(
        'alter table company_reference_counters
           add constraint company_reference_counters_type_check
           check (%I = any (%L::text[]))',
        column_name, values_found
      );
    end
    $mig$;

    create table trader_credits (
      id uuid not null default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      credit_number text not null,
      trader_id uuid not null,
      business_date date not null,
      amount numeric(18,2) not null,
      amount_applied numeric(18,2) not null default 0,
      remaining_amount numeric(18,2)
        generated always as (amount - amount_applied) stored,
      status text not null default 'open',
      reason text not null,
      source_type text not null,
      source_receivable_id uuid,
      source_order_id uuid,
      source_settlement_id uuid,
      correlation_id text,
      created_by_account_id uuid not null references accounts(id) on delete restrict,
      cancelled_at timestamptz,
      cancelled_by_account_id uuid references accounts(id) on delete restrict,
      cancelled_reason text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (id),
      constraint trader_credits_id_company_unique unique (id, company_id),
      -- Composite FKs, matching the pattern
      -- trader_settlement_receivable_offsets uses: the tenant travels with
      -- the key, so a Credit can never point at another Company's Trader,
      -- Receivable or Settlement.
      constraint trader_credits_trader_fk
        foreign key (trader_id, company_id)
        references traders(id, company_id) on delete restrict,
      constraint trader_credits_receivable_fk
        foreign key (source_receivable_id, company_id)
        references trader_receivables(id, company_id) on delete restrict,
      constraint trader_credits_settlement_fk
        foreign key (source_settlement_id, company_id)
        references trader_settlements(id, company_id) on delete restrict,
      constraint trader_credits_status_check check (
        status in ('open', 'partially_applied', 'applied', 'cancelled')
      ),
      constraint trader_credits_source_type_check check (
        source_type in ('receivable_offset_reversal', 'manual_adjustment')
      ),
      constraint trader_credits_amounts_check check (
        amount > 0 and amount_applied >= 0 and amount_applied <= amount
      ),
      constraint trader_credits_reason_nonempty check (btrim(reason) <> ''),
      -- A Credit compensating a reversed offset must name what it
      -- compensates. Without this, a reversal could write a Credit with no
      -- provenance and nothing downstream could tell it from a manual
      -- adjustment.
      constraint trader_credits_reversal_provenance check (
        source_type <> 'receivable_offset_reversal'
        or (source_receivable_id is not null
            and source_order_id is not null
            and source_settlement_id is not null)
      ),
      -- Cancellation is evidence, not a flag: an actor and a reason, or
      -- neither.
      constraint trader_credits_cancellation_complete check (
        (status = 'cancelled') =
        (cancelled_at is not null and cancelled_by_account_id is not null
         and cancelled_reason is not null and btrim(cancelled_reason) <> '')
      ),
      -- The status can never disagree with the money.
      constraint trader_credits_status_matches_amounts check (
        (status = 'open' and amount_applied = 0)
        or (status = 'partially_applied' and amount_applied > 0 and amount_applied < amount)
        or (status = 'applied' and amount_applied = amount)
        or status = 'cancelled'
      )
    );

    create unique index trader_credits_number_unique
      on trader_credits (company_id, credit_number);
    create index trader_credits_trader_index
      on trader_credits (company_id, trader_id, status);
    create index trader_credits_receivable_index
      on trader_credits (company_id, source_receivable_id);

    -- THE idempotency guarantee, enforced by the database rather than trusted
    -- to application logic: a Receivable carries at most ONE live
    -- compensating Credit. A retried reversal cannot double-credit the Trader
    -- even if the service's own guard is wrong, or a concurrent request slips
    -- past it. 'cancelled' is excluded so a mistaken Credit can be cancelled
    -- and reissued.
    create unique index trader_credits_one_live_per_receivable
      on trader_credits (company_id, source_receivable_id)
     where source_type = 'receivable_offset_reversal' and status <> 'cancelled';
  `.execute(database);
  await sql`
    -- Both renderings of the predicate are parsed, exactly as for
    -- company_reference_counters above: an IN list comes back as
    -- ARRAY['a'::text, ...], while the "= any (%L::text[])" this block (and
    -- down()) writes comes back as '{a,b}'::text[]. Reading only the first
    -- form made every re-run after a down() raise.
    do $mig$
    declare
      existing text;
      values_found text[];
      array_literal text;
      column_name text;
    begin
      select pg_get_constraintdef(oid) into existing
        from pg_constraint
       where conrelid = 'accounting_events'::regclass
         and conname = 'accounting_events_type_check';
      if existing is null then
        raise exception 'accounting_events_type_check is missing';
      end if;
      column_name := split_part(split_part(existing, '(', 3), ' ', 1);
      select array_agg(m[1] order by m[1]) into values_found
        from regexp_matches(existing, '''([a-z_]+)''::text', 'g') as m;
      if values_found is null or array_length(values_found, 1) = 0 then
        array_literal := (regexp_match(existing, '''(\\{[^}]*\\})''::text\\[\\]'))[1];
        if array_literal is null then
          raise exception 'could not read existing accounting event types from %', existing;
        end if;
        select array_agg(t order by t) into values_found
          from unnest(string_to_array(btrim(array_literal, '{}'), ',')) as t;
      end if;
      if 'trader_credit_issued' = any (values_found) then
        return;
      end if;
      values_found := array_append(values_found, 'trader_credit_issued');
      execute 'alter table accounting_events drop constraint accounting_events_type_check';
      execute format(
        'alter table accounting_events add constraint accounting_events_type_check check (%I = any (%L::text[]))',
        column_name, values_found
      );
    end
    $mig$;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  // Narrow accounting_events_type_check back by removing ONLY
  // 'trader_credit_issued' from whatever the live list has become -- the same
  // read-and-extend approach up() uses, in reverse. If any trader_credit_issued
  // Event exists the narrowed constraint is violated and this raises, which is
  // the correct outcome: those rows are accounting history and a rollback must
  // not discard them silently.
  //
  // up() rewrites the constraint as "= any ('{...}'::text[])", so both
  // renderings are parsed here. Backslashes are doubled because this SQL lives
  // in a JavaScript template literal, where a single backslash before an
  // ordinary character is silently dropped.
  await sql`
    do $mig$
    declare
      existing text;
      values_found text[];
      array_literal text;
      column_name text;
    begin
      select pg_get_constraintdef(oid) into existing
        from pg_constraint
       where conrelid = 'accounting_events'::regclass
         and conname = 'accounting_events_type_check';
      if existing is null then
        return;
      end if;
      column_name := split_part(split_part(existing, '(', 3), ' ', 1);
      select array_agg(m[1] order by m[1]) into values_found
        from regexp_matches(existing, '''([a-z_]+)''::text', 'g') as m;
      if values_found is null or array_length(values_found, 1) = 0 then
        array_literal := (regexp_match(existing, '''(\\{[^}]*\\})''::text\\[\\]'))[1];
        if array_literal is null then
          raise exception 'could not read existing accounting event types from %', existing;
        end if;
        select array_agg(t order by t) into values_found
          from unnest(string_to_array(btrim(array_literal, '{}'), ',')) as t;
      end if;
      if not ('trader_credit_issued' = any (values_found)) then
        return;
      end if;
      select array_agg(t order by t) into values_found
        from unnest(values_found) as t where t <> 'trader_credit_issued';
      execute 'alter table accounting_events drop constraint accounting_events_type_check';
      execute format(
        'alter table accounting_events add constraint accounting_events_type_check check (%I = any (%L::text[]))',
        column_name, values_found
      );
    end
    $mig$;
  `.execute(database);
  await sql`
    drop table if exists trader_credits;
    -- Symmetrical with up(): strip 'credit' out of whatever the list has
    -- become rather than restating it.
    do $mig$
    declare
      existing text;
      values_found text[];
      array_literal text;
      column_name text;
    begin
      select pg_get_constraintdef(oid) into existing
        from pg_constraint
       where conrelid = 'company_reference_counters'::regclass
         and conname = 'company_reference_counters_type_check';
      if existing is null then
        return;
      end if;
      -- Same column and dual-form reads as up(), for the same reasons.
      column_name := split_part(split_part(existing, '(', 3), ' ', 1);
      if column_name is null then
        return;
      end if;
      select array_agg(m[1] order by m[1]) into values_found
        from regexp_matches(existing, '''([a-z_]+)''::text', 'g') as m;
      if values_found is null or array_length(values_found, 1) = 0 then
        array_literal := (regexp_match(existing, '''(\\{[^}]*\\})''::text\\[\\]'))[1];
        if array_literal is null then
          return;
        end if;
        select array_agg(t order by t) into values_found
          from unnest(string_to_array(btrim(array_literal, '{}'), ',')) as t;
      end if;
      if not ('trader_credit' = any (values_found)) then
        return;
      end if;
      -- The counter rows have to go before the constraint narrows, or this
      -- block fails with "is violated by some row" the moment any Company has
      -- allocated a single Credit number -- which is to say, always after real
      -- use. The trader_credits table has just been dropped above, so these
      -- rows are dead data by this point.
      execute format(
        'delete from company_reference_counters where %I = %L', column_name, 'trader_credit'
      );
      select array_agg(t order by t) into values_found
        from unnest(values_found) as t where t <> 'trader_credit';
      execute 'alter table company_reference_counters
                 drop constraint company_reference_counters_type_check';
      execute format(
        'alter table company_reference_counters
           add constraint company_reference_counters_type_check
           check (%I = any (%L::text[]))',
        column_name, values_found
      );
    end
    $mig$;
  `.execute(database);
}
