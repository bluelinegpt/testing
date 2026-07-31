import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table chart_of_accounts
      drop constraint chart_of_accounts_control_check,
      add constraint chart_of_accounts_control_check check (
        (not is_control_account and control_account_type is null)
        or (
          is_control_account
          and is_posting_account
          and control_account_type in (
            'trader_payable','driver_payable','payroll_payable',
            'accounts_receivable','accounts_payable','vat'
          )
        )
      );

    alter table accounting_configurations
      add column manual_accounting_activation_date date,
      add column manual_accounting_enabled_by_account_id uuid,
      add column manual_accounting_enabled_at timestamptz,
      add constraint accounting_configurations_manual_activation_actor_fk
        foreign key (manual_accounting_enabled_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict;

    create table accounting_zero_opening_confirmations (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete restrict,
      effective_date date not null,
      fiscal_year_id uuid not null,
      fiscal_period_id uuid not null,
      confirmation_statement text not null,
      reason text not null,
      administrator_acknowledged boolean not null,
      confirmed_by_account_id uuid not null,
      confirmed_at timestamptz not null default now(),
      revoked_by_account_id uuid,
      revoked_at timestamptz,
      revocation_reason text,
      version bigint not null default 1,
      constraint accounting_zero_opening_company_year_fk
        foreign key (fiscal_year_id, company_id)
        references fiscal_years(id, company_id) on delete restrict,
      constraint accounting_zero_opening_company_period_fk
        foreign key (fiscal_period_id, company_id)
        references accounting_periods(id, company_id) on delete restrict,
      constraint accounting_zero_opening_confirmer_fk
        foreign key (confirmed_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint accounting_zero_opening_revoker_fk
        foreign key (revoked_by_account_id, company_id)
        references accounts(id, company_id) on delete restrict,
      constraint accounting_zero_opening_acknowledged
        check (administrator_acknowledged),
      constraint accounting_zero_opening_reason_present
        check (length(btrim(reason)) > 0),
      constraint accounting_zero_opening_revocation_complete check (
        (revoked_at is null and revoked_by_account_id is null and revocation_reason is null)
        or
        (revoked_at is not null and revoked_by_account_id is not null
          and length(btrim(revocation_reason)) > 0)
      ),
      constraint accounting_zero_opening_version_positive check (version > 0)
    );

    create unique index accounting_zero_opening_one_active_company
      on accounting_zero_opening_confirmations(company_id)
      where revoked_at is null;
    create index accounting_zero_opening_context
      on accounting_zero_opening_confirmations(
        company_id, effective_date, fiscal_year_id, fiscal_period_id
      );
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    drop table if exists accounting_zero_opening_confirmations;
    alter table accounting_configurations
      drop constraint if exists accounting_configurations_manual_activation_actor_fk,
      drop column if exists manual_accounting_enabled_at,
      drop column if exists manual_accounting_enabled_by_account_id,
      drop column if exists manual_accounting_activation_date;
    alter table chart_of_accounts
      drop constraint chart_of_accounts_control_check,
      add constraint chart_of_accounts_control_check check (
        (not is_control_account and control_account_type is null)
        or (
          is_control_account
          and is_posting_account
          and control_account_type in (
            'trader_payable','driver_payable','payroll_payable',
            'accounts_receivable','vat'
          )
        )
      );
  `.execute(database);
}
