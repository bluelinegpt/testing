import { Kysely, sql } from "kysely";

/**
 * CRITICAL FIX: Actually add company_cash_account_id columns
 *
 * The previous migrations (20260929, 20260930) were no-ops because the
 * columns were already expected to exist but don't. This migration
 * properly adds them with safe IF NOT EXISTS checks.
 */
export async function up(db: Kysely<any>): Promise<void> {
  // Add company_cash_account_id to driver_reconciliation_payments
  await sql`
    alter table driver_reconciliation_payments
    add column if not exists company_cash_account_id uuid
  `.execute(db);

  // Add foreign key constraint if it doesn't exist
  await sql`
    alter table driver_reconciliation_payments
    add constraint driver_reconciliation_payments_cash_fk
    foreign key (company_cash_account_id, company_id)
    references company_cash_accounts(id, company_id) on delete restrict
  `.execute(db).catch(() => {
    // Constraint might already exist, ignore
  });

  // Add company_cash_account_id to trader_settlement_payments
  await sql`
    alter table trader_settlement_payments
    add column if not exists company_cash_account_id uuid
  `.execute(db);

  // Add foreign key constraint if it doesn't exist
  await sql`
    alter table trader_settlement_payments
    add constraint trader_settlement_payments_cash_fk
    foreign key (company_cash_account_id, company_id)
    references company_cash_accounts(id, company_id) on delete restrict
  `.execute(db).catch(() => {
    // Constraint might already exist, ignore
  });
}

export async function down(db: Kysely<any>): Promise<void> {
  // Revert trader_settlement_payments
  await sql`
    alter table trader_settlement_payments
    drop constraint if exists trader_settlement_payments_cash_fk
  `.execute(db).catch(() => {});

  await sql`
    alter table trader_settlement_payments
    drop column if exists company_cash_account_id
  `.execute(db).catch(() => {});

  // Revert driver_reconciliation_payments
  await sql`
    alter table driver_reconciliation_payments
    drop constraint if exists driver_reconciliation_payments_cash_fk
  `.execute(db).catch(() => {});

  await sql`
    alter table driver_reconciliation_payments
    drop column if exists company_cash_account_id
  `.execute(db).catch(() => {});
}
