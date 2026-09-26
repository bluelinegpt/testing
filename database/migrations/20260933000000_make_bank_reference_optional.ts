import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Make Bank Reference optional for bank transfer payments.
 *
 * Updates the check constraint on driver_reconciliation_payments to allow
 * bank_reference to be NULL for bank_transfer payments. The unique constraint
 * on bank_reference only applies when the value is NOT NULL, so NULL is safe.
 */
export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table driver_reconciliation_payments
      drop constraint if exists driver_reconciliation_payments_bank_check;

    alter table driver_reconciliation_payments
      add constraint driver_reconciliation_payments_bank_check check (
        (payment_method = 'cash' and company_bank_account_id is null and bank_reference is null)
        or (payment_method = 'bank_transfer' and company_bank_account_id is not null)
      );
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table driver_reconciliation_payments
      drop constraint if exists driver_reconciliation_payments_bank_check;

    alter table driver_reconciliation_payments
      add constraint driver_reconciliation_payments_bank_check check (
        (payment_method = 'cash' and company_bank_account_id is null and bank_reference is null)
        or (payment_method = 'bank_transfer' and company_bank_account_id is not null and bank_reference is not null)
      );
  `.execute(database);
}
