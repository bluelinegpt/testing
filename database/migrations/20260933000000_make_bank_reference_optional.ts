/**
 * Make Bank Reference optional for bank transfer payments.
 *
 * Updates the check constraint on driver_reconciliation_payments to allow
 * bank_reference to be NULL for bank_transfer payments. The unique constraint
 * on bank_reference only applies when the value is NOT NULL, so NULL is safe.
 */
export async function up(sql: any) {
  // Drop existing check constraint that requires bank_reference for bank transfers
  await sql.raw(`
    ALTER TABLE driver_reconciliation_payments
    DROP CONSTRAINT IF EXISTS driver_reconciliation_payments_bank_check
  `);

  // Add new check constraint that allows NULL bank_reference for bank transfers
  await sql.raw(`
    ALTER TABLE driver_reconciliation_payments
    ADD CONSTRAINT driver_reconciliation_payments_bank_check CHECK (
      (payment_method = 'cash' AND company_bank_account_id IS NULL AND bank_reference IS NULL)
      OR (payment_method = 'bank_transfer' AND company_bank_account_id IS NOT NULL)
    )
  `);
}

export async function down(sql: any) {
  // Restore original check constraint
  await sql.raw(`
    ALTER TABLE driver_reconciliation_payments
    DROP CONSTRAINT IF EXISTS driver_reconciliation_payments_bank_check
  `);

  await sql.raw(`
    ALTER TABLE driver_reconciliation_payments
    ADD CONSTRAINT driver_reconciliation_payments_bank_check CHECK (
      (payment_method = 'cash' AND company_bank_account_id IS NULL AND bank_reference IS NULL)
      OR (payment_method = 'bank_transfer' AND company_bank_account_id IS NOT NULL AND bank_reference IS NOT NULL)
    )
  `);
}
