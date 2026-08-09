import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Earnings an Employee accrues per delivered Order.
 *
 * A flat amount per delivery, for Employees the Company explicitly enrols —
 * employee Drivers among them. Not a commission: it does not vary by Trader,
 * Area, COD collected, or any percentage, and there is no monthly ceiling.
 *
 * ---------------------------------------------------------------------------
 * WHY TWO TABLES
 * ---------------------------------------------------------------------------
 *
 * The RULE is what the Company decides and may change. The EARNING is what
 * actually happened to one Order, and must never change afterwards.
 *
 * Keeping them apart is what makes history stable: raising the rate in March
 * cannot silently restate February's payroll, because each earning carries the
 * amount that applied at the moment of delivery. Storing only the rule and
 * recomputing later would make every historical figure a function of today's
 * configuration — the same defect the effective-dated business-day rule exists
 * to avoid.
 *
 * ---------------------------------------------------------------------------
 * ELIGIBILITY IS OPT-IN
 * ---------------------------------------------------------------------------
 *
 * There is no global "all Employees earn per delivery" switch. An Employee
 * earns only while a rule row covers them, which makes enrolment, suspension
 * and rate history one auditable timeline rather than a flag plus a guess.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS PAID HERE
 * ---------------------------------------------------------------------------
 *
 * These tables record what was EARNED. Payment remains the existing cash-only
 * payroll flow, and no Accounting Event or Journal is raised by this migration
 * or by the accrual service. Employee bank details are deliberately absent.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table employee_delivery_earning_rules (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      employee_id uuid not null,

      -- Flat amount per delivered Order. A CHECK rather than a comment because
      -- a negative or zero per-delivery rate is never a business decision, it
      -- is a data-entry accident.
      amount_per_order numeric(18, 2) not null,

      -- Null means "every service type". A value narrows the rule to one, so a
      -- Company can pay a different rate for express work without needing a
      -- second concept.
      service_type text,

      -- Half-open period: effective from this date, up to but NOT including
      -- effective_to. Null effective_to means "still in force".
      effective_from date not null,
      effective_to date,

      is_active boolean not null default true,
      created_by_account_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version integer not null default 1,

      unique (id, company_id),

      constraint employee_delivery_earning_rules_employee_fk
        foreign key (employee_id, company_id)
        references employees(id, company_id) on delete restrict,
      constraint employee_delivery_earning_rules_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,

      constraint employee_delivery_earning_rules_amount_check
        check (amount_per_order > 0),
      constraint employee_delivery_earning_rules_period_order_check
        check (effective_to is null or effective_to > effective_from),

      -- One rate per Employee per service type at any instant. '[)' so adjacent
      -- periods touch without overlapping and without leaving a day uncovered.
      -- coalesce on service_type because NULL would otherwise never conflict
      -- with itself, letting two overlapping all-service rules coexist.
      constraint employee_delivery_earning_rules_no_overlap exclude using gist (
        company_id with =,
        employee_id with =,
        coalesce(service_type, '*') with =,
        daterange(effective_from, effective_to, '[)') with &&
      ) where (is_active)
    );

    create index employee_delivery_earning_rules_lookup_index
      on employee_delivery_earning_rules
         (company_id, employee_id, effective_from, effective_to)
      where is_active;

    comment on table employee_delivery_earning_rules is
      'Effective-dated flat per-delivery earning rates. Enrolment is opt-in: an Employee earns only while a rule row covers them.';

    create table employee_order_earnings (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      employee_id uuid not null,
      order_id uuid not null,
      rule_id uuid not null,

      -- Snapshot columns. Denormalised on purpose: an earning must remain
      -- readable and reconcilable even if the Order is later returned, the
      -- rate changes, or the rule is deactivated. These are a record of what
      -- happened, not a cache of what is currently true.
      order_number text not null,
      delivered_at timestamptz not null,
      applied_amount numeric(18, 2) not null,

      -- First day of the Company-local calendar month of the delivery. Computed
      -- in the service using the Company timezone, never in SQL: deriving it
      -- from a UTC timestamp would push deliveries before 04:00 Dubai into the
      -- previous month at every month boundary.
      earning_month date not null,

      created_at timestamptz not null default now(),

      unique (id, company_id),

      -- Idempotency. One Order yields at most one earning for a given Employee
      -- and rule, so a retried or replayed delivery cannot pay twice.
      unique (company_id, order_id, employee_id, rule_id),

      constraint employee_order_earnings_employee_fk
        foreign key (employee_id, company_id)
        references employees(id, company_id) on delete restrict,
      constraint employee_order_earnings_order_fk
        foreign key (order_id, company_id)
        references orders(id, company_id) on delete restrict,
      constraint employee_order_earnings_rule_fk
        foreign key (rule_id, company_id)
        references employee_delivery_earning_rules(id, company_id) on delete restrict,

      constraint employee_order_earnings_amount_check
        check (applied_amount > 0),
      constraint employee_order_earnings_month_check
        check (earning_month = date_trunc('month', earning_month)::date)
    );

    -- Payroll reads by Employee and month; this index matches that shape.
    create index employee_order_earnings_period_index
      on employee_order_earnings (company_id, employee_id, earning_month);

    -- Reconciling an Order back to its earning.
    create index employee_order_earnings_order_index
      on employee_order_earnings (company_id, order_id);

    comment on table employee_order_earnings is
      'What one delivered Order earned one Employee, with the rate and Order details snapshotted. Immutable history; payment is a separate, existing cash-only flow.';
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  // Earnings first: they reference the rules.
  await sql`
    drop table if exists employee_order_earnings;
    drop table if exists employee_delivery_earning_rules;
  `.execute(database);
}
