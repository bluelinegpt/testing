import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Make the Company's business day an explicit, effective-dated rule.
 *
 * A delivery Company does not stop at midnight. Cash collected at 02:00 belongs
 * to the previous working day, and every daily report the business actually
 * reads is built around that. Until now the system had no such concept: it
 * grouped by calendar date in `Asia/Dubai`, which splits one working night
 * across two report lines.
 *
 * The agreed rule is a day that starts at 08:00 local time and runs for exactly
 * 24 hours, so 04 Aug covers 04 Aug 08:00:00 through 05 Aug 07:59:59.999.
 *
 * ---------------------------------------------------------------------------
 * WHY A TABLE AND NOT TWO COLUMNS ON company_settings
 * ---------------------------------------------------------------------------
 *
 * Business Date is DERIVED from stored timestamps, not persisted on each row —
 * see the design note at the end. That keeps the schema small, but it has one
 * consequence that has to be handled rather than ignored: if the rule were a
 * single mutable setting, changing the start time from 08:00 to 06:00 would
 * silently re-group every report ever produced. Yesterday's signed-off Daily
 * Cash Report would print different numbers tomorrow.
 *
 * So the rule is effective-dated. A change opens a new period from a chosen
 * date; earlier timestamps keep resolving against the rule that was in force
 * when they happened. Historical reports stay reproducible without storing a
 * Business Date on every transaction.
 *
 * `company_settings.timezone` already exists and is NOT duplicated here as a
 * source of truth for the Company's current timezone. It is carried on each
 * period because the timezone is half of the rule: reading a 2026 timestamp
 * against a timezone adopted in 2028 would produce the same silent rewrite this
 * table exists to prevent.
 *
 * ---------------------------------------------------------------------------
 * NON-OVERLAP
 * ---------------------------------------------------------------------------
 *
 * Enforced by the database, using the same `exclude using gist` idiom as
 * `account_mappings` and `accounting_periods`. `btree_gist` is already enabled
 * by `20260717010000_trader_configuration`.
 *
 * The range is `[)` — half-open — matching how the windows themselves are
 * computed. A period ending 2026-09-01 and the next starting 2026-09-01 are
 * adjacent, not overlapping, and there is no gap between them.
 *
 * ---------------------------------------------------------------------------
 * SEEDING
 * ---------------------------------------------------------------------------
 *
 * One open-ended row per existing Company, carrying the agreed 08:00 default
 * and that Company's already-configured timezone. `effective_from` is
 * '-infinity' so every historical timestamp resolves rather than falling into a
 * hole before the first period.
 *
 * This does not change any stored value: it records, going forward, the rule
 * that reports were already implicitly using — with one deliberate difference,
 * which is that the day now starts at 08:00 rather than midnight. That is the
 * requested behaviour change, and it changes only how rows are GROUPED, never
 * what they contain. No transaction, Journal or Accounting Event is read or
 * written by this migration.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    create table company_business_day_configurations (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete cascade,

      -- IANA name. Validated in the application against the runtime's own
      -- timezone database; a CHECK here could only ever be a stale allowlist.
      timezone text not null,

      -- Local wall-clock time the business day begins. Stored as a time, not a
      -- string, so the database rejects '25:00' without help from anybody.
      business_day_start time not null default '08:00:00',

      -- Half-open period: effective from this date, up to but NOT including
      -- effective_to. Null effective_to means "still in force".
      effective_from date not null,
      effective_to date,

      change_reason text not null,
      is_active boolean not null default true,

      created_by_account_id uuid,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      version integer not null default 1,

      constraint company_business_day_creator_fk
        foreign key (created_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,

      -- A period that ends before it starts would silently match nothing.
      constraint company_business_day_period_order_check
        check (effective_to is null or effective_to > effective_from),

      constraint company_business_day_reason_check
        check (btrim(change_reason) <> ''),

      -- One rule per Company per instant. '[)' so adjacent periods touch
      -- without overlapping and without leaving a day unresolved.
      constraint company_business_day_no_overlap exclude using gist (
        company_id with =,
        daterange(effective_from, effective_to, '[)') with &&
      ) where (is_active)
    );

    create index company_business_day_effective_index
      on company_business_day_configurations (company_id, effective_from, effective_to)
      where is_active;

    comment on table company_business_day_configurations is
      'Effective-dated business-day rule. Business Date is derived from transaction timestamps using the period in force at that timestamp, never stored per transaction.';

    -- Seed the agreed default for every existing Company, reusing whatever
    -- timezone that Company already configured rather than assuming one.
    insert into company_business_day_configurations (
      company_id, timezone, business_day_start, effective_from, change_reason
    )
    select c.id,
           coalesce(s.timezone, 'Asia/Dubai'),
           '08:00:00'::time,
           '-infinity'::date,
           'Initial business-day rule adopted with the business-day feature'
      from companies c
      left join company_settings s on s.company_id = c.id;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`drop table if exists company_business_day_configurations;`.execute(database);
}
