import { type Kysely, sql } from "kysely";

type MigrationDatabase = Record<string, never>;

/**
 * Register the two General Expense reference-number types.
 *
 * `company_reference_counters.reference_type` is a closed enum enforced by
 * `company_reference_counters_type_check`. The General Expenses feature
 * (`20260801130000_general_expenses_and_payments.ts`) added services that
 * reserve numbers as `general_expense` (prefix `EXP`) and
 * `general_expense_payment` (prefix `EXPPAY`), but never widened that check —
 * and the later `20260801140000_cash_bank_management.ts` rewrote the list
 * without them. Creating any General Expense therefore always failed on the
 * counter INSERT with a check violation (23514), surfacing to the User as the
 * generic "The operation conflicts with current data integrity rules".
 *
 * Additive and reversible: only the CHECK constraint is replaced, preserving
 * every value already permitted (and every counter row already stored — none
 * can violate the widened list, since it is a strict superset).
 */
const previousTypes = `
  'order','payment','reconciliation','settlement','journal','payroll','import',
  'trader','area','customer','driver','employee','trader_receivable',
  'trader_collection','payroll_payment','outsourced_driver_fee_payment',
  'accounting_opening_balance','cash_bank_movement'
`;

export async function up(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    alter table company_reference_counters
      drop constraint company_reference_counters_type_check,
      add constraint company_reference_counters_type_check check(reference_type in(
        ${sql.raw(previousTypes)},
        'general_expense','general_expense_payment'
      ));
  `.execute(database);
}

export async function down(database: Kysely<MigrationDatabase>): Promise<void> {
  await sql`
    delete from company_reference_counters
     where reference_type in ('general_expense','general_expense_payment');

    alter table company_reference_counters
      drop constraint company_reference_counters_type_check,
      add constraint company_reference_counters_type_check check(reference_type in(
        ${sql.raw(previousTypes)}
      ));
  `.execute(database);
}
