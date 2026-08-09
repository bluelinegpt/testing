import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Employee Driver collection earnings: capture the fact, price it at Payroll.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT SHAPED LIKE DELIVERY EARNINGS
 * ---------------------------------------------------------------------------
 *
 * `employee_order_earnings` snapshots the MONEY at delivery, because delivery is
 * the moment the work is done and the rate is knowable. Collection is different:
 * confirming a Driver Collection is a cash-handling operation, and pricing it
 * there would put a compensation decision inside a reconciliation screen that
 * has no business making one.
 *
 * So the split is deliberate:
 *
 *   collection time -> WHAT HAPPENED   (this fact table, no amount anywhere)
 *   payroll time    -> WHAT IT IS WORTH (rule x fact, written to the payslip)
 *
 * That is why `employee_driver_collection_facts` has no amount column and never
 * will. If a reader ever wants to add one, the answer is that Payroll already
 * stores the result on `payroll_entries.collection_earnings`, and a second copy
 * would immediately be able to disagree with the first.
 *
 * ---------------------------------------------------------------------------
 * HISTORY STILL CANNOT BE REWRITTEN
 * ---------------------------------------------------------------------------
 *
 * Delivery earnings freeze the rate in the snapshot. Collection earnings cannot
 * do that -- there is no amount until Payroll runs -- so the guarantee comes
 * from the other end: once a fact is allocated to a Payroll period it is never
 * re-priced, because the allocation columns are what make it invisible to every
 * later calculation. A rate edited in September therefore cannot restate August,
 * for the same reason and with the same strength as the delivery model.
 *
 * The rate itself is resolved from `business_date`, the operational date of the
 * collection, mirroring how the delivery rule resolves from `delivered_at`
 * rather than from today.
 *
 * ---------------------------------------------------------------------------
 * NOTHING FINANCIAL HAPPENS HERE
 * ---------------------------------------------------------------------------
 *
 * No Accounting Event, no Journal, no cash movement, and no change to any
 * reconciliation total, COD figure or expense. The fact table hangs off the
 * reconciliation by foreign key; it does not alter it. Compensation reaches the
 * ledger only through the existing Payroll flow.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table employee_collection_earning_rules (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      employee_id uuid not null,

      -- 'none' exists as a real, dated row rather than as the absence of one, so
      -- "stopped earning on 1 September" is a fact with an author and a
      -- timestamp instead of a deletion nobody can account for.
      collection_payment_type text not null,

      -- Zero only for 'none'. A paid type with a zero rate is a data-entry
      -- accident, and the check below says so rather than leaving it to a form.
      amount numeric(18, 2) not null,

      -- Half-open, matching employee_delivery_earning_rules exactly: effective
      -- from this date, up to but NOT including effective_to.
      effective_from date not null,
      effective_to date,

      is_active boolean not null default true,
      created_by_account_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version integer not null default 1,

      unique (id, company_id),

      constraint employee_collection_earning_rules_employee_fk
        foreign key (employee_id, company_id)
        references employees(id, company_id) on delete restrict,
      constraint employee_collection_earning_rules_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,

      constraint employee_collection_earning_rules_type_check
        check (collection_payment_type in (
          'none', 'per_collected_order', 'flat_per_confirmed_collection'
        )),
      constraint employee_collection_earning_rules_amount_check
        check (
          (collection_payment_type = 'none' and amount = 0)
          or (collection_payment_type <> 'none' and amount > 0)
        ),
      constraint employee_collection_earning_rules_period_order_check
        check (effective_to is null or effective_to > effective_from),

      -- One collection rule per Employee at any instant. Unlike the delivery
      -- rule there is no service_type dimension: a collection is a cash
      -- hand-over, not a service class.
      constraint employee_collection_earning_rules_no_overlap exclude using gist (
        company_id with =,
        employee_id with =,
        daterange(effective_from, effective_to, '[)') with &&
      ) where (is_active)
    );

    create index employee_collection_earning_rules_lookup_index
      on employee_collection_earning_rules
         (company_id, employee_id, effective_from, effective_to)
      where is_active;

    comment on table employee_collection_earning_rules is
      'Effective-dated Employee Driver collection payment rules. Opt-in and non-overlapping, mirroring employee_delivery_earning_rules.';

    create table employee_driver_collection_facts (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,

      -- Both are kept. driver_id is who handed the cash over; employee_id is who
      -- gets paid. They are the same person today, but the Driver record is the
      -- reconciliation's own reference and the Employee record is Payroll's, and
      -- re-deriving either one later would depend on a link that may have moved.
      employee_id uuid not null,
      driver_id uuid not null,
      reconciliation_id uuid not null,

      -- Operational date of the collection. This is the date the rate resolves
      -- against, mirroring the delivery rule resolving against delivered_at.
      business_date date not null,
      confirmed_at timestamptz not null,

      -- The operator's decision, captured as given. A collection that does not
      -- count still records a fact, so "we decided this one does not count" is
      -- auditable rather than indistinguishable from "nobody looked".
      counts_for_collection_earning boolean not null,
      collected_order_count integer not null,

      -- Whether the count came from the reconciliation's own Order links or from
      -- a person. Payroll does not care, but anyone auditing a figure does.
      count_source text not null,

      created_by_account_id uuid not null,
      created_at timestamptz not null default now(),

      -- Paid-once, as a database fact. A single-valued column cannot name two
      -- periods, so no fact can be priced into two payrolls however the
      -- calculation is retried or raced. Identical guarantee to
      -- employee_order_earnings.payroll_period_id.
      payroll_period_id uuid,
      payroll_entry_id uuid,
      allocated_at timestamptz,

      unique (id, company_id),

      -- Idempotency. Confirming the same reconciliation twice cannot produce a
      -- second fact, and cannot count the same Orders again.
      unique (company_id, reconciliation_id, employee_id),

      constraint employee_driver_collection_facts_employee_fk
        foreign key (employee_id, company_id)
        references employees(id, company_id) on delete restrict,
      constraint employee_driver_collection_facts_driver_fk
        foreign key (driver_id, company_id)
        references drivers(id, company_id) on delete restrict,
      constraint employee_driver_collection_facts_reconciliation_fk
        foreign key (reconciliation_id, company_id)
        references driver_reconciliations(id, company_id) on delete restrict,
      constraint employee_driver_collection_facts_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint employee_driver_collection_facts_period_fk
        foreign key (payroll_period_id, company_id)
        references payroll_periods(id, company_id) on delete restrict,
      constraint employee_driver_collection_facts_entry_fk
        foreign key (payroll_entry_id, company_id)
        references payroll_entries(id, company_id) on delete restrict,

      constraint employee_driver_collection_facts_source_check
        check (count_source in ('auto_from_orders', 'manual')),
      -- A counting collection needs at least one Order; a non-counting one must
      -- not smuggle a number in.
      constraint employee_driver_collection_facts_count_check
        check (
          (counts_for_collection_earning and collected_order_count >= 1)
          or (not counts_for_collection_earning and collected_order_count = 0)
        ),
      -- Allocation is all-or-nothing: a period, an entry and a timestamp, or
      -- none of them. Half-allocated is not a state Payroll can reason about.
      constraint employee_driver_collection_facts_allocation_check
        check (
          (payroll_period_id is null and payroll_entry_id is null and allocated_at is null)
          or (payroll_period_id is not null and payroll_entry_id is not null
              and allocated_at is not null)
        )
    );

    -- Payroll reads unallocated facts for one Employee within a date window.
    create index employee_driver_collection_facts_payroll_index
      on employee_driver_collection_facts
         (company_id, employee_id, business_date)
      where counts_for_collection_earning and payroll_period_id is null;

    -- Reconciling a payslip line back to its collections.
    create index employee_driver_collection_facts_period_index
      on employee_driver_collection_facts (company_id, payroll_period_id)
      where payroll_period_id is not null;

    comment on table employee_driver_collection_facts is
      'What happened at a confirmed Driver Collection, for Payroll purposes only. Deliberately holds no monetary amount: the earning is priced by Payroll from the effective rule.';

    -- The Orders behind an auto count. A child table rather than a JSON list so
    -- the link is a real, indexable relationship and a deleted Order cannot
    -- silently rewrite history.
    create table employee_driver_collection_fact_orders (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      fact_id uuid not null,
      order_id uuid not null,
      order_number text not null,
      created_at timestamptz not null default now(),

      unique (id, company_id),
      -- One Order contributes to a fact once.
      unique (company_id, fact_id, order_id),

      constraint employee_driver_collection_fact_orders_fact_fk
        foreign key (fact_id, company_id)
        references employee_driver_collection_facts(id, company_id) on delete restrict,
      constraint employee_driver_collection_fact_orders_order_fk
        foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict
    );

    create index employee_driver_collection_fact_orders_order_index
      on employee_driver_collection_fact_orders (company_id, order_id);

    comment on table employee_driver_collection_fact_orders is
      'The Orders counted by one collection fact, when the count was derived from the reconciliation rather than entered by hand.';

    -- Default 0 so every existing entry keeps its current gross and net, and
    -- payroll_periods_totals_check continues to hold without a backfill: a zero
    -- component moves no total.
    alter table payroll_entries
      add column collection_earnings numeric(18, 2) not null default 0,
      add constraint payroll_entries_collection_earnings_check
        check (collection_earnings >= 0);

    alter table payroll_periods
      add column total_collection_earnings numeric(18, 2) not null default 0,
      add constraint payroll_periods_collection_earnings_check
        check (total_collection_earnings >= 0);

    comment on column payroll_entries.collection_earnings is
      'Priced from employee_driver_collection_facts using the effective collection rule. Its own payslip line, never folded into allowances.';
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table payroll_periods
      drop constraint if exists payroll_periods_collection_earnings_check,
      drop column if exists total_collection_earnings;
    alter table payroll_entries
      drop constraint if exists payroll_entries_collection_earnings_check,
      drop column if exists collection_earnings;
    drop table if exists employee_driver_collection_fact_orders;
    drop table if exists employee_driver_collection_facts;
    drop table if exists employee_collection_earning_rules;
  `.execute(database);
}
