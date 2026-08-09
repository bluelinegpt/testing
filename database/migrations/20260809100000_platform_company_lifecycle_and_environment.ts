import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Company lifecycle, environment and Accounting-setup tracking.
 *
 * Phase 1, Prompt 3 of the Platform Administration Portal. Everything here is
 * additive; no column is dropped and no existing value is reinterpreted.
 *
 * ---------------------------------------------------------------------------
 * 1. ENVIRONMENT — FAIL-SAFE MEANS PRODUCTION
 * ---------------------------------------------------------------------------
 *
 * A future Company reset will refuse to run against a production Company. That
 * makes this column a safety property, not a label, and it dictates every
 * decision below.
 *
 * The default is `production` and the column is NOT NULL, so a row created by
 * code that predates this migration, or by a future code path that forgets to
 * set it, is protected rather than exposed. There is no `unknown` value: an
 * unset environment that merely *looked* unclassified would be the one state a
 * reset guard could get wrong.
 *
 * The backfill sets every existing Company to `production` and then reclassifies
 * exactly one row — the verified development Company — by matching THREE
 * independent signals at once: the `DEV-` code prefix, the `dev` subdomain, and
 * the specific identifier that was verified by inspection before this migration
 * was written. A `DEV-` prefix alone is evidence, not proof, and reclassifying
 * on evidence alone is how a production Company would eventually be marked
 * resettable. In any other database — production, CI, a fresh developer clone —
 * that UPDATE matches nothing and every Company stays `production`, which is
 * the correct outcome.
 *
 * ---------------------------------------------------------------------------
 * 2. LIFECYCLE — TWO NEW STATES, NOT FOUR
 * ---------------------------------------------------------------------------
 *
 * `active` and `disabled` already exist and authentication already reads them,
 * so both keep their exact meaning. `draft` and `suspended` are added because
 * the onboarding flow genuinely needs them: a Company exists before it is
 * usable, and a Company can be stopped without being closed.
 *
 * No `closed` state is added. `disabled` already serves that purpose and a
 * fifth state would multiply the transition matrix for no behaviour anyone has
 * asked for.
 *
 * The default moves from `disabled` to `draft`. A newly inserted Company is not
 * a closed Company; it is one that has not been set up yet, and conflating the
 * two would make "why is this Company disabled?" unanswerable.
 *
 * ---------------------------------------------------------------------------
 * 3. ACCOUNTING SETUP TRACKING
 * ---------------------------------------------------------------------------
 *
 * Which template initialised a Company, at which version, and against which
 * canonical hash. The hash is what makes the record meaningful later: template
 * v1 could in principle be regenerated, and knowing the version alone would not
 * tell anyone which bytes were actually applied.
 *
 * `accounting_setup_status` is deliberately separate from row counts. A Company
 * with some Chart of Accounts rows and no mappings is not "partly ready" — it
 * is `failed`, and only a completed, validated import writes `ready`.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table companies
      add column environment text not null default 'production',
      add column country_code char(2) not null default 'AE',
      add column status_changed_at timestamptz,
      add column status_changed_by_account_id uuid references accounts(id) on delete restrict,
      add column status_change_reason text,
      add column suspended_at timestamptz,
      add column accounting_setup_status text not null default 'not_configured',
      add column accounting_template_code text,
      add column accounting_template_version integer,
      add column accounting_template_sha256 text,
      add column accounting_setup_applied_at timestamptz,
      add column accounting_setup_applied_by_account_id uuid references accounts(id) on delete restrict;

    alter table companies
      add constraint companies_environment_check check (
        environment in ('development', 'demo', 'sandbox', 'trial', 'production')
      ),
      add constraint companies_country_code_format check (country_code ~ '^[A-Z]{2}$'),
      add constraint companies_accounting_setup_status_check check (
        accounting_setup_status in ('not_configured', 'applying', 'ready', 'failed')
      ),
      add constraint companies_accounting_template_sha_format check (
        accounting_template_sha256 is null or accounting_template_sha256 ~ '^[0-9a-f]{64}$'
      ),
      -- A Company that claims a template must say which one, at which version,
      -- against which bytes. Half a provenance record is worse than none.
      add constraint companies_accounting_template_complete check (
        (accounting_template_code is null
          and accounting_template_version is null
          and accounting_template_sha256 is null
          and accounting_setup_applied_at is null)
        or (accounting_template_code is not null
          and accounting_template_version is not null
          and accounting_template_sha256 is not null
          and accounting_setup_applied_at is not null)
      ),
      add constraint companies_accounting_ready_requires_template check (
        accounting_setup_status <> 'ready' or accounting_template_code is not null
      );

    alter table companies drop constraint companies_status_check;
    alter table companies add constraint companies_status_check check (
      status in ('draft', 'active', 'suspended', 'disabled')
    );
    alter table companies alter column status set default 'draft';

    -- Fail-safe first: everything is production until proven otherwise.
    update companies set environment = 'production';

    -- Then the one verified exception. Three signals must agree, and the
    -- identifier was confirmed by direct inspection before this was written.
    -- Matches nothing in any other database.
    update companies
       set environment = 'development'
     where id = 'dd28829b-2b7c-4851-a0be-181b92673e84'::uuid
       and code like 'DEV-%'
       and lower(btrim(subdomain)) = 'dev';

    create index companies_status_environment_index on companies (status, environment);

    -- ---------------------------------------------------------------------
    -- A Platform-created row has no Company-scoped creator
    -- ---------------------------------------------------------------------
    --
    -- Every created_by_account_id in the Accounting setup tables is a COMPOSITE
    -- foreign key to accounts(id, company_id). That is correct for rows a
    -- Company user creates, and it makes a Platform Administrator structurally
    -- ineligible: a Platform account has company_id = null, so the pair can
    -- never match.
    --
    -- Most of those columns are already nullable, so onboarding simply leaves
    -- them empty and the Platform audit trail records who acted. Two are NOT
    -- NULL and would therefore make Platform onboarding impossible for rows the
    -- approved template must create. Neither is read as a required value
    -- anywhere: the createdBy segregation checks operate on cash_bank_movements
    -- and general_expenses, which are transactions, not these setup tables.
    alter table company_cash_accounts alter column created_by_account_id drop not null;
    alter table general_expense_categories alter column created_by_account_id drop not null;
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop index if exists companies_status_environment_index;

    -- Only restorable when no Platform-created row left the column empty.
    update company_cash_accounts set created_by_account_id = null where false;
    alter table company_cash_accounts alter column created_by_account_id set not null;
    alter table general_expense_categories alter column created_by_account_id set not null;

    -- Reverting the state set would orphan any Company left in a state the old
    -- constraint forbids, so those rows are folded back onto the closest
    -- pre-existing meaning before the constraint is narrowed.
    update companies set status = 'disabled' where status in ('draft', 'suspended');

    alter table companies drop constraint if exists companies_status_check;
    alter table companies add constraint companies_status_check check (
      status in ('active', 'disabled')
    );
    alter table companies alter column status set default 'disabled';

    alter table companies
      drop constraint if exists companies_environment_check,
      drop constraint if exists companies_country_code_format,
      drop constraint if exists companies_accounting_setup_status_check,
      drop constraint if exists companies_accounting_template_sha_format,
      drop constraint if exists companies_accounting_template_complete,
      drop constraint if exists companies_accounting_ready_requires_template;

    alter table companies
      drop column if exists accounting_setup_applied_by_account_id,
      drop column if exists accounting_setup_applied_at,
      drop column if exists accounting_template_sha256,
      drop column if exists accounting_template_version,
      drop column if exists accounting_template_code,
      drop column if exists accounting_setup_status,
      drop column if exists suspended_at,
      drop column if exists status_change_reason,
      drop column if exists status_changed_by_account_id,
      drop column if exists status_changed_at,
      drop column if exists country_code,
      drop column if exists environment;
  `.execute(database);
}
