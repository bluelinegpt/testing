import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Permit `cash_bank_management` as a Journal source type.
 *
 * `OperationalSourceLoader.cashBankMovement()` returns
 * `journalSource: 'cash_bank_management'`, and
 * `OperationalJournalPostingService.process()` writes that value straight into
 * `journal_entries.source_type`. The application enum
 * (`accountingJournalSources`) has always declared the value, but
 * `journal_entries_source_check` was never widened to match — so EVERY Cash and
 * Bank Movement Accounting Event failed on the Journal header INSERT with
 * `23514 / journal_entries_source_check`, surfacing to the User as the generic
 * "The Accounting values did not satisfy a financial integrity rule".
 *
 * Confirmed against CBM-000001 (cash_to_bank_transfer, AED 1,000): the
 * components, GL resolution, balance and Fiscal Period were all correct, and
 * `source_type='cash_bank_management'` was the only rejected value while
 * `source_type='bank_transfer'` was accepted.
 *
 * `cash_bank_management` is the ONLY member of `accountingJournalSources`
 * missing from the constraint; every other loader emits a value the constraint
 * already permits, which is why only this area was affected.
 *
 * Additive and reversible: the permitted list is a strict superset of the
 * previous one, so no stored row can violate it and no data is rewritten. The
 * five legacy values the application no longer emits (`reconciliation`,
 * `settlement`, `expense`, `payroll`, `reversal`) are deliberately preserved —
 * removing them is a separate decision and would risk historical rows.
 */

/** Exactly the values permitted before this migration, in their stored order. */
const previousSources = `
  'manual','opening_balance','order','trader_receivable','trader_settlement',
  'driver_collection','driver_expense','employee_payroll','outsourced_driver_fee',
  'general_expense','bank_transfer','period_close','system',
  'reconciliation','settlement','expense','payroll','reversal'
`;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table journal_entries
      drop constraint journal_entries_source_check,
      add constraint journal_entries_source_check check (source_type in (
        ${sql.raw(previousSources)},
        'cash_bank_management'
      ));
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  // Restores the previous constraint exactly. Any Journal already posted under
  // the new value would block this rollback, which is the correct behaviour:
  // silently deleting posted financial records to satisfy a schema rollback is
  // never acceptable. Reverse those Journals first if a rollback is genuinely
  // required.
  await sql`
    alter table journal_entries
      drop constraint journal_entries_source_check,
      add constraint journal_entries_source_check check (source_type in (
        ${sql.raw(previousSources)}
      ));
  `.execute(database);
}
